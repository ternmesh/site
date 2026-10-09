// The page at /app: a companion client for a Tern node, in the browser. It draws what a Client
// holds and turns clicks into requests; the protocol is in ../companion.
//
// Everything a node sends is untrusted text from the air, so nothing here is ever set as HTML:
// every string goes in as a text node.

import { Client, Refused } from "../companion/client.ts";
import type { Message, Position, Sharing, Transport } from "../companion/client.ts";
import { openDemo } from "../companion/demo.ts";
import { parseAddress, routingId, routingIdText } from "../companion/ids.ts";
import { ASKED, NAME_MAX, STATE, TEXT_MAX } from "../companion/protocol.ts";
import { fetchImage, offerFor } from "../companion/release.ts";
import { readJoinCode, shortCode } from "../companion/share.ts";
import { linkSegments, qrEncode, qrPath } from "../qr.ts";
import { Updater } from "../companion/updater.ts";
import type { ManifestImage } from "../flash/images.ts";
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
/** A group's join code the user asked to see, while it is shown: in memory, and nowhere else. */
let shownCode: { group: string; link: string } | null = null;
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
        el("p", { class: "muted facts" }, [c.firmware, c.board].filter((x) => x !== "").join(" · ")),
    );
    // What the firmware's version leaves out, newest first, so the list says what an update brings.
    const missing = [
        [7, "share a group by its join code, or join from one"],
        [6, "show who is about"],
        [5, "share positions"],
        [4, "be updated from here"],
        [2, "make or join groups"],
        [1, "end a session, or say who asked to reach it"],
    ]
        .filter(([v]) => c.version < Number(v))
        .map(([, what]) => String(what));
    if (missing.length > 0) {
        box.append(
            el(
                "p",
                { class: "muted facts" },
                `This firmware is older than the page, and cannot ${listed(missing)}. `,
                el("a", { href: "/flash" }, "Update it over USB"),
                ".",
            ),
        );
    }
}

/** "a, b and c". */
function listed(items: string[]): string {
    return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
        const card = client?.cards.get(address);
        // The address in an ASKED is proved, and a card from it is signed by it: its name can be
        // shown, as what it says of itself.
        const who = el(
            "span",
            {},
            el("code", {}, known ? nameOf(address) : address),
            !known && card && card.name !== "" ? ` (its card says “${card.name}”)` : "",
        );
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
    $("group-join").hidden = !client?.can("JOIN_LINK");
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

/** Short codes worked out so far, by address: what two people compare to know it is the same node. */
const codes = new Map<string, string>();
function codeOf(address: string): string {
    const known = codes.get(address);
    if (known !== undefined) {
        return known;
    }
    codes.set(address, "");
    shortCode(address).then(
        (code) => {
            codes.set(address, code);
            draw();
        },
        () => {},
    );
    return "";
}

function ago(at: number): string {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 90) {
        return `${s} s ago`;
    }
    if (s < 90 * 60) {
        return `${Math.round(s / 60)} min ago`;
    }
    if (s < 36 * 3600) {
        return `${Math.round(s / 3600)} h ago`;
    }
    return `${Math.round(s / 86400)} days ago`;
}

/** The five precisions the specification asks a client to offer, by what each covers. */
const PRECISIONS: [precision: number, word: string, size: string][] = [
    [8, "Region", "about 150 km"],
    [12, "Town", "about 10 km"],
    [16, "Neighbourhood", "about 600 m"],
    [20, "Street", "about 40 m"],
    [24, "Exact", "a few metres"],
];

/** How far a cell of `precision` is, north to south. */
function cellSize(precision: number): string {
    const named = PRECISIONS.find(([p]) => p === precision);
    if (named) {
        return named[2];
    }
    const metres = (360 / 2 ** precision) * 111_000;
    return metres >= 1000 ? `about ${Math.round(metres / 1000)} km` : metres >= 10 ? `about ${Math.round(metres)} m` : "a few metres";
}

function sharingText(s: Sharing): string {
    const word = PRECISIONS.find(([p]) => p === s.precision)?.[1] ?? `within ${cellSize(s.precision)}`;
    if (s.endsAt === 0) {
        return `${word}, until you stop`;
    }
    const left = Math.max(1, Math.ceil((s.endsAt - Date.now()) / 60000));
    return `${word}, ${left < 120 ? `${left} min` : `${Math.round(left / 60)} h`} left`;
}

/** A link that opens a position on OpenStreetMap, zoomed to about its cell. Opened only if clicked. */
function mapLink(p: Position): HTMLAnchorElement {
    const zoom = Math.max(3, Math.min(18, p.precision - 2));
    const lat = p.lat.toFixed(6);
    const lon = p.lon.toFixed(6);
    return el(
        "a",
        {
            href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`,
            target: "_blank",
            rel: "noopener noreferrer",
        },
        "Map",
    );
}

/** Who a position is from: a contact, or a member of a group by the routing id it claimed. */
function positionFrom(p: Position): string {
    return p.group === "" ? nameOf(p.contact) : `${writer(p.from)} in ${nameOf(p.group)}`;
}

function drawPlaces(): void {
    const c = client!;
    const able = c.can("SHARE");
    $("places-head").hidden = !able;
    const list = $("places");
    list.hidden = !able;
    list.replaceChildren();
    if (!able) {
        return;
    }
    const all = [...c.positions.values()].sort((a, b) => b.fixedAt - a.fixedAt);
    for (const p of all) {
        const facts = [
            `within ${cellSize(p.precision)}`,
            p.altitude !== null ? `${p.altitude} m up` : null,
            ago(p.fixedAt),
        ].filter((x): x is string => x !== null);
        list.append(
            el(
                "li",
                {},
                el("span", { class: "name" }, positionFrom(p)),
                el("span", { class: "muted" }, ` ${facts.join(", ")} `),
                mapLink(p),
            ),
        );
    }
    for (const [key, sharing] of c.sharing) {
        list.append(
            el(
                "li",
                {},
                el("span", { class: "name" }, `You, to ${nameOf(key)}`),
                el("span", { class: "muted" }, ` ${sharingText(sharing)}`),
            ),
        );
    }
    if (list.children.length === 0) {
        list.append(
            el("li", { class: "muted empty" }, "Nobody shares a position with this node, and it shares none. Share yours from a conversation."),
        );
    }
}

function drawAbout(): void {
    const c = client!;
    const able = c.can("SET", 5);
    $("about-head").hidden = !able;
    const list = $("about");
    list.hidden = !able;
    list.replaceChildren();
    if (!able) {
        return;
    }
    const all = [...c.cards.values()].sort((a, b) => b.heardAt - a.heardAt);
    if (all.length === 0) {
        list.append(el("li", { class: "muted empty" }, "No cards heard. Nearby nodes send one only if their user turns it on."));
    }
    for (const card of all) {
        const contact = c.contacts.get(card.address);
        const open = el("button", { type: "button", class: "small" }, contact ? "Open" : "Add");
        open.addEventListener("click", () => {
            if (contact) {
                select(card.address);
                return;
            }
            // Offered, never saved, until the user says so: a card's name is its sender's claim.
            $<HTMLInputElement>("add-address").value = card.address;
            $<HTMLInputElement>("add-name").value = clip(card.name, NAME_MAX);
            $<HTMLInputElement>("add-name").focus();
            say("Check the name, and the short code with them if you can, then Add.");
        });
        list.append(
            el(
                "li",
                {},
                el("span", { class: "name" }, card.name === "" ? "No name given" : `“${card.name}”`),
                contact && el("span", { class: "muted" }, ` (${nameOf(card.address)})`),
                el("br", {}),
                el("span", { class: "muted" }, `${codeOf(card.address) || short(card.address)} · ${ago(card.heardAt)} `),
                open,
            ),
        );
    }
}

/** What the card form was last filled from: it is filled again only when the node's change. */
let cardShown = "";

function drawCard(): void {
    const c = client!;
    const able = c.can("SET", 5) && c.self?.cards !== null;
    $("card-settings").hidden = !able;
    if (!able || !c.self) {
        return;
    }
    const key = `${c.self.cards}/${c.self.cardName}`;
    if (key === cardShown) {
        return;
    }
    cardShown = key;
    $<HTMLInputElement>("card-on").checked = c.self.cards === true;
    $<HTMLInputElement>("card-name").value = c.self.cardName ?? "";
    $("card-state").textContent = c.self.cards
        ? c.self.cardName
            ? `On: nodes near this one are told its address and “${c.self.cardName}”.`
            : "On: nodes near this one are told its address, with no name."
        : "Off: this node tells nobody who it is.";
}

async function applyCard(c: Client): Promise<void> {
    const on = $<HTMLInputElement>("card-on").checked;
    const name = clip($<HTMLInputElement>("card-name").value.trim(), NAME_MAX);
    if (!c.self) {
        return;
    }
    if (on && !c.self.cards) {
        const sure = window.confirm(
            "Turn on this node's presence card? Every two hours or so it sends, in clear, two hops round: " +
                `its address${name ? ` and the name “${name}”` : ""}. Anyone near can then see this node is about, and ask to reach it.`,
        );
        if (!sure) {
            return;
        }
    }
    try {
        if (name !== c.self.cardName) {
            await c.setCardName(name);
        }
        if (on !== c.self.cards) {
            await c.setCards(on);
        }
        say(on ? "Your card is on." : "Your card is off.");
    } catch (e) {
        say(explain(e), true);
    } finally {
        cardShown = "";
        draw();
    }
}

// ----- Sharing the browser's position -----

/** The geolocation watch while the node shares with anyone, and when the node was last told. */
let watching: number | null = null;
let toldAt = 0;
/** The least time between positions given the node, in milliseconds. */
const TELL_EVERY_MS = 15000;

function feedPosition(): void {
    const c = client;
    const want = c !== null && !c.closed && c.ready && c.sharing.size > 0 && !demo && "geolocation" in navigator;
    if (want && watching === null) {
        watching = navigator.geolocation.watchPosition(
            (fix) => {
                const now = Date.now();
                const live = client;
                if (!live || live.closed || now - toldAt < TELL_EVERY_MS) {
                    return;
                }
                toldAt = now;
                const age = Math.max(0, Math.round((now - fix.timestamp) / 1000));
                live
                    .setPosition(fix.coords.latitude, fix.coords.longitude, fix.coords.altitude, fix.coords.accuracy, age)
                    .catch(() => {
                        toldAt = 0; // tried again with the next fix
                    });
            },
            (e) => say(`The browser gave no position (${e.message}): the node has nothing to share.`, true),
            { enableHighAccuracy: true, maximumAge: 10000 },
        );
    } else if (!want && watching !== null) {
        navigator.geolocation.clearWatch(watching);
        watching = null;
        toldAt = 0;
    }
}

/** The share form for a conversation, opened from its head. */
let sharingWith: string | null = null;

function shareControls(key: string): Node[] {
    const c = client;
    if (!c || !c.can("SHARE") || (isGroup(key) ? !c.groups.has(key) : !c.contacts.has(key))) {
        return [];
    }
    const now = c.sharing.get(key);
    const open = el("button", { type: "button", class: "small" }, now ? "Change sharing" : "Share my position");
    open.addEventListener("click", () => {
        sharingWith = sharingWith === key ? null : key;
        draw();
    });
    const stop = now && el("button", { type: "button", class: "small" }, "Stop sharing");
    if (stop) {
        stop.addEventListener("click", () => act(() => c.share(key, 0)));
    }
    return [
        now && el("p", { class: "muted" }, `This node shares your position here: ${sharingText(now)}.`),
        el("p", { class: "actions" }, open, stop),
        sharingWith === key && shareForm(key, now ?? null),
    ].filter((n): n is HTMLParagraphElement | HTMLFormElement => n instanceof HTMLElement);
}

function shareForm(key: string, now: Sharing | null): HTMLFormElement {
    const group = isGroup(key);
    // The five, and the precision shared now if another client chose another, so that it stays
    // chosen: an empty choice would be read as 0, which turns sharing off.
    const precision = el("select", { id: "share-precision" });
    const precisions = PRECISIONS.map(([p, word, size]): [number, string] => [p, `${word} (${size})`]);
    if (now && !precisions.some(([p]) => p === now.precision)) {
        precisions.push([now.precision, `Within ${cellSize(now.precision)}`]);
        precisions.sort((a, b) => a[0] - b[0]);
    }
    for (const [p, words] of precisions) {
        precision.append(el("option", { value: String(p) }, words));
    }
    precision.value = String(now?.precision ?? 16);
    // At least POSITION_MIN for a contact and POSITION_GROUP_MIN for a group.
    // The interval shared now stays a choice too, however another client set it.
    const interval = el("select", { id: "share-interval" });
    const intervals: [number, string][] = (
        [
            [60, "1 min"],
            [300, "5 min"],
            [900, "15 min"],
            [3600, "1 h"],
        ] as [number, string][]
    ).filter(([secs]) => !group || secs >= 300);
    if (now && !intervals.some(([secs]) => secs === now.interval)) {
        intervals.push([now.interval, now.interval < 120 ? `${now.interval} s` : `${Math.round(now.interval / 60)} min`]);
        intervals.sort((a, b) => a[0] - b[0]);
    }
    for (const [secs, words] of intervals) {
        interval.append(el("option", { value: String(secs) }, words));
    }
    interval.value = String(now?.interval ?? (group ? 900 : 300));
    const minutes = el("select", { id: "share-minutes" });
    minutes.append(el("option", { value: "60" }, "1 hour"), el("option", { value: "480" }, "8 hours"), el("option", { value: "0" }, "until I stop"));
    minutes.value = now && now.endsAt === 0 ? "0" : "60";
    const altitude = el("input", { type: "checkbox", id: "share-altitude" });
    altitude.checked = now?.altitude ?? false;
    const form = el(
        "form",
        { class: "share card" },
        el("label", { for: "share-precision" }, "How exactly"),
        precision,
        el("label", { for: "share-interval" }, "How often, at most"),
        interval,
        el("label", { for: "share-minutes" }, "For how long"),
        minutes,
        el("label", { class: "check" }, altitude, " Include altitude (from Street up)"),
        el(
            "p",
            { class: "muted small-print" },
            "The node rounds your location to the size you pick before it leaves; the exact location stays between this browser and the node. " +
                "The browser asks for your location now, and gives it to the node only while this page is open.",
        ),
        el("button", { type: "submit", class: "primary" }, now ? "Update" : "Share"),
    );
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const p = Number(precision.value);
        const c = client;
        if (!c) {
            return;
        }
        c.share(key, p, {
            altitude: p >= 20 && altitude.checked,
            interval: Number(interval.value),
            minutes: Number(minutes.value),
        }).then(
            () => {
                sharingWith = null;
                say(`Sharing your position with ${nameOf(key)}.`);
                draw();
            },
            (err: unknown) => say(explain(err), true),
        );
    });
    return form;
}

// ----- Updating the node's firmware over its link -----

interface Offer {
    release: string;
    image: ManifestImage;
}
/** What the site offers the connected node, once asked; the key it was asked for. */
let offer: Offer | null = null;
let offerAsked = "";
/** An update under way, and the node it is for: it goes on when that node is connected again. */
let updating: { node: string; offer: Offer; updater: Updater } | null = null;
/** The image is downloading. */
let fetching = false;

function askOffer(c: Client): void {
    if (demo || !c.can("UPDATE_BEGIN") || c.board === "" || !c.self) {
        return;
    }
    const key = `${c.board}/${c.self.region}/${c.release}`;
    if (key === offerAsked) {
        return;
    }
    offerAsked = key;
    offer = null;
    offerFor(c.board, c.self.region, c.release).then(
        (found) => {
            if (offerAsked === key) {
                offer = found;
                draw();
            }
        },
        () => {
            // Offline, or the site has none: nothing is offered, and nothing is said.
        },
    );
}

function drawUpdate(): void {
    const c = client!;
    const box = $("update");
    box.replaceChildren();
    const mine = updating && updating.node === c.self?.address ? updating : null;
    if (mine) {
        const u = mine.updater;
        const percent = Math.floor((100 * u.acknowledged) / u.size);
        const cancel = el("button", { type: "button", class: "small" }, "Stop");
        cancel.addEventListener("click", () => {
            u.cancel();
            updating = null;
            say("Stopped. The node runs the firmware it had.");
            draw();
        });
        const progress = el("progress", { max: String(u.size), value: String(u.acknowledged) });
        box.append(
            el("h2", {}, `Updating to ${mine.offer.release}`),
            progress,
            el(
                "p",
                { class: "muted facts" },
                u.state === "ending" || u.state === "restarting"
                    ? "Sent. The node is checking it and restarting into it."
                    : u.state === "waiting"
                      ? `${percent}%: waiting for the node. Keep it in reach; it goes on from where it stopped.`
                      : `${percent}%. Keep this page open and the node in reach. Messages still come and go meanwhile.`,
            ),
        );
        if (u.state !== "ending" && u.state !== "restarting") {
            box.append(el("p", { class: "actions" }, cancel));
        }
        box.hidden = false;
        return;
    }
    if (!offer) {
        box.hidden = true;
        return;
    }
    const go = el("button", { type: "button", class: "small primary" }, "Update");
    go.addEventListener("click", () => void update(c, offer!));
    box.append(
        el("h2", {}, "An update"),
        el(
            "p",
            { class: "muted facts" },
            `Release ${offer.release} is out for this ${c.board} in ${c.self?.region}; it runs ${c.release || "an unnamed release"}. ` +
                "It is sent over this link and keeps everything the node holds.",
        ),
        el("p", { class: "actions" }, go),
    );
    box.hidden = false;
}

async function update(c: Client, chosen: Offer): Promise<void> {
    const node = c.self?.address;
    if (!node || fetching || updating) {
        return; // one at a time: a second click while the first downloads does nothing
    }
    let u: Updater;
    fetching = true;
    try {
        say("Downloading the firmware…");
        u = await Updater.of(await fetchImage(chosen.image));
    } catch (e) {
        say(explain(e), true);
        return;
    } finally {
        fetching = false;
    }
    say("");
    updating = { node, offer: chosen, updater: u };
    u.onChange = () => draw();
    await drive(c);
}

/**
 * Runs the update on a connection, starting the connection again while the link holds: a node
 * that took the client for gone, or did not answer for a while, is asked where it got to. A link
 * that closes leaves it for the next connection to the same node.
 */
async function drive(c: Client): Promise<void> {
    const job = updating;
    if (!job) {
        return;
    }
    const u = job.updater;
    for (let tries = 0; tries < 4 && !u.finished && !c.closed && updating === job; tries++) {
        await u.run((type, fields) => c.request(type, fields));
        if (u.state === "waiting" && !c.closed) {
            if ((await bringUp(c)) !== null) {
                break;
            }
        }
    }
    if (updating !== job) {
        return;
    }
    switch (u.state) {
        case "restarting":
        case "unknown": {
            // It restarts into the image: what it says on coming back is whether it runs it.
            await new Promise((r) => setTimeout(r, 1500));
            const back = c.closed ? new Error("the link closed") : await bringUp(c);
            updating = null;
            offerAsked = "";
            if (back !== null) {
                say("The node is restarting into the new firmware. Connect to it again in a moment.");
            } else if (c.release === job.offer.release) {
                say(`Updated: the node runs ${c.release}.`);
            } else {
                say(`The node came back running ${c.release || "its old firmware"}, not ${job.offer.release}.`, true);
            }
            break;
        }
        case "refused":
            updating = null;
            say(
                u.code === 11
                    ? "The node would not run that image, and kept its firmware."
                    : u.code === 5
                      ? "The node cannot take an update this way: flash it over USB."
                      : `The node refused the update (${u.code}).`,
                true,
            );
            break;
        case "waiting":
            say("The link went in the middle of the update. Connect to the node again to go on.", true);
            break;
    }
    draw();
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
            shownCode = null;
            act(() => client!.leaveGroup(id));
        }
    });
    const code = client?.can("GROUP_LINK") && el("button", { type: "button", class: "small" }, "Join code");
    if (code) {
        code.addEventListener("click", () => {
            const sure = window.confirm(
                `Show ${nameOf(id)}'s join code? Anyone who sees it, or a photo of it, can join the group and ` +
                    "read everything said in it, before and after, and it cannot be taken back. Show it only to " +
                    "those the group is for.",
            );
            if (sure) {
                client!.groupLink(id).then(
                    (link) => {
                        shownCode = { group: id, link };
                        draw();
                    },
                    (e: unknown) => say(explain(e), true),
                );
            }
        });
    }
    // Whom to invite: any contact. An invite goes over a session, and to one there is none with
    // yet the node makes first contact first, as for a first message.
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
        el(
            "p",
            { class: "actions" },
            rename,
            leave,
            code,
            whom.options.length > 0 && whom,
            whom.options.length > 0 && invite,
        ),
        ...(shownCode?.group === id ? [joinCodePanel(shownCode.link)] : []),
        ...shareControls(id),
    );
}

/** A join code, shown because the user asked: its QR code, its link, and a way to put it away. */
function joinCodePanel(link: string): HTMLElement {
    const ns = "http://www.w3.org/2000/svg";
    const modules = qrEncode(linkSegments(link));
    const side = modules.length + 8; // and a quiet zone of four modules each side
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
    svg.setAttribute("class", "qr");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "The group's join code, as a QR code");
    const ground = document.createElementNS(ns, "rect");
    ground.setAttribute("width", String(side));
    ground.setAttribute("height", String(side));
    ground.setAttribute("fill", "#fff");
    const dark = document.createElementNS(ns, "path");
    dark.setAttribute("d", qrPath(modules));
    dark.setAttribute("fill", "#000");
    svg.append(ground, dark);

    const copy = el("button", { type: "button", class: "small" }, "Copy the link");
    copy.addEventListener("click", () => {
        navigator.clipboard.writeText(link).then(
            () => say("Copied. Send it only to those the group is for."),
            () => say("Your browser would not copy it: select the link and copy it yourself.", true),
        );
    });
    const hide = el("button", { type: "button", class: "small" }, "Hide");
    hide.addEventListener("click", () => {
        shownCode = null;
        draw();
    });
    return el(
        "div",
        { class: "card join-code" },
        svg,
        el("p", {}, el("code", { class: "link" }, link)),
        el(
            "p",
            { class: "muted small-print" },
            "Whoever scans this or is sent the link can join the group and read all of it. It works for as " +
                "long as the group does. This page keeps it only while it is shown.",
        ),
        el("p", { class: "actions" }, copy, hide),
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
        ...shareControls(address),
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
        feedPosition();
        if (!up || !client?.ready) {
            // A join code shown is let go of with the link, whichever way the link went: the panel
            // is in the subtree just hidden.
            shownCode = null;
            document.querySelector(".join-code")?.remove();
            return;
        }
        if (client.self && (!history || !historyFor(client.self.address))) {
            history = new History(client.self.address, demo ? null : local());
            historyNode = client.self.address;
        }
        history?.absorb(client.messages.values());
        learnIds();
        askOffer(client);
        drawNode();
        drawUpdate();
        drawSettings();
        drawCard();
        drawAsked();
        drawPeople();
        drawGroups();
        drawAbout();
        drawPlaces();
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

/** Joins the group a join code is for, once the user has seen its name and said yes. */
async function joinFromCode(text: string): Promise<void> {
    const code = await readJoinCode(text);
    if (!code) {
        say("That is not a join code. Check it was copied whole: it starts HTTPS://TERNMESH.ORG/G#.", true);
        return;
    }
    if (client?.groups.has(code.group)) {
        $<HTMLFormElement>("group-join").reset();
        select(code.group);
        say("This node is in that group already.");
        return;
    }
    const called = code.name === "" ? "this group" : `the group “${code.name}”`;
    if (!window.confirm(`Join ${called}? Whoever gave you the code can read it too, as can anyone else they gave it to.`)) {
        return;
    }
    try {
        const id = await client!.joinLink(text);
        $<HTMLFormElement>("group-join").reset();
        say("Joined. Its members learn of you only when you write.");
        select(id);
    } catch (e) {
        say(explain(e), true);
    }
}

function select(address: string): void {
    if (shownCode && shownCode.group !== address) {
        shownCode = null;
    }
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
    shownCode = null;
    history = null;
    historyNode = "";
    ids.clear();
    settingsShown = "";
    cardShown = "";
    sharingWith = null;
    offer = null;
    offerAsked = "";
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
        if (updating && updating.node === c.self?.address) {
            say("Going on with the update…");
            void drive(c);
        }
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
            say("An address is 64 hex digits, or a node's link: its Share page's code, or its 'status', gives it.", true);
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

    $<HTMLFormElement>("group-join").addEventListener("submit", (e) => {
        e.preventDefault();
        void joinFromCode($<HTMLInputElement>("join-code").value.trim());
    });

    $<HTMLFormElement>("settings-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (client) {
            void applySettings(client);
        }
    });

    $<HTMLFormElement>("card-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (client) {
            void applyCard(client);
        }
    });

    $<HTMLFormElement>("console-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const line = $<HTMLInputElement>("console-line");
        act(() => client?.type(line.value) ?? Promise.resolve());
        line.value = "";
    });

    document.addEventListener("visibilitychange", draw);
    setInterval(() => {
        if (client?.ready) {
            drawNeighbours();
            drawAbout();
            drawPlaces();
        }
    }, 15000);
    count();
    // A node's page (/node) sends its address here, to be added once a board is connected.
    const shared = parseAddress(new URLSearchParams(location.search).get("add") ?? "");
    if (shared) {
        $<HTMLInputElement>("add-address").value = shared;
    }
    // A join code's page (/G) sends its code here after the #, which no request carries, to be
    // joined from once a node is connected and the user says so. It leaves the address bar at once.
    if (location.hash.startsWith("#join=")) {
        $<HTMLInputElement>("join-code").value = decodeURIComponent(location.hash.slice("#join=".length));
        window.history.replaceState(null, "", location.pathname + location.search);
        say("Connect your node, then press Join under Groups.");
    }
    if (new URLSearchParams(location.search).has("demo")) {
        void connect(openDemo, "demo");
    }
}

start();
