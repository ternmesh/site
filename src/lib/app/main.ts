// The page at /app: a companion client for a Tern node, in the browser. It draws what a Client
// holds and turns clicks into requests; the protocol is in ../companion.
//
// Everything a node sends is untrusted text from the air, so nothing here is ever set as HTML:
// every string goes in as a text node.

import { Client, Refused } from "../companion/client.ts";
import type { Message, Transport } from "../companion/client.ts";
import { openDemo } from "../companion/demo.ts";
import { parseAddress, routingId, routingIdText } from "../companion/ids.ts";
import { ASKED, NAME_MAX, STATE, TEXT_MAX } from "../companion/protocol.ts";
import { bluetoothSupported, openBluetooth } from "../companion/bluetooth.ts";
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
/** Whether the link carries the board's console: only USB does. */
let hasConsole = false;
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

/** Whether a conversation's key is a group's id, 16 hex digits, and not an address, which is 64. */
function isGroup(key: string): boolean {
    return key.length === 16;
}

function nameOf(key: string): string {
    if (isGroup(key)) {
        const g = client?.groups.get(key);
        return g && g.name !== "" ? g.name : `Group ${key.slice(0, 8)}`;
    }
    const c = client?.contacts.get(key);
    return c && c.name !== "" ? c.name : short(key);
}

/** Who a routing id is, as far as the page can tell: a name it knows by that id, or the id. */
function writer(id: number): string {
    const who = [...ids].find(([, known]) => known === id)?.[0];
    return who ? nameOf(who) : routingIdText(id);
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
    return talks().filter((key) => !isGroup(key));
}

/** Every group the node holds, or the page has kept something of, most recent first. */
function groups(): string[] {
    const held = [...(client?.groups.keys() ?? [])];
    return [...new Set([...talks().filter(isGroup), ...held])];
}

/** Every conversation there is something to show for, most recent first. */
function talks(): string[] {
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
    if (c.version < 1) {
        box.append(
            el(
                "p",
                { class: "muted facts" },
                "This firmware is older than the page: it cannot end a session from here, or say who asked to reach it. ",
                el("a", { href: "/flash" }, "Update it"),
                ".",
            ),
        );
    }
}

/** What the settings form was last filled from: it is filled again only when the node's change. */
let settingsShown = "";

function drawSettings(): void {
    const self = client?.self;
    if (!self) {
        return;
    }
    const key = `${self.region}/${self.power}/${self.role}`;
    if (key === settingsShown) {
        return;
    }
    settingsShown = key;
    $<HTMLInputElement>("set-power").value = String(self.power);
    $<HTMLSelectElement>("set-role").value = String(self.role);
    const region = $<HTMLSelectElement>("set-region");
    region.querySelector("option[data-other]")?.remove();
    if (![...region.options].some((o) => o.value === self.region)) {
        // One this page does not offer, or none: shown as it is, and left alone unless changed.
        const other = el("option", { value: self.region, "data-other": "" }, self.region || "not set");
        region.prepend(other);
    }
    region.value = self.region;
}

function drawAsked(): void {
    const list = $("asked");
    list.replaceChildren();
    for (const [address, why] of client?.asked ?? []) {
        const known = client?.contacts.has(address) ?? false;
        const dismiss = el("button", { type: "button", class: "small" }, "Dismiss");
        dismiss.addEventListener("click", () => client?.forgetAsked(address));
        const who = el("code", {}, known ? nameOf(address) : address);
        if (why === ASKED.notContact && !known) {
            const letIn = el("button", { type: "button", class: "small" }, "Let it in");
            letIn.addEventListener("click", () => {
                const c = client;
                c?.saveContact(address, "").then(
                    () => {
                        c.forgetAsked(address);
                        say("Saved as a contact. It is let in the next time it tries: have it send again.");
                        select(address);
                    },
                    (e: unknown) => say(explain(e), true),
                );
            });
            list.append(
                el(
                    "li",
                    {},
                    el("p", {}, who, " tried to reach this node, and was refused: it is not a contact."),
                    el("p", { class: "actions" }, letIn, dismiss),
                ),
            );
        } else if (why === ASKED.notContact) {
            // Saved since it asked: nothing more to do but wait for it.
            list.append(
                el(
                    "li",
                    {},
                    el("p", {}, who, " was refused before it was a contact. It is let in the next time it tries."),
                    el("p", { class: "actions" }, dismiss),
                ),
            );
        } else {
            list.append(
                el(
                    "li",
                    {},
                    el(
                        "p",
                        {},
                        who,
                        why === ASKED.noRoom
                            ? " tried to reach this node, and was refused: the node holds as many sessions as it can. End one to make room."
                            : " tried to reach this node, and was refused.",
                    ),
                    el("p", { class: "actions" }, dismiss),
                ),
            );
        }
    }
}

function drawPeople(): void {
    const list = $("people");
    list.replaceChildren();
    const all = people();
    if (all.length === 0) {
        list.append(el("li", { class: "muted empty" }, "Nobody yet. Add someone by their address, below."));
    }
    for (const address of all) {
        const session = client?.contacts.get(address)?.session;
        list.append(
            el(
                "li",
                {},
                talkButton(
                    address,
                    session && el("span", { class: "muted session", title: "This node has a session with it" }, "●"),
                ),
            ),
        );
    }
}

/** A conversation in a list: its name, how many of its messages are unread, and a mark. */
function talkButton(key: string, mark: Child): HTMLButtonElement {
    const unread = liveWith(key).filter((m) => m.state === STATE.received && !m.read).length;
    const button = el(
        "button",
        { type: "button", class: key === selected ? "person on" : "person" },
        el("span", { class: "name" }, nameOf(key)),
        unread > 0 && el("span", { class: "badge" }, String(unread)),
        mark,
    );
    button.addEventListener("click", () => select(key));
    return button;
}

function drawGroups(): void {
    const able = (client?.version ?? 0) >= 2;
    $("groups-old").hidden = able || demo;
    $("groups-demo").hidden = !demo;
    $("group-add").hidden = !able;
    const list = $("groups");
    list.replaceChildren();
    const all = groups();
    if (all.length === 0 && able) {
        list.append(el("li", { class: "muted empty" }, "None yet. Make one below, or be invited to one."));
    }
    for (const id of all) {
        const held = client?.groups.has(id);
        list.append(
            el(
                "li",
                {},
                talkButton(id, !held && el("span", { class: "muted session", title: "This node has left it" }, "left")),
            ),
        );
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

function bubble(m: {
    incoming: boolean;
    text: string;
    time: number;
    note: string;
    failed?: boolean;
    who?: string;
    action?: Child;
}): HTMLElement {
    return el(
        "li",
        { class: m.incoming ? "in" : m.failed ? "out failed" : "out" },
        m.who !== undefined && el("p", { class: "who" }, m.who),
        el("p", { class: "text" }, m.text),
        el("p", { class: "meta" }, [when(m.time), m.note].filter((x) => x !== "").join(" · ")),
        m.action,
    );
}

/**
 * A message as the page shows it. A group message received says who its frame gave as its writer;
 * an invite says what it is, and one received to a group not held can be taken.
 */
function shown(m: {
    incoming: boolean;
    text: string;
    time: number;
    state: number;
    reason?: number;
    wait?: number;
    from?: number;
    invite?: boolean;
    group?: string;
    id?: number;
}): HTMLElement {
    let text = m.text;
    let action: Child = null;
    if (m.invite) {
        const name = m.text === "" ? "a group" : `the group “${m.text}”`;
        text = m.incoming ? `Invited you to ${name}.` : `You invited them to ${name}.`;
        const id = m.id;
        if (m.incoming && id !== undefined && m.group && client && !client.groups.has(m.group)) {
            const join = el("button", { type: "button", class: "small" }, "Join");
            const group = m.group;
            join.addEventListener("click", () => {
                client?.join(id).then(
                    () => {
                        say("");
                        select(group);
                    },
                    (e: unknown) => say(explain(e), true),
                );
            });
            action = el("p", { class: "actions" }, join);
        }
    }
    return bubble({
        incoming: m.incoming,
        text,
        time: m.time,
        note: m.incoming ? "" : stateText(m),
        failed: m.state === STATE.notDelivered,
        ...(m.incoming && m.from ? { who: writer(m.from) } : {}),
        action,
    });
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
    if (isGroup(address)) {
        groupHead(address);
    } else {
        personHead(address);
    }
    drawMessages(address);
}

/** The head of a group's conversation: what it is, what to know of it, and what can be done. */
function groupHead(id: string): void {
    const head = $("talk-head");
    const held = client?.groups.get(id);
    if (!held) {
        head.append(
            el("h2", {}, nameOf(id)),
            el("p", { class: "muted" }, "This node is not in this group now. What was said is kept in this browser."),
        );
        return;
    }
    const rename = el("button", { type: "button", class: "small" }, "Rename");
    rename.addEventListener("click", () => {
        const name = window.prompt("A name for this group, kept on the node and not sent:", held.name);
        if (name !== null) {
            act(() => client!.nameGroup(id, clip(name.trim(), NAME_MAX)));
        }
    });
    const leave = el("button", { type: "button", class: "small" }, "Leave");
    leave.addEventListener("click", () => {
        const sure = window.confirm(
            `Leave ${nameOf(id)}? This node forgets the group's secret and can no longer read it. ` +
                "The others are not told, and only an invite brings it back.",
        );
        if (sure) {
            act(() => client!.leaveGroup(id));
        }
    });
    // Whom to invite: a contact, since an invite goes over a session with one.
    const whom = el("select", { "aria-label": "A contact to invite" });
    for (const c of client?.contacts.values() ?? []) {
        whom.append(el("option", { value: c.address }, nameOf(c.address)));
    }
    const invite = el("button", { type: "button", class: "small" }, "Invite");
    invite.addEventListener("click", () => {
        const to = whom.value;
        if (to !== "") {
            client?.invite(id, to).then(
                () => say(`Invited ${nameOf(to)}. Their conversation shows when it arrives.`),
                (e: unknown) => say(explain(e), true),
            );
        }
    });
    head.append(
        el("h2", {}, nameOf(id)),
        el(
            "p",
            { class: "muted" },
            "Everyone in a group holds the same key. Any of them can write under another's name, " +
                "whoever is given the key can read all that was said, and nobody can be put out. " +
                "Nothing says a message arrived.",
        ),
        el("p", { class: "actions" }, rename, leave, whom.options.length > 0 && whom, whom.options.length > 0 && invite),
    );
}

function personHead(address: string): void {
    const head = $("talk-head");
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
    const end =
        contact?.session &&
        client &&
        client.version >= 1 &&
        el("button", { type: "button", class: "small" }, "End session");
    if (end) {
        end.addEventListener("click", () => {
            const sure = window.confirm(
                `End this node's session with ${nameOf(address)}? Messages still waiting for it are given up. ` +
                    "The other node is not told: to talk again, send it a message from here.",
            );
            if (sure) {
                act(() => client!.endSession(address));
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
                : "No session yet: the first message makes first contact, directly or through relays.",
        ),
        el("p", { class: "actions" }, rename, remove ?? null, end || null),
    );
}

function drawMessages(address: string): void {
    const list = $<HTMLOListElement>("messages");
    const compose = $<HTMLFormElement>("compose");
    const live = liveWith(address);
    const earlier: Kept[] = history?.earlier(address, live) ?? [];
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(
        // An invite kept from before is not one to take: the node no longer holds it.
        ...earlier.map((k) => shown(k)),
        ...live.map((m) => shown({ ...m, incoming: m.state === STATE.received })),
    );
    if (earlier.length + live.length === 0) {
        list.append(el("li", { class: "muted empty" }, "Nothing said yet."));
    }
    if (atBottom) {
        list.scrollTop = list.scrollHeight;
    }
    // A group this node has left cannot be written to.
    compose.hidden = isGroup(address) && !client?.groups.has(address);

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
        $("console").hidden = !up || !hasConsole;
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
        drawSettings();
        drawAsked();
        drawPeople();
        drawGroups();
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

const CHOOSE = {
    serial: "Choose the board's port in the browser's list.",
    bluetooth: "Choose the node in the browser's list. The first time, type in the passkey its screen shows.",
    demo: "",
};

async function connect(open: () => Promise<Transport> | Transport, by: keyof typeof CHOOSE): Promise<void> {
    say(CHOOSE[by]);
    let transport: Transport;
    try {
        transport = await open();
    } catch (e) {
        // Closing the browser's list without choosing is not an error worth a red line.
        say(e instanceof DOMException && e.name === "NotFoundError" ? "" : explain(e), true);
        return;
    }
    demo = by === "demo";
    hasConsole = by === "serial";
    selected = null;
    history = null;
    historyNode = "";
    ids.clear();
    settingsShown = "";
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
    const failed = await bringUp(c);
    if (failed === null) {
        say("");
        draw();
        return;
    }
    if (!c.closed) {
        say(`${explain(failed)} Is this a Tern node? Flash the firmware first.`, true);
    }
    await c.close();
    draw();
}

/**
 * HELLO and a sync, tried for a while: a board that has just restarted, as one does when its port
 * is opened or a setting is applied, takes a few seconds to answer. Null once it is up, or else
 * why it is not.
 */
async function bringUp(c: Client): Promise<unknown> {
    let why: unknown = new Error("The connection closed.");
    for (let tries = 0; tries < 6 && !c.closed; tries++) {
        try {
            await c.start();
            return null;
        } catch (e) {
            why = e;
            if (e instanceof Refused && e.code !== 0) {
                break;
            }
        }
    }
    return why;
}

/**
 * Applies the settings that differ from the node's, one at a time: the region first, since what
 * power is allowed depends on it. A node restarts to apply each, so each is followed by starting
 * the connection again.
 */
async function applySettings(c: Client): Promise<void> {
    const self = c.self;
    if (!self) {
        return;
    }
    const region = $<HTMLSelectElement>("set-region").value;
    const power = Number($<HTMLInputElement>("set-power").value);
    const role = Number($<HTMLSelectElement>("set-role").value);
    const changes: [setting: "region" | "power" | "role", value: number | string][] = [];
    if (region !== self.region) {
        changes.push(["region", region]);
    }
    if (power !== self.power) {
        changes.push(["power", power]);
    }
    if (role !== self.role) {
        changes.push(["role", role]);
    }
    if (changes.length === 0) {
        say("Nothing to change.");
        return;
    }
    // Nothing else is asked of a board that is about to restart: a request it took just before
    // would be lost with it, and one it never answered would hold up the HELLO after.
    const live = $("live");
    live.inert = true;
    live.classList.add("busy");
    try {
        for (const [setting, value] of changes) {
            await c.set(setting, value);
            say("Applied. Waiting for the board to restart…");
            // It restarts a moment after it answers: a HELLO sent before then would be answered
            // by the board that is about to go.
            await new Promise((r) => setTimeout(r, demo ? 0 : 1500));
            const failed = await bringUp(c);
            if (failed !== null) {
                throw failed;
            }
        }
        say("Applied.");
    } catch (e) {
        if (e instanceof Refused && e.code !== 0) {
            say(explain(e), true); // refused, and still there
        } else {
            // It did not come back: the page goes back to where a board is connected from.
            await c.close();
            if (client === c) {
                client = null;
            }
            say(`${explain(e)} The board did not come back after the change: connect to it again.`, true);
        }
    } finally {
        live.inert = false;
        live.classList.remove("busy");
        // Whatever the node now has is what the form shows.
        settingsShown = "";
        draw();
    }
}

function start(): void {
    const serialButton = $<HTMLButtonElement>("connect-serial");
    const bluetoothButton = $<HTMLButtonElement>("connect-bluetooth");
    serialButton.disabled = !serialSupported();
    bluetoothButton.disabled = !bluetoothSupported();
    // A phone has Bluetooth and no serial port: what the browser has comes first.
    (serialButton.disabled && !bluetoothButton.disabled ? bluetoothButton : serialButton).classList.add("primary");
    $("unsupported").hidden = !serialButton.disabled && !bluetoothButton.disabled;
    $("unsupported").textContent =
        serialButton.disabled && bluetoothButton.disabled
            ? "This browser can reach a node neither over USB nor over Bluetooth. Chrome and Edge can, on a computer or an Android phone; Safari, Firefox and iPhones cannot yet."
            : serialButton.disabled
              ? "This browser cannot reach a USB serial port: Chrome and Edge on a computer can."
              : "This browser has no Web Bluetooth: Chrome and Edge can, on a computer or an Android phone.";
    serialButton.addEventListener("click", () => void connect(openSerial, "serial"));
    bluetoothButton.addEventListener("click", () => void connect(() => openBluetooth(), "bluetooth"));
    $("connect-demo").addEventListener("click", () => void connect(openDemo, "demo"));
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
        act(() => (isGroup(to) ? client!.sendGroup(to, words) : client!.send(to, words)));
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

    $<HTMLFormElement>("group-add").addEventListener("submit", (e) => {
        e.preventDefault();
        const name = clip($<HTMLInputElement>("group-name").value.trim(), NAME_MAX);
        client?.makeGroup(name).then(
            (id) => {
                $<HTMLFormElement>("group-add").reset();
                say("Made. Invite someone to it from its page.");
                select(id);
            },
            (err: unknown) => say(explain(err), true),
        );
    });

    $<HTMLFormElement>("settings-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (client) {
            void applySettings(client);
        }
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
        void connect(openDemo, "demo");
    }
}

start();
