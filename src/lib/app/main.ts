// The page at /app: a companion client for a Tern node, in the browser. It draws what a Client
// holds and turns clicks into requests; the protocol is in ../companion.
//
// Everything a node sends is untrusted text from the air, so nothing here is ever set as HTML:
// every string goes in as a text node.

import { Client, Refused } from "../companion/client.ts";
import type { Fix, Message, Position, Sharing, Sleep, Transport } from "../companion/client.ts";
import { openDemo } from "../companion/demo.ts";
import { BLINDED_SINCE, parseAddress, routingIdFor, routingIdText } from "../companion/ids.ts";
import {
    ASKED,
    FIX_SOURCE,
    LISTEN_MIN,
    NAME_MAX,
    PAIRING,
    POWER_MOST,
    RECEIVER,
    SLEEP,
    STATE,
    TEXT_MAX,
    UPDATE,
} from "../companion/protocol.ts";
import { SIGNED_SINCE, bytesSigned, fetchImage, imageSigned, offerFor, offerable, signatureOf } from "../companion/release.ts";
import type { Signed } from "../companion/signing.ts";
import { readJoinCode, shortCode } from "../companion/share.ts";
import { linkSegments, qrEncode, qrPath } from "../qr.ts";
import { Updater, askBootloader, wayOf } from "../companion/updater.ts";
import type { ManifestImage, UpdateWay } from "../flash/images.ts";
import { bluetoothSupported, openBluetooth, openDfu } from "../companion/bluetooth.ts";
import type { BluetoothTransport, Device } from "../companion/bluetooth.ts";
import { readPackage, sendPackage } from "../companion/dfu.ts";
import type { DfuStage, Package } from "../companion/dfu.ts";
import { openSerial, serialSupported } from "../companion/serial.ts";
import { History } from "./history.ts";
import type { Kept } from "./history.ts";
import { boards, familyOf } from "../../data/boards.ts";

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
/** The last node connected to was turned off from here: it is not connected to again until asked. */
let turnedOff = false;
/**
 * Routing ids of the addresses the page knows, to put names to neighbours, group writers and
 * group positions: as the connected node makes them (blinded from version 14), which idsBlinded says.
 */
const ids = new Map<string, number>();
let idsBlinded = false;
/** The tab shown: the phone apps' Chats, People and Node. */
type Tab = "chats" | "people" | "node";
let tab: Tab = "chats";
/** How the node is reached, for the Node tab to say. */
let linkKind: "serial" | "bluetooth" | "demo" = "serial";

function local(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/** When the toast showing now goes, if it goes by itself. */
let sayTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Says something at the foot of the window, until it is said again or dismissed. What is going
 * well goes by itself after a while; a problem, and anything still under way ("…"), stays.
 */
function say(text: string, bad = false): void {
    const status = $("status");
    clearTimeout(sayTimer);
    $("status-text").textContent = text;
    status.classList.toggle("bad", bad);
    status.hidden = text === "";
    if (text !== "" && !bad && !text.endsWith("…")) {
        sayTimer = setTimeout(() => say(""), 7000);
    }
}

function wide(): boolean {
    return window.matchMedia("(min-width: 48.01rem)").matches;
}

// ----- Avatars and marks, as the phone apps draw them (apple/App/Design.swift) -----

const AVATAR_HUES = ["#0B4F6C", "#0F766E", "#7C3AED", "#C2410C", "#B45309", "#BE185D", "#4D7C0F", "#1D4ED8"];

/** The letters an avatar shows: the first of each of the first two words, or "?". */
function initials(name: string): string {
    const words = name.split(/[\s()·\-_]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const letters = words.slice(0, 2).map((w) => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").toUpperCase());
    return letters.join("") || "?";
}

/** FNV-1a, so that the same key has the same colour on every visit. */
function hue(key: string): string {
    let h = 2166136261;
    for (const b of new TextEncoder().encode(key)) {
        h = Math.imul(h ^ b, 16777619) >>> 0;
    }
    return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/** A person's round badge of initials, or a group's rounded square. */
function avatar(key: string, small = false): HTMLElement {
    const group = isGroup(key);
    const named = group ? (client?.groups.get(key)?.name ?? "") : (client?.contacts.get(key)?.name ?? "");
    const a = el(
        "span",
        { class: ["avatar", group && "group", small && "sm", named === "" && "unknown"].filter(Boolean).join(" "), "aria-hidden": "true" },
        named === "" ? (group ? "#" : "?") : initials(named),
    );
    if (named !== "") {
        a.style.background = hue(group ? `g${key}` : key);
    }
    return a;
}

/** How well a neighbour is heard, as one to four bars: above 5 dB is strong, 0 comfortable, -7 near the edge. */
function signalBars(snrDb: number): HTMLElement {
    const on = snrDb >= 5 ? 4 : snrDb >= 0 ? 3 : snrDb >= -7 ? 2 : 1;
    const bars = el("span", { class: `bars ${on >= 2 ? "good" : "weak"}`, role: "img", "aria-label": `Signal: ${on} of 4 bars` });
    for (let i = 0; i < 4; i++) {
        bars.append(el("i", i < on ? { class: "on" } : {}));
    }
    return bars;
}

/** A line drawing, from the paths of a 24-unit square. */
function icon(...paths: string[]): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", d);
        svg.append(p);
    }
    return svg;
}

/** What the node is called on the page: its card's name, else its board's, else none. */
function nodeTitle(): string {
    const c = client;
    if (!c) {
        return "No node";
    }
    if (demo) {
        return "Demo node";
    }
    if (c.self?.cardName) {
        return c.self.cardName;
    }
    return boards.find((b) => b.name === c.board)?.title ?? (c.board || "Your node");
}

function unreadOf(key: string): number {
    return liveWith(key).filter((m) => m.state === STATE.received && !m.read).length;
}

/** The latest message of a conversation, live or kept. */
function lastOf(key: string): Kept | null {
    const live = liveWith(key);
    const m = live[live.length - 1];
    if (m) {
        return { ...m, incoming: m.state === STATE.received };
    }
    const earlier = history?.earlier(key, live) ?? [];
    return earlier[earlier.length - 1] ?? null;
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

/** A sleeping node's wake, in words: "5 min", "1 h". */
function wakeText(seconds: number): string {
    return seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
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
    const copy = el("button", { type: "button", class: "small" }, "Copy address");
    copy.addEventListener("click", () => {
        navigator.clipboard.writeText(address).then(
            () => say("Address copied. Give it to whoever should write to this node."),
            () => say("The browser would not copy it: select the address and copy it by hand.", true),
        );
    });
    const chips = [
        c.self.region || "no region set",
        `${c.self.power} dBm${c.self.most ? " (the most allowed)" : ""}`,
        c.self.role === 1 ? "Relay: helps the mesh" : "Leaf: just me",
        demo ? "" : c.release || c.firmware,
    ].filter((x) => x !== "");
    const meters = el("div", { class: "meters" });
    if (c.power && c.power.percent <= 100) {
        const p = c.power.percent;
        meters.append(
            meter(
                "Battery",
                `${p}%`,
                p / 100,
                p <= 20,
                c.power.charging ? "charging" : c.power.external ? "on power" : `${(c.power.millivolts / 1000).toFixed(2)} V`,
            ),
        );
    }
    if (c.airtime && c.airtime.period > 0 && c.airtime.allowed > 0) {
        const used = c.airtime.used / c.airtime.allowed;
        meters.append(
            meter(
                "Airtime",
                `${Math.round(c.airtime.used / 1000)} s`,
                used,
                used >= 0.8,
                `of ${Math.round(c.airtime.allowed / 1000)} s allowed`,
            ),
        );
    }
    box.append(
        el("p", { class: "eyebrow" }, demo ? "A demo, not a node" : "Your node"),
        el("h2", {}, nodeTitle()),
        el("p", { class: "sub" }, codeOf(address) ? `Short code ${codeOf(address)}` : short(address)),
        el("p", { class: "address" }, el("code", {}, address), copy),
        el("ul", { class: "chips" }, ...chips.map((x) => el("li", {}, x))),
    );
    if (meters.children.length > 0) {
        box.append(meters);
    }
    if (c.fix) {
        box.append(...fixFacts(c.fix));
    }
    // What the firmware's version leaves out, newest first, so the list says what an update brings.
    // Not of the demo, which has no firmware to update.
    const missing = [
        [14, "keep its address off the air in what it sends to route"],
        [13, "check that an update is signed by Tern, or be erased from here"],
        [9, "be turned off from here"],
        [8, "say where it is, or have its GPS turned off"],
        [7, "share a group by its join code, or join from one"],
        [6, "show who is about"],
        [5, "share positions"],
        [4, "be updated from here"],
        [2, "make or join groups"],
        [1, "end a session, or say who asked to reach it"],
    ]
        .filter(([v]) => c.version < Number(v))
        .map(([, what]) => String(what));
    if (!demo && c.update === UPDATE.none && isNrf(c.board)) {
        box.append(
            el(
                "p",
                { class: "muted facts" },
                "This node's bootloader does not take firmware over Bluetooth: ",
                el("a", { href: `/flash?board=${encodeURIComponent(c.board)}` }, "update it over USB"),
                ".",
            ),
        );
    }
    if (!demo && c.self.pairing === PAIRING.default) {
        box.append(
            el(
                "p",
                { class: "muted facts" },
                "It has no screen, and pairs over Bluetooth with the default passkey, 123456, until a passkey of your own is set on it" +
                    (c.version >= SIGNED_SINCE ? ": a new phone or computer only within 3 minutes of a press of its button or of turning it on." : "."),
            ),
        );
    }
    if (missing.length > 0 && !demo) {
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

/** A meter on the node's card: what it measures, how much, and a bar of how full. */
function meter(label: string, value: string, fraction: number, warn: boolean, note: string): HTMLElement {
    const fill = el("div", { class: warn ? "fill warn" : "fill" });
    fill.style.width = `${Math.max(2, Math.min(100, Math.round(fraction * 100)))}%`;
    return el(
        "div",
        { class: "meter" },
        el("div", { class: "label" }, el("span", {}, label), el("span", {}, note)),
        el("div", { class: "value" }, value),
        el("div", { class: "track" }, fill),
    );
}

/** What a node's GPS receiver is doing, in a few words; null for a node with none. */
function receiverText(f: Fix): string | null {
    switch (f.receiver) {
        case RECEIVER.none:
            return null;
        case RECEIVER.off:
            return "Its GPS is off.";
        case RECEIVER.fixed:
            return f.source === FIX_SOURCE.receiver && f.satellites > 0
                ? `Its GPS has a fix, from ${f.satellites} satellite${f.satellites === 1 ? "" : "s"}.`
                : "Its GPS has a fix.";
        default:
            return "Its GPS is on, looking for satellites.";
    }
}

/**
 * Where the node takes itself to be, which is where it shares its position from, and its GPS.
 * The fix goes no further than this page: what goes on the air is what sharing sends.
 */
function fixFacts(f: Fix): HTMLElement[] {
    const gps = receiverText(f);
    if (f.source === FIX_SOURCE.none) {
        return [el("p", { class: "muted facts" }, [gps, "It does not know where it is."].filter((x) => x !== null).join(" "))];
    }
    const facts = [
        `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`,
        f.altitude !== null ? `${f.altitude} m up` : null,
        f.accuracy !== null ? `within ${f.accuracy} m` : null,
        f.source === FIX_SOURCE.receiver ? "from its GPS" : "as an app gave it",
        ago(f.fixedAt),
    ].filter((x): x is string => x !== null);
    return [
        el("p", { class: "muted facts" }, `Where it is: ${facts.join(", ")} `, osmLink(f.lat, f.lon, 15)),
        gps !== null && el("p", { class: "muted facts" }, gps),
    ].filter((x): x is HTMLParagraphElement => x instanceof HTMLElement);
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
    const receiver = receiverSettable(client!);
    const receiverOn = receiver && client!.fix!.receiver !== RECEIVER.off;
    // Whether there is a receiver and whether it is on, apart: a FIX that comes after SELF, saying
    // a receiver is there but off, is a change to the form even though the box stays unticked.
    const key = `${self.region}/${self.power}/${self.most}/${self.role}/${receiver}/${receiverOn}`;
    if (key === settingsShown) {
        return;
    }
    settingsShown = key;
    $("receiver-setting").hidden = !receiver;
    $<HTMLInputElement>("set-receiver").checked = receiverOn;
    $<HTMLInputElement>("set-power").value = String(self.power);
    $("set-power-most").hidden = client!.version < 10 || self.most === true;
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

/** Whether the node has a GPS receiver this page may turn on and off: version 8's SET 7. */
function receiverSettable(c: Client): boolean {
    return c.can("SET", 7) && c.fix !== null && c.fix.receiver !== RECEIVER.none;
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
        list.append(el("li", { class: "empty" }, "Nobody yet. Add someone by their address, below."));
    }
    for (const address of all) {
        const contact = client?.contacts.get(address);
        list.append(
            el(
                "li",
                {},
                rowButton(
                    address,
                    contact ? (codeOf(address) || short(address)) : "Not a contact",
                    contact?.session && el("span", { class: "tag good", title: "This node has a session with it" }, "Session"),
                ),
            ),
        );
    }
}

/** A person or group in a card's list, that opens its conversation. */
function rowButton(key: string, sub: string, mark: Child): HTMLButtonElement {
    const button = el(
        "button",
        { type: "button", class: "row-button" },
        avatar(key, true),
        el("span", { class: "row-main" }, el("span", { class: "row-title" }, nameOf(key)), el("span", { class: "row-sub" }, sub)),
        mark,
    );
    button.addEventListener("click", () => select(key));
    return button;
}

/** Every conversation, most recent first: who, what was said last, when, and how many are unread. */
function drawTalks(): void {
    const list = $("talks");
    list.replaceChildren();
    const all = talks();
    if (all.length === 0) {
        list.append(
            el(
                "li",
                { class: "empty" },
                "No conversations yet. Add a contact by their address, or make a group, to start one.",
            ),
        );
    }
    for (const key of all) {
        const last = lastOf(key);
        const unread = unreadOf(key);
        const left = isGroup(key) && !client?.groups.has(key);
        let preview = "Nothing said yet";
        if (last) {
            const words = last.invite ? (last.incoming ? "Invited you to a group" : "You sent an invite") : last.text;
            preview = last.incoming || last.invite ? words : `You: ${words}`;
            if (last.incoming && last.from && !last.invite) {
                preview = `${writer(last.from)}: ${words}`;
            }
        }
        const button = el(
            "button",
            { type: "button", class: ["talk-item", key === selected && "on", unread > 0 && "unread"].filter(Boolean).join(" ") },
            avatar(key),
            el(
                "span",
                { class: "row-main" },
                el(
                    "span",
                    { class: "top" },
                    el("span", { class: "row-title" }, nameOf(key)),
                    last && last.time > 0 && el("time", {}, when(last.time)),
                ),
                el(
                    "span",
                    { class: "bottom" },
                    el("span", { class: "row-sub" }, left ? "You left this group" : preview),
                    unread > 0 && el("span", { class: "badge" }, String(unread)),
                ),
            ),
        );
        button.addEventListener("click", () => select(key));
        list.append(el("li", {}, button));
    }
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
        list.append(el("li", { class: "empty" }, "None yet. Make one below, or be invited to one."));
    }
    for (const id of all) {
        const held = client?.groups.has(id);
        list.append(
            el(
                "li",
                {},
                rowButton(id, held ? "Group" : "This node has left it", !held && el("span", { class: "tag" }, "Left")),
            ),
        );
    }
}

function drawNeighbours(): void {
    const list = $("neighbours");
    list.replaceChildren();
    const all = [...(client?.neighbours.values() ?? [])].sort((a, b) => b.snrDb - a.snrDb);
    if (all.length === 0) {
        list.append(el("li", { class: "empty" }, "None heard yet."));
    }
    for (const n of all) {
        const who = [...ids].find(([, id]) => id === n.routingId)?.[0];
        const name = who ? nameOf(who) : routingIdText(n.routingId);
        list.append(
            el(
                "li",
                {},
                who ? avatar(who, true) : el("span", { class: "avatar sm unknown", "aria-hidden": "true" }, "?"),
                el(
                    "span",
                    { class: "row-main" },
                    el("span", { class: "row-title" }, name, " ", el("span", { class: "tag" }, n.role === 1 ? "Relay" : "Leaf")),
                    el("span", { class: "row-sub" }, `${n.snrDb.toFixed(1)} dB · ${ago(n.heardAt)}`),
                ),
                signalBars(n.snrDb),
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
    return osmLink(p.lat, p.lon, Math.max(3, Math.min(18, p.precision - 2)));
}

/** A link that opens a place on OpenStreetMap at a zoom. Opened only if clicked. */
function osmLink(latitude: number, longitude: number, zoom: number): HTMLAnchorElement {
    const lat = latitude.toFixed(6);
    const lon = longitude.toFixed(6);
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
    $("places-card").hidden = !able;
    const list = $("places");
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
                avatar(p.group === "" ? p.contact : p.group, true),
                el(
                    "span",
                    { class: "row-main" },
                    el("span", { class: "row-title" }, positionFrom(p)),
                    el("span", { class: "row-sub" }, facts.join(", ")),
                ),
                mapLink(p),
            ),
        );
    }
    for (const [key, sharing] of c.sharing) {
        list.append(
            el(
                "li",
                {},
                avatar(key, true),
                el(
                    "span",
                    { class: "row-main" },
                    el("span", { class: "row-title" }, `You, to ${nameOf(key)}`),
                    el("span", { class: "row-sub" }, sharingText(sharing)),
                ),
            ),
        );
    }
    if (list.children.length === 0) {
        list.append(
            el("li", { class: "empty" }, "Nobody shares a position with this node, and it shares none. Share yours from a conversation."),
        );
    }
}

function drawAbout(): void {
    const c = client!;
    const able = c.can("SET", 5);
    $("about-card").hidden = !able;
    const list = $("about");
    list.replaceChildren();
    if (!able) {
        return;
    }
    const all = [...c.cards.values()].sort((a, b) => b.heardAt - a.heardAt);
    if (all.length === 0) {
        list.append(el("li", { class: "empty" }, "No cards heard. Nearby nodes send one only if their user turns it on."));
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
            say("Check the name, and the short code with them if you can, then Add contact.");
        });
        list.append(
            el(
                "li",
                {},
                contact ? avatar(card.address, true) : el("span", { class: "avatar sm unknown", "aria-hidden": "true" }, "?"),
                el(
                    "span",
                    { class: "row-main" },
                    el(
                        "span",
                        { class: "row-title" },
                        card.name === "" ? "No name given" : `“${card.name}”`,
                        contact ? el("span", { class: "muted" }, ` (${nameOf(card.address)})`) : "",
                    ),
                    el("span", { class: "row-sub" }, `${codeOf(card.address) || short(card.address)} · ${ago(card.heardAt)}`),
                ),
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

// ----- Sleeping -----

/** The wakes the page offers, in seconds: from WAKE_MIN to WAKE_MAX. */
const WAKES = [300, 600, 900, 1800, 3600];
/** What the sleep form was last filled from: it is filled again only when the node's change. */
let sleepShown = "";

/** What a node set to sleep is doing, in a sentence. */
function sleepText(s: Sleep, relay: boolean): string {
    if (s.wake === 0) {
        return "Awake: it listens all the time.";
    }
    if (relay) {
        return `Awake: a relay never sleeps. It will sleep, waking every ${wakeText(s.wake)}, once it only sends and receives its own.`;
    }
    switch (s.state) {
        case SLEEP.asleep:
            return `Asleep — kept by ${writer(s.keeper)}, waking at least every ${wakeText(s.wake)}.`;
        case SLEEP.waiting:
            return "Waiting for a relay to keep its messages: it listens all the time until one does.";
        case SLEEP.resting: {
            const left = Math.max(0, Math.round(((s.retryAt ?? Date.now()) - Date.now()) / 1000));
            const inWords = left >= 120 ? `${Math.round(left / 60)} min` : `${left} s`;
            return `No relay answers; trying ${writer(s.keeper)} again in ${inWords}. It listens all the time meanwhile.`;
        }
        default:
            return "Awake: it listens all the time.";
    }
}

function drawSleep(): void {
    const c = client!;
    const able = c.can("SET", 8) && c.sleep !== null && c.self !== null;
    $("sleep-settings").hidden = !able;
    if (!able) {
        return;
    }
    const s = c.sleep!;
    const relay = c.self!.role === 1;
    $("sleep-state").textContent = sleepText(s, relay);
    const key = `${s.wake}/${s.listen}`;
    if (key === sleepShown) {
        return;
    }
    sleepShown = key;
    $<HTMLInputElement>("sleep-on").checked = s.wake !== 0;
    const wake = $<HTMLSelectElement>("sleep-wake");
    if (s.wake !== 0 && !WAKES.includes(s.wake)) {
        wake.append(el("option", { value: String(s.wake) }, `every ${wakeText(s.wake)}`));
    }
    wake.value = String(s.wake !== 0 ? s.wake : 600);
    $<HTMLInputElement>("sleep-listen").value = String(s.listen);
}

async function applySleep(c: Client): Promise<void> {
    const s = c.sleep;
    if (!s) {
        return;
    }
    const on = $<HTMLInputElement>("sleep-on").checked;
    const wake = on ? Number($<HTMLSelectElement>("sleep-wake").value) : 0;
    const listen = Math.round(Number($<HTMLInputElement>("sleep-listen").value));
    if (!Number.isFinite(listen) || listen < LISTEN_MIN || listen > 255) {
        say(`Listen for ${LISTEN_MIN} to 255 seconds after each wake.`, true);
        return;
    }
    if (on && s.wake === 0) {
        const sure = window.confirm(
            `Let this node sleep? Its radio goes off between wakes, every ${wakeText(wake)} at most, to save its battery. ` +
                `Messages to it then wait with a relay until it wakes: up to ${wakeText(wake)}, longer if one is missed.`,
        );
        if (!sure) {
            return;
        }
    }
    try {
        if (listen !== s.listen) {
            await c.setListen(listen);
        }
        if (wake !== s.wake) {
            await c.setWake(wake);
        }
        say(on ? `It sleeps, waking every ${wakeText(wake)} at most.` : "It listens all the time.");
    } catch (e) {
        say(explain(e), true);
    } finally {
        sleepShown = "";
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
    // A node whose own GPS has a fix shares from that, and need not be given the browser's.
    const own = c?.fix?.receiver === RECEIVER.fixed;
    const want = c !== null && !c.closed && c.ready && c.sharing.size > 0 && !own && !demo && "geolocation" in navigator;
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
    way: UpdateWay;
    /** Whether the image is signed by a release key, by the manifest, before it is downloaded. */
    signed: Signed;
}
/** What the site offers the connected node, once asked; the key it was asked for. */
let offer: Offer | null = null;
let offerAsked = "";
/** An update under way, and the node it is for: it goes on when that node is connected again. */
let updating: { node: string; offer: Offer; updater: Updater } | null = null;
/** The image is downloading. */
let fetching = false;

function isNrf(board: string): boolean {
    const b = boards.find((x) => x.name === board);
    return b !== undefined && familyOf(b) === "uf2";
}

function askOffer(c: Client): void {
    const way = wayOf(c);
    // A bootloader takes its image over Web Bluetooth, which this browser must have, whatever the
    // node is connected by.
    if (demo || !way || !c.self || (way === "bootloader" && !bluetoothSupported())) {
        return;
    }
    const key = `${c.board}/${c.self.region}/${c.release}/${way}`;
    if (key === offerAsked) {
        return;
    }
    offerAsked = key;
    offer = null;
    offerFor(c.board, c.self.region, c.release, way).then(
        (found) => {
            if (offerAsked === key) {
                offer = found && { ...found, way, signed: imageSigned(found.image) };
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
            el("h3", {}, `Updating to ${mine.offer.release}`),
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
    const chosen = offer;
    const out = `Release ${offer.release} is out for this ${c.board} in ${c.self?.region}; it runs ${c.release || "an unnamed release"}. `;
    if (!offerable(chosen.signed, c.version, chosen.way)) {
        // A node that checks signatures refuses an image with none: there is nothing to send it.
        box.append(
            el("h3", {}, "An update is out"),
            el(
                "p",
                { class: "muted facts" },
                out,
                `${chosen.release} was published before releases were signed, and this node takes only signed images over Bluetooth, so it would refuse it. Update it over USB from `,
                el("a", { href: "/flash" }, "the flash page"),
                ".",
            ),
        );
        box.hidden = false;
        return;
    }
    const verified = chosen.signed === "verified";
    const go = el("button", { type: "button", class: verified ? "small primary" : "small danger" }, verified ? "Update" : "Install anyway");
    go.addEventListener("click", () => {
        if (!verified && !confirm(unsignedWarning(chosen.signed))) {
            return;
        }
        void (chosen.way === "bootloader" ? updateByBootloader(c, chosen) : update(c, chosen));
    });
    box.append(
        el("h3", {}, "An update is out"),
        el(
            "p",
            { class: "muted facts" },
            out +
                (offer.way === "bootloader"
                    ? "The node restarts into its bootloader, which you then choose in the browser's list at once, and takes it over Bluetooth in about five minutes. It keeps everything the node holds. Until the update finishes, anyone in Bluetooth range can install an image on it: its bootloader checks no signature."
                    : "It is sent over this link and keeps everything the node holds."),
        ),
        el(
            "p",
            { class: verified ? "muted facts" : "facts warn" },
            verified
                ? "Signed by Tern's release key."
                : chosen.signed === "unsigned"
                  ? `${chosen.release} was published before releases were signed, so this page cannot check it is the release's.`
                  : "Its signature does not verify with a release key this page holds: it may not be the release's.",
        ),
        el("p", { class: "actions" }, go),
    );
    box.hidden = false;
}

/** What the user is told before installing an image that is not signed by a release key. */
function unsignedWarning(signed: Signed): string {
    return (
        (signed === "unsigned"
            ? "This image has no signature, so nothing shows it is the release Tern published."
            : "This image's signature does not verify with a release key this page holds: it may not be the release Tern published.") +
        " An image that is not Tern's could do anything with the node: read its keys, its contacts and its messages. Install it anyway?"
    );
}

/**
 * The signature to send with the image downloaded, or throws if the bytes are not signed as the
 * manifest said they were: a download that changed under it is not sent.
 */
async function checkSigned(data: Uint8Array, chosen: Offer): Promise<Uint8Array | null> {
    const signed = await bytesSigned(data, chosen.image);
    if (signed !== chosen.signed) {
        throw new Error("the firmware downloaded is not signed as the list says: it was not sent");
    }
    return signatureOf(chosen.image);
}

async function update(c: Client, chosen: Offer): Promise<void> {
    const node = c.self?.address;
    if (!node || fetching || updating || booting) {
        return; // one at a time: a second click while the first downloads does nothing
    }
    let u: Updater;
    fetching = true;
    try {
        say("Downloading the firmware…");
        const data = await fetchImage(chosen.image);
        u = await Updater.of(data, await checkSigned(data, chosen));
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
                u.code === 11 && u.refusedAt === "beginning"
                    ? "The node refused the image before any of it was sent: it is not signed by a key this node trusts. It keeps its firmware."
                    : u.code === 11
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

// ----- Updating an nRF52840 node by its bootloader -----

/**
 * An update a node's bootloader is taking: the node has restarted into it, so no client is
 * connected, and the gate shows this until it ends. `device` is the node's own over Bluetooth,
 * to reach it again after; `bootloader` the bootloader's, once the user has chosen it.
 */
interface BootJob {
    node: string;
    name: string;
    offer: Offer;
    pkg: Package;
    device: Device | null;
    bootloader: Device | null;
    stage: "choose" | DfuStage | "failed" | "reconnecting";
    sent: number;
    why: string;
    stop: AbortController | null;
}
let booting: BootJob | null = null;
/** The Bluetooth device of the node connected, if it is connected over Bluetooth. */
let nodeDevice: Device | null = null;

async function updateByBootloader(c: Client, chosen: Offer): Promise<void> {
    const node = c.self?.address;
    if (!node || fetching || updating || booting) {
        return;
    }
    let pkg: Package;
    fetching = true;
    try {
        say("Downloading the firmware…");
        const data = await fetchImage(chosen.image);
        // The bootloader checks no signature: the package's is checked here, before the node is
        // asked to restart into it.
        await checkSigned(data, chosen);
        pkg = await readPackage(data);
    } catch (e) {
        say(explain(e), true);
        return;
    } finally {
        fetching = false;
    }
    say("Asking the node to restart into its bootloader…");
    try {
        await askBootloader((type, fields) => c.request(type, fields));
    } catch (e) {
        say(
            e instanceof Refused && e.code === 5
                ? "The node cannot take an update this way: update it over USB, from the flash page."
                : explain(e),
            true,
        );
        return;
    }
    // OK, or no answer: either way it may be restarting, and is not asked again.
    booting = {
        node,
        name: nodeTitle(),
        offer: chosen,
        pkg,
        device: linkKind === "bluetooth" ? nodeDevice : null,
        bootloader: null,
        stage: "choose",
        sent: 0,
        why: "",
        stop: null,
    };
    offer = null;
    offerAsked = "";
    say("");
    client = null;
    await c.close();
    draw();
}

/** The bootloader, chosen in the browser's list (or the one chosen before), given the package. */
async function runDfu(again: boolean): Promise<void> {
    const job = booting;
    if (!job || job.stop) {
        return;
    }
    const stop = new AbortController();
    job.stop = stop;
    try {
        say(again && job.bootloader ? "Connecting to the bootloader…" : "Choose the node's bootloader in the browser's list.");
        const link = await openDfu(undefined, {}, again && job.bootloader ? job.bootloader : undefined);
        job.bootloader = link.device;
        say("");
        await sendPackage(link, job.pkg, {
            signal: stop.signal,
            onProgress: (p) => {
                job.stage = p.stage;
                job.sent = p.sent;
                drawBoot();
            },
        });
    } catch (e) {
        job.stop = null;
        if (booting !== job) {
            return; // stopped: what the stop said stands
        }
        if (e instanceof DOMException && e.name === "NotFoundError") {
            say(""); // the list closed without a choice: the button is still there
        } else {
            job.stage = "failed";
            const why = explain(e);
            job.why = `${why.charAt(0).toUpperCase()}${why.slice(1)}${why.endsWith(".") ? "" : "."}`;
            say("");
        }
        drawBoot();
        return;
    }
    job.stop = null;
    if (booting === job) {
        await confirmRelease(job);
    }
}

/** The bootloader started the image: the node is reached again, and asked what it runs. */
async function confirmRelease(job: BootJob): Promise<void> {
    if (!job.device) {
        booting = null;
        say(`Sent and checked: the node starts ${job.offer.release}. Connect to it again to see it does.`);
        draw();
        return;
    }
    job.stage = "reconnecting";
    drawBoot();
    // A few seconds for the node to start the firmware and advertise again.
    await new Promise((r) => setTimeout(r, 3000));
    const device = job.device;
    booting = null;
    await connect(() => openBluetooth(undefined, {}, device), "bluetooth", "Connecting to the node again…");
    const c = client;
    if (!c || c.closed || !c.ready || c.self?.address !== job.node) {
        say(`Sent and checked: the node starts ${job.offer.release}. Connect to it again to see it does.`);
    } else if (c.release === job.offer.release) {
        say(`Updated: the node runs ${c.release}.`);
    } else {
        say(`The node came back running ${c.release || "its old firmware"}, not ${job.offer.release}.`, true);
    }
}

function drawBoot(): void {
    const box = $("bootloader");
    box.replaceChildren();
    const job = booting;
    box.hidden = job === null;
    if (!job) {
        return;
    }
    const size = job.pkg.image.length;
    const percent = Math.floor((100 * job.sent) / size);
    const button = (text: string, primary: boolean, act: () => void) => {
        const b = el("button", { type: "button", class: primary ? "small primary" : "small" }, text);
        b.addEventListener("click", act);
        return b;
    };
    const giveUp = button("Stop", false, () => {
        job.stop?.abort();
        booting = null;
        say(
            job.stage === "choose"
                ? "Stopped. If the node does not start again by itself, press its reset button: it still has its firmware."
                : "Stopped. The node waits in its bootloader for firmware: update it here again, or over USB from the flash page.",
        );
        draw();
    });
    const facts = (text: string) => el("p", { class: "muted facts" }, text);
    box.append(el("h3", {}, `Updating ${job.name} to ${job.offer.release}`));
    switch (job.stage) {
        case "choose":
            box.append(
                facts(
                    "The node is restarting into its bootloader. Choose the bootloader in the browser's list now: its name ends in DFU, such as T114_DFU. Until the update finishes, anyone in Bluetooth range can install an image on the node, so do not leave it waiting.",
                ),
                el("p", { class: "actions" }, button("Choose the node's bootloader", true, () => void runDfu(false)), giveUp),
            );
            break;
        case "erasing":
            box.append(
                el("progress", {}),
                facts("The bootloader is erasing the old firmware, which takes up to a minute. Keep this page open and the node in reach."),
                el("p", { class: "actions" }, giveUp),
            );
            break;
        case "init":
        case "sending":
            box.append(
                el("progress", { max: String(size), value: String(job.sent) }),
                facts(`${percent}%. Keep this page open and the node in reach: it takes about five minutes.`),
                el("p", { class: "actions" }, giveUp),
            );
            break;
        case "checking":
        case "starting":
        case "done":
            box.append(el("progress", { max: "1", value: "1" }), facts("Sent. The bootloader is checking it and starting it."));
            break;
        case "reconnecting":
            box.append(facts("The node is starting the new firmware. Connecting to it again…"));
            break;
        case "failed":
            box.append(
                facts(
                    `${job.why} Nothing the node holds is lost: its bootloader waits for the firmware, and trying again goes from the start.`,
                ),
                el(
                    "p",
                    { class: "actions" },
                    button("Try again", true, () => void runDfu(true)),
                    button("Choose the bootloader again", false, () => void runDfu(false)),
                    giveUp,
                ),
            );
            break;
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
    /** The contact's wake, if it sleeps: a message sent to it is held until it wakes. */
    wake?: number;
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
        note: m.incoming
            ? ""
            : m.state === STATE.sent && m.wake
              ? `sent · it sleeps: held until it wakes, up to ${wakeText(m.wake)}`
              : stateText(m),
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
            el(
                "li",
                { class: "empty" },
                el("span", { class: "empty-art" }, icon("M4 5h16v11H9l-5 4z")),
                el("h3", {}, "No conversation open"),
                el("p", {}, "Choose one from the list, or add a contact or make a group to start one."),
            ),
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

/** Which folded parts of a conversation's head are open, by conversation: kept across redrawing. */
const unfolded = new Set<string>();

/** A part of a conversation's head that is folded away until asked for. */
function fold(key: string, summary: string, ...children: Child[]): HTMLDetailsElement {
    const id = `${key}/${summary}`;
    const d = el("details", unfolded.has(id) ? { open: "" } : {}, el("summary", {}, summary), ...children);
    d.addEventListener("toggle", () => {
        if (d.open) {
            unfolded.add(id);
        } else {
            unfolded.delete(id);
        }
    });
    return d;
}

/** The top of a conversation: back to the list on a phone, its avatar, its name and a line under it. */
function talkTitle(key: string, sub: string): HTMLElement {
    const back = el("button", { type: "button", class: "back", "aria-label": "Back to the chats" }, "‹ Chats");
    back.addEventListener("click", () => {
        selected = null;
        draw();
    });
    return el(
        "div",
        { class: "talk-title" },
        back,
        avatar(key),
        el("div", { class: "row-main" }, el("h2", {}, nameOf(key)), el("span", { class: "row-sub" }, sub)),
    );
}

/** The head of a group's conversation: what it is, what to know of it, and what can be done. */
function groupHead(id: string): void {
    const head = $("talk-head");
    const held = client?.groups.get(id);
    if (!held) {
        head.append(talkTitle(id, "This node is not in this group now. What was said is kept in this browser."));
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
        talkTitle(id, "Group · nothing says a message arrived"),
        fold(
            id,
            "Group details and invites",
            el(
                "p",
                { class: "muted" },
                "Everyone in a group holds the same key. Any of them can write under another's name, " +
                    "whoever is given the key can read all that was said, and nobody can be put out.",
            ),
            el("p", { class: "actions" }, whom.options.length > 0 && whom, whom.options.length > 0 && invite, code),
            el("p", { class: "actions" }, rename, leave),
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
    const code = codeOf(address);
    head.append(
        talkTitle(
            address,
            [
                contact?.session ? "Session open" : "No session yet",
                contact?.wake ? `Sleeps, wakes every ${wakeText(contact.wake)}` : "",
                code && `code ${code}`,
            ]
                .filter(Boolean)
                .join(" · "),
        ),
        fold(
            address,
            "Contact details",
            el("p", { class: "muted address" }, el("code", {}, address)),
            el(
                "p",
                { class: "muted" },
                contact?.session
                    ? "This node has a session with it."
                    : "No session yet: the first message makes first contact, directly or through relays.",
            ),
            el("p", { class: "actions" }, rename, remove ?? null, end || null),
        ),
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
        ...live.map((m) => shown({ ...m, incoming: m.state === STATE.received, wake: client?.contacts.get(address)?.wake ?? 0 })),
    );
    if (earlier.length + live.length === 0) {
        list.append(
            el(
                "li",
                { class: "empty" },
                el("h3", {}, "Nothing said yet"),
                el("p", {}, isGroup(address) ? "Write the group's first message below." : "Say hello below. The first message makes first contact."),
            ),
        );
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

/** Which tab shows, which is marked, and what each tab's badge says. */
function drawTabs(): void {
    for (const t of document.querySelectorAll<HTMLButtonElement>(".tabs .tab")) {
        if (t.dataset.tab === tab) {
            t.setAttribute("aria-current", "page");
        } else {
            t.removeAttribute("aria-current");
        }
    }
    $("pane-chats").hidden = tab !== "chats";
    $("pane-people").hidden = tab !== "people";
    $("pane-node").hidden = tab !== "node";
    // On a phone a conversation opens over the list, and Back closes it.
    $("pane-chats").classList.toggle("open", selected !== null);
    $("live").classList.toggle("talking", tab === "chats" && selected !== null);
    const unread = talks().reduce((n, key) => n + unreadOf(key), 0) + (client?.asked.size ?? 0);
    const total = $("unread-total");
    total.hidden = unread === 0;
    total.textContent = String(unread);
    $("update-dot").hidden = offer === null && updating === null;
}

/** The node's name, whether it is there, and its battery, at the head of every tab. */
function drawPill(): void {
    const c = client;
    $("pill-name").textContent = nodeTitle();
    $("pill-battery").textContent = c?.power && c.power.percent <= 100 ? `· ${c.power.percent}%` : "";
    const how = linkKind === "serial" ? "Over USB" : linkKind === "bluetooth" ? "Over Bluetooth" : "In this page";
    $("link-facts").textContent = `${how}${c?.firmware && !demo ? `, running ${c.firmware}` : ""}${c?.board ? ` on a ${nodeTitleOfBoard(c.board)}` : ""}.`;
}

function nodeTitleOfBoard(board: string): string {
    return boards.find((b) => b.name === board)?.title ?? board;
}

/** Shows a tab. */
function show(t: Tab): void {
    tab = t;
    draw();
    window.scrollTo({ top: 0 });
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
        $("turned-off").hidden = up || !turnedOff;
        $("live").hidden = !up || !client?.ready;
        $("demo-note").hidden = !up || !demo;
        $("console").hidden = !up || !hasConsole;
        drawBoot();
        drawTabs();
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
        // Not while an update is under way: the node would be left between two images.
        $("turn-off").hidden = !client.can("OFF") || (updating !== null && updating.node === client.self?.address);
        $("wipe").hidden = !client.can("WIPE") || (updating !== null && updating.node === client.self?.address);
        drawUpdate();
        drawSettings();
        drawCard();
        drawSleep();
        drawAsked();
        drawPill();
        drawTalks();
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

/**
 * Works out, once each, the routing ids of the addresses on the page, as the connected node makes
 * them: from the key blinded from each address for a node of version 14 or later, and from the
 * address itself before (draft/companion.md, "Starting").
 */
function learnIds(): void {
    const version = client?.version ?? 0;
    const blinded = version >= BLINDED_SINCE;
    if (blinded !== idsBlinded) {
        ids.clear();
        idsBlinded = blinded;
    }
    for (const address of people()) {
        if (!ids.has(address)) {
            ids.set(address, 0);
            routingIdFor(address, version).then(
                (id) => {
                    if (idsBlinded === blinded) {
                        ids.set(address, id);
                        draw();
                    }
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
    tab = "chats";
    draw();
    // Not on a phone, where focus would bring up the keyboard over the conversation.
    if (wide()) {
        requestAnimationFrame(() => $<HTMLInputElement>("text").focus());
    }
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
    bluetooth:
        "Choose the node in the browser's list. The first time, type in the passkey its screen shows; a node with no screen pairs only within 3 minutes of a press of its button or of being turned on.",
    demo: "",
};

async function connect(
    open: () => Promise<Transport> | Transport,
    by: keyof typeof CHOOSE,
    first: string = CHOOSE[by],
): Promise<void> {
    say(first);
    let transport: Transport;
    try {
        transport = await open();
    } catch (e) {
        // Closing the browser's list without choosing is not an error worth a red line.
        say(e instanceof DOMException && e.name === "NotFoundError" ? "" : explain(e), true);
        return;
    }
    demo = by === "demo";
    linkKind = by;
    nodeDevice = by === "bluetooth" ? ((transport as BluetoothTransport).device ?? null) : null;
    turnedOff = false;
    hasConsole = by === "serial";
    selected = null;
    shownCode = null;
    history = null;
    historyNode = "";
    ids.clear();
    settingsShown = "";
    cardShown = "";
    sleepShown = "";
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
 * Turns the node off, once the user has been told that only the node itself turns it on again.
 * Once it says OK the connection is closed, and the page does not try to reach it again: the gate
 * says it is off, and its buttons connect again when the user asks.
 */
async function turnOff(c: Client): Promise<void> {
    const sure = window.confirm(
        "Turn this node off? Only the node itself turns it on again: its button, its reset or its power. " +
            "Until then it sends and receives nothing, and neither this page nor an app can reach it.",
    );
    if (!sure) {
        return;
    }
    try {
        await c.turnOff();
    } catch (e) {
        if (!(e instanceof Refused && e.code === 0)) {
            say(explain(e), true); // refused, and still on
            return;
        }
        // No answer: a node that is already off does not answer, and is taken as gone.
        await c.close();
        if (client === c) {
            client = null;
        }
        say("The node did not answer, and may be off already. Connect to it again once it is on.", true);
        draw();
        return;
    }
    if (client === c) {
        client = null;
    }
    turnedOff = true;
    say("");
    draw();
}

/**
 * Erases the node (WIPE), once the user has been told what goes for good. Once it says OK, the
 * page forgets everything it holds for the node, and the browser's permission for it; the
 * operating system's pairing the page cannot remove, and says so.
 */
async function wipe(c: Client): Promise<void> {
    const node = c.self?.address;
    const sure = window.confirm(
        "Erase this node? This cannot be undone.\n\n" +
            "Its address, contacts, groups, messages, sessions, settings and Bluetooth pairings are erased for good. " +
            "It restarts as a new node with a new address: everyone who had it as a contact must add it again, " +
            "and you must pair with it again.",
    );
    if (!sure || !window.confirm("Erase it now? Everything on the node goes for good.")) {
        return;
    }
    try {
        await c.wipe();
    } catch (e) {
        say(
            e instanceof Refused && e.code === 8
                ? "The node cannot erase itself just now. Try again in a moment."
                : e instanceof Refused && e.code === 0
                  ? "The node did not answer. It may have erased itself: connect to it again to see."
                  : explain(e),
            true,
        );
        return;
    }
    // The node it was is gone: forget what this page held for it.
    if (node) {
        History.forget(node, local());
    }
    history = null;
    historyNode = "";
    ids.clear();
    offer = null;
    offerAsked = "";
    const device = nodeDevice as (Device & { forget?: () => Promise<void> }) | null;
    nodeDevice = null;
    await device?.forget?.().catch(() => {});
    if (client === c) {
        client = null;
    }
    say(
        linkKind === "bluetooth"
            ? "Erased: the node restarts as a new one. Remove it from your computer's or phone's Bluetooth settings too, then connect to it again and pair."
            : "Erased: the node restarts as a new one, with a new address.",
    );
    draw();
}

/**
 * Applies the settings that differ from the node's, one at a time: the region first, since what
 * power is allowed depends on it. A node restarts to apply each, so each is followed by starting
 * the connection again.
 */
async function applySettings(c: Client, useMostPower = false): Promise<void> {
    const self = c.self;
    if (!self) {
        return;
    }
    const region = $<HTMLSelectElement>("set-region").value;
    const power = useMostPower ? POWER_MOST : Number($<HTMLInputElement>("set-power").value);
    const role = Number($<HTMLSelectElement>("set-role").value);
    const changes: [setting: "region" | "power" | "role", value: number | string][] = [];
    // The GPS receiver: applied first, and with nothing to wait for, since it changes nothing on the air.
    const receiver = receiverSettable(c) ? $<HTMLInputElement>("set-receiver").checked : null;
    const receiverChanged = receiver !== null && receiver !== (c.fix!.receiver !== RECEIVER.off);
    if (region !== self.region) {
        changes.push(["region", region]);
    }
    if (useMostPower || power !== self.power) {
        changes.push(["power", power]);
    }
    if (role !== self.role) {
        changes.push(["role", role]);
    }
    if (changes.length === 0 && !receiverChanged) {
        say("Nothing to change.");
        return;
    }
    // Nothing else is asked of a board that is about to restart: a request it took just before
    // would be lost with it, and one it never answered would hold up the HELLO after.
    const live = $("live");
    live.inert = true;
    live.classList.add("busy");
    try {
        if (receiver !== null && receiverChanged) {
            await c.setReceiver(receiver);
        }
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
    for (const t of document.querySelectorAll<HTMLButtonElement>(".tabs .tab")) {
        t.addEventListener("click", () => show(t.dataset.tab as Tab));
    }
    $("node-pill").addEventListener("click", () => show("node"));
    $("new-contact").addEventListener("click", () => {
        show("people");
        $<HTMLInputElement>("add-address").focus();
    });
    $("new-group").addEventListener("click", () => {
        show("people");
        const make = $("group-add");
        (make.hidden ? $("groups-card") : $<HTMLInputElement>("group-name")).focus();
        $("groups-card").scrollIntoView({ block: "start" });
    });
    $("status-close").addEventListener("click", () => say(""));
    $("turn-off").addEventListener("click", () => {
        if (client) {
            void turnOff(client);
        }
    });
    $("wipe").addEventListener("click", () => {
        if (client) {
            void wipe(client);
        }
    });
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
    $("set-power-most").addEventListener("click", () => {
        if (client) {
            void applySettings(client, true);
        }
    });

    $<HTMLFormElement>("card-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (client) {
            void applyCard(client);
        }
    });

    $<HTMLFormElement>("sleep-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (client) {
            void applySleep(client);
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
        tab = "people";
    }
    // A join code's page (/G) hands its code here in the tab's own storage, never in a link, to be
    // joined from once a node is connected and the user says so; it is taken from there at once.
    // A page of before put it after a #, which leaves the address bar at once.
    let handed: string | null = null;
    try {
        handed = window.sessionStorage.getItem("tern.join");
        window.sessionStorage.removeItem("tern.join");
    } catch {
        // No storage for the tab: nothing was handed over.
    }
    if (location.hash.startsWith("#join=")) {
        handed = decodeURIComponent(location.hash.slice("#join=".length));
        window.history.replaceState(null, "", location.pathname + location.search);
    }
    if (handed) {
        $<HTMLInputElement>("join-code").value = handed;
        tab = "people";
        say("Connect your node, then press Join under Groups.");
    }
    if (new URLSearchParams(location.search).has("demo")) {
        void connect(openDemo, "demo");
    }
}

start();
