// The page at /app: a companion client for a Tern node, in the browser. It draws what a Client
// holds and turns clicks into requests; the protocol is in ../companion.
//
// Everything a node sends is untrusted text from the air, so nothing here is ever set as HTML:
// every string goes in as a text node.

import { Client, Refused } from "../companion/client.ts";
import type { Message, Transport } from "../companion/client.ts";
import { openDemo } from "../companion/demo.ts";
import { parseAddress, routingId, routingIdText } from "../companion/ids.ts";
import { NAME_MAX, STATE, TEXT_MAX } from "../companion/protocol.ts";
import { openSerial, serialSupported } from "../companion/serial.ts";
import { History } from "./history.ts";
import type { Kept } from "./history.ts";

const $ = <T extends HTMLElement>(id: string): T => {
    const e = document.getElementById(id);
    if (!e) {
        throw new Error(`the page has no #${id}`);
    }
    return e as T;
};

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        e.setAttribute(k, v);
    }
    for (const c of children) {
        if (c) {
            e.append(c);
        }
    }
    return e;
}

const REASONS = [
    "waiting",
    "waiting for a route",
    "making first contact",
    "waiting for the region's limit",
    "waiting for its share of the air",
    "waiting for the radio",
];

let client: Client | null = null;
let history: History | null = null;
let selected: string | null = null;
let demo = false;
let drawing = false;
/** A READ is on its way: another is not sent until it is answered. */
let reading = false;
/** Routing ids of the addresses the page knows, to put names to neighbours. */
const ids = new Map<string, number>();

function local(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function say(text: string, bad = false): void {
    const status = $("status");
    status.textContent = text;
    status.classList.toggle("bad", bad);
}

function explain(e: unknown): string {
    if (e instanceof Refused) {
        return e.code === 0 ? `No answer: ${e.message}.` : `Refused: ${e.message}.`;
    }
    return e instanceof Error ? e.message : String(e);
}

function short(address: string): string {
    return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

function nameOf(address: string): string {
    const c = client?.contacts.get(address);
    return c && c.name !== "" ? c.name : short(address);
}

function when(time: number): string {
    if (time === 0) {
        return "";
    }
    const d = new Date(time * 1000);
    const today = new Date().toDateString() === d.toDateString();
    return today
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function stateText(m: { state: number; reason?: number; wait?: number }): string {
    switch (m.state) {
        case STATE.waiting: {
            const why = REASONS[m.reason ?? 0] ?? "waiting";
            return m.wait ? `${why}, about ${m.wait} s` : why;
        }
        case STATE.sent:
            return "sent";
        case STATE.delivered:
            return "delivered";
        case STATE.notDelivered:
            return "not delivered";
        default:
            return "";
    }
}

function liveWith(address: string): Message[] {
    return [...(client?.messages.values() ?? [])].filter((m) => m.contact === address).sort((a, b) => a.id - b.id);
}

/** Every address there is something to show for, most recent first. */
function people(): string[] {
    const last = new Map<string, number>();
    const seen = (address: string, at: number) => last.set(address, Math.max(last.get(address) ?? 0, at));
    for (const c of client?.contacts.keys() ?? []) {
        seen(c, 0);
    }
    for (const k of history?.kept ?? []) {
        seen(k.contact, k.time);
    }
    for (const m of client?.messages.values() ?? []) {
        seen(m.contact, m.time || Number.MAX_SAFE_INTEGER / 2 + m.id);
    }
    return [...last.keys()].sort((a, b) => last.get(b)! - last.get(a)! || nameOf(a).localeCompare(nameOf(b)));
}

function drawNode(): void {
    const c = client!;
    const box = $("node");
    box.replaceChildren();
    if (!c.self) {
        return;
    }
    const address = c.self.address;
    const copy = el("button", { type: "button", class: "small" }, "Copy");
    copy.addEventListener("click", () => {
        navigator.clipboard.writeText(address).then(
            () => say("Address copied. Give it to whoever should write to this node."),
            () => say("The browser would not copy it: select the address and copy it by hand.", true),
        );
    });
    const facts = [
        c.self.region || "no region set",
        `${c.self.power} dBm`,
        c.self.role === 1 ? "relay" : "leaf",
        c.power && c.power.percent !== 255 ? `battery ${c.power.percent}%` : null,
        c.airtime && c.airtime.period > 0
            ? `${Math.round(c.airtime.used / 1000)} of ${Math.round(c.airtime.allowed / 1000)} s on the air`
            : null,
    ].filter((x): x is string => x !== null);
    box.append(
        el("h2", {}, demo ? "A demo node" : "This node"),
        el("p", { class: "address" }, el("code", {}, address), copy),
        el("p", { class: "muted facts" }, facts.join(" · ")),
        el("p", { class: "muted facts" }, c.firmware),
    );
}

function drawPeople(): void {
    const list = $("people");
    list.replaceChildren();
    const all = people();
    if (all.length === 0) {
        list.append(el("li", { class: "muted empty" }, "Nobody yet. Add someone by their address, below."));
    }
    for (const address of all) {
        const live = liveWith(address);
        const unread = live.filter((m) => m.state === STATE.received && !m.read).length;
        const session = client?.contacts.get(address)?.session;
        const button = el(
            "button",
            { type: "button", class: address === selected ? "person on" : "person" },
            el("span", { class: "name" }, nameOf(address)),
            unread > 0 && el("span", { class: "badge" }, String(unread)),
            session && el("span", { class: "muted session", title: "This node has a session with it" }, "●"),
        );
        button.addEventListener("click", () => select(address));
        list.append(el("li", {}, button));
    }
}

function drawNeighbours(): void {
    const list = $("neighbours");
    list.replaceChildren();
    const all = [...(client?.neighbours.values() ?? [])].sort((a, b) => b.snrDb - a.snrDb);
    if (all.length === 0) {
        list.append(el("li", { class: "muted empty" }, "None heard yet."));
    }
    for (const n of all) {
        const who = [...ids].find(([, id]) => id === n.routingId)?.[0];
        const ago = Math.max(0, Math.round((Date.now() - n.heardAt) / 1000));
        list.append(
            el(
                "li",
                {},
                el("span", { class: "name" }, who ? nameOf(who) : routingIdText(n.routingId)),
                el(
                    "span",
                    { class: "muted" },
                    ` ${n.role === 1 ? "relay" : "leaf"}, ${n.snrDb.toFixed(1)} dB, ${ago < 90 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago`,
                ),
            ),
        );
    }
}

function bubble(m: { incoming: boolean; text: string; time: number; note: string; failed?: boolean }): HTMLElement {
    return el(
        "li",
        { class: m.incoming ? "in" : m.failed ? "out failed" : "out" },
        el("p", { class: "text" }, m.text),
        el("p", { class: "meta" }, [when(m.time), m.note].filter((x) => x !== "").join(" · ")),
    );
}

function drawTalk(): void {
    const head = $("talk-head");
    const list = $<HTMLOListElement>("messages");
    const compose = $<HTMLFormElement>("compose");
    head.replaceChildren();
    if (!selected) {
        list.replaceChildren(
            el("li", { class: "muted empty" }, "Choose someone on the left, or add them by their address."),
        );
        compose.hidden = true;
        return;
    }
    const address = selected;
    const contact = client?.contacts.get(address);
    const rename = el("button", { type: "button", class: "small" }, contact ? "Rename" : "Save as a contact");
    rename.addEventListener("click", () => {
        const name = window.prompt("A name for this address, kept on the node:", contact?.name ?? "");
        if (name !== null) {
            act(() => client!.saveContact(address, clip(name.trim(), NAME_MAX)));
        }
    });
    const remove = contact && el("button", { type: "button", class: "small" }, "Remove");
    if (remove) {
        remove.addEventListener("click", () => {
            if (window.confirm(`Remove ${nameOf(address)} from this node's contacts? Its messages are kept.`)) {
                act(() => client!.removeContact(address));
            }
        });
    }
    head.append(
        el("h2", {}, nameOf(address)),
        el("p", { class: "muted address" }, el("code", {}, address)),
        el(
            "p",
            { class: "muted" },
            contact?.session
                ? "This node has a session with it."
                : "No session yet: the first message makes first contact, which needs the two nodes to hear each other.",
        ),
        el("p", { class: "actions" }, rename, remove ?? null),
    );

    const live = liveWith(address);
    const earlier: Kept[] = history?.earlier(address, live) ?? [];
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(
        ...earlier.map((k) =>
            bubble({
                incoming: k.incoming,
                text: k.text,
                time: k.time,
                note: k.incoming ? "" : stateText(k),
                failed: k.state === STATE.notDelivered,
            }),
        ),
        ...live.map((m) =>
            bubble({
                incoming: m.state === STATE.received,
                text: m.text,
                time: m.time,
                note: stateText(m),
                failed: m.state === STATE.notDelivered,
            }),
        ),
    );
    if (earlier.length + live.length === 0) {
        list.append(el("li", { class: "muted empty" }, "Nothing said yet."));
    }
    if (atBottom) {
        list.scrollTop = list.scrollHeight;
    }
    compose.hidden = false;

    // Seen, since it is on the screen: the node is told, and says so to every client, this one
    // included, which is when the badge goes. Not marked here: a request that fails would
    // otherwise leave them read on this page and unread everywhere else, and never asked again.
    const unread = live.filter((m) => m.state === STATE.received && !m.read);
    if (unread.length > 0 && !reading && document.visibilityState === "visible") {
        reading = true;
        const asked = client;
        asked
            ?.read(Math.max(...unread.map((m) => m.id)))
            .catch(() => {})
            .finally(() => {
                reading = false;
                // Tried again in a while if it failed, and at once for any that came meanwhile.
                setTimeout(draw, asked.closed ? 0 : 3000);
            });
    }
}

function draw(): void {
    if (drawing) {
        return;
    }
    drawing = true;
    requestAnimationFrame(() => {
        drawing = false;
        const up = client !== null && !client.closed;
        $("gate").hidden = up;
        $("live").hidden = !up || !client?.ready;
        $("demo-note").hidden = !up || !demo;
        $("console").hidden = !up || demo;
        if (!up || !client?.ready) {
            return;
        }
        if (client.self && (!history || !historyFor(client.self.address))) {
            history = new History(client.self.address, demo ? null : local());
            historyNode = client.self.address;
        }
        history?.absorb(client.messages.values());
        learnIds();
        drawNode();
        drawPeople();
        drawNeighbours();
        drawTalk();
    });
}

let historyNode = "";
function historyFor(node: string): boolean {
    return historyNode === node;
}

/** Works out, once each, the routing ids of the addresses on the page. */
function learnIds(): void {
    for (const address of people()) {
        if (!ids.has(address)) {
            ids.set(address, 0);
            routingId(address).then(
                (id) => {
                    ids.set(address, id);
                    draw();
                },
                () => {},
            );
        }
    }
}

function clip(text: string, bytes: number): string {
    const enc = new TextEncoder();
    let out = text;
    while (enc.encode(out).length > bytes) {
        out = [...out].slice(0, -1).join("");
    }
    return out;
}

function select(address: string): void {
    selected = address;
    draw();
    $<HTMLInputElement>("text").focus();
}

/** Runs a request, and says so if the node refuses it or does not answer. */
function act(what: () => Promise<unknown>): void {
    what().then(
        () => say(""),
        (e: unknown) => say(explain(e), true),
    );
}

async function connect(open: () => Promise<Transport> | Transport, isDemo: boolean): Promise<void> {
    say(isDemo ? "" : "Choose the board's port in the browser's list.");
    let transport: Transport;
    try {
        transport = await open();
    } catch (e) {
        // Closing the browser's list without choosing is not an error worth a red line.
        say(e instanceof DOMException && e.name === "NotFoundError" ? "" : explain(e), true);
        return;
    }
    demo = isDemo;
    selected = null;
    history = null;
    historyNode = "";
    ids.clear();
    $("console-text").textContent = "";
    const c = new Client(transport);
    client = c;
    c.onChange = draw;
    c.onConsole = (text) => {
        const pre = $("console-text");
        pre.textContent = ((pre.textContent ?? "") + text.replace(/\r/g, "")).slice(-20000);
        pre.scrollTop = pre.scrollHeight;
    };
    c.onClosed = (why) => {
        say(`Disconnected: ${why}.`, true);
        draw();
    };
    say("Connecting…");
    draw();
    // A board that restarts when its port is opened takes a few seconds to answer.
    for (let tries = 0; tries < 6 && !c.closed; tries++) {
        try {
            await c.start();
            say("");
            draw();
            return;
        } catch (e) {
            if (tries === 5 || (e instanceof Refused && e.code !== 0)) {
                say(`${explain(e)} Is this a Tern node? Flash the firmware first.`, true);
            }
        }
    }
    await c.close();
    draw();
}

function start(): void {
    const serialButton = $<HTMLButtonElement>("connect-serial");
    if (!serialSupported()) {
        serialButton.disabled = true;
        $("unsupported").hidden = false;
    }
    serialButton.addEventListener("click", () => void connect(openSerial, false));
    $("connect-demo").addEventListener("click", () => void connect(openDemo, true));
    $("disconnect").addEventListener("click", () => {
        const c = client;
        client = null;
        void c?.close();
        say("");
        draw();
    });

    const text = $<HTMLInputElement>("text");
    const counter = $("counter");
    const count = () => {
        const used = new TextEncoder().encode(text.value).length;
        counter.textContent = `${used} / ${TEXT_MAX}`;
        counter.classList.toggle("bad", used > TEXT_MAX);
        return used;
    };
    text.addEventListener("input", count);
    $<HTMLFormElement>("compose").addEventListener("submit", (e) => {
        e.preventDefault();
        const to = selected;
        const words = text.value.trim();
        if (!client || !to || words === "") {
            return;
        }
        if (count() > TEXT_MAX) {
            say(`Too long: a message is at most ${TEXT_MAX} bytes.`, true);
            return;
        }
        text.value = "";
        count();
        act(() => client!.send(to, words));
    });

    $<HTMLFormElement>("add").addEventListener("submit", (e) => {
        e.preventDefault();
        const address = parseAddress($<HTMLInputElement>("add-address").value);
        const name = clip($<HTMLInputElement>("add-name").value.trim(), NAME_MAX);
        if (!address) {
            say("An address is 64 hex digits: the other node's page, or its 'status', shows it.", true);
            return;
        }
        if (!client) {
            return;
        }
        client.saveContact(address, name).then(
            () => {
                $<HTMLFormElement>("add").reset();
                say("");
                select(address);
            },
            (err: unknown) => say(explain(err), true),
        );
    });

    $<HTMLFormElement>("console-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const line = $<HTMLInputElement>("console-line");
        act(() => client?.type(line.value) ?? Promise.resolve());
        line.value = "";
    });

    document.addEventListener("visibilitychange", draw);
    setInterval(() => client?.ready && drawNeighbours(), 15000);
    count();
    if (new URLSearchParams(location.search).has("demo")) {
        void connect(openDemo, true);
    }
}

start();
