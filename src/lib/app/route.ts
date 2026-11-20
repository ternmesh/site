// How a message went, traces, and a range test (version 18 of draft/companion.md), in the user's
// words: the line under each message, the details behind it, what a trace found, and a range
// test's log. Nothing here touches the page: routing ids are named by whatever the caller passes,
// and the range test is told the time, the fix and what the node answered.

import { STATE, TRACE_RESULT } from "../companion/protocol.ts";
import type { Message, Route, Trace, Traced } from "../companion/client.ts";
import { answered } from "../companion/client.ts";
import { routingIdText } from "../companion/ids.ts";

/** The version that says how messages went, and traces. */
export const ROUTE_SINCE = 18;

/** Names a routing id the page knows, or gives null. */
export type Namer = (id: number) => string | null;

/** A routing id named, or as its eight hex digits. */
export function label(name: Namer, id: number): string {
    return name(id) ?? routingIdText(id);
}

/** What the page knows of a message, for the words: whether it came in, its state, and where it went. */
export interface Went {
    incoming: boolean;
    state: number;
    /** A group message: one written to a group, not an invite. */
    groupMessage: boolean;
    /** The routing id of the contact it was sent to, if the page knows it. */
    to: number | null;
}

/** A Message as Went, given the routing id of whom it is with. */
export function wentOf(m: Pick<Message, "state" | "group" | "invite">, to: number | null): Went {
    return { incoming: m.state === STATE.received, state: m.state, groupMessage: m.group !== "" && !m.invite, to };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A signal-to-noise ratio in quarters of a dB, in dB: "6.5 dB". */
export function snrDb(quarters: number): string {
    return `${(quarters / 4).toFixed(1)} dB`;
}
/** "SNR 6.5 dB". */
export function snrText(quarters: number): string {
    return `SNR ${snrDb(quarters)}`;
}
/** Milliseconds as seconds, to a tenth: "3.1 s". */
export function tookText(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}
/** How many hops: "Direct" for one, else "3 hops". */
function hopsText(hops: number): string {
    return hops === 1 ? "Direct" : plural(hops, "hop", "hops");
}
/** How many hops a sent message's acknowledgement came back: "reply direct", "reply 2 hops". */
function replyText(hops: number): string {
    return hops === 1 ? "reply direct" : `reply ${plural(hops, "hop", "hops")}`;
}

/**
 * The line under a message that says how it went, from its route: null with none, or nothing to
 * say yet. Received, how many hops it came and how well the last was heard; a group message came
 * at most that far. Sent, the neighbour it went to and, once delivered, the hops and round trip of
 * the acknowledgement's way back.
 */
export function routeLine(m: Went, route: Route | undefined, name: Namer): string | null {
    if (!route) {
        return null;
    }
    if (m.incoming) {
        if (route.hops === 0) {
            return null;
        }
        const hops = m.groupMessage && route.hops > 1 ? `≤${plural(route.hops, "hop", "hops")}` : hopsText(route.hops);
        return `${hops} · ${snrText(route.snr)}`;
    }
    if (m.groupMessage) {
        return route.goes > 0 ? (route.goes === 1 ? "Went out once" : `Went out ${route.goes} times`) : null;
    }
    if (route.via === 0) {
        return null;
    }
    const direct = route.via === m.to;
    const via = label(name, route.via);
    const parts: string[] = [];
    switch (m.state) {
        case STATE.delivered:
            parts.push(direct ? "Delivered direct" : `Delivered via ${via}`);
            // The hops are the acknowledgement's, back: not how the message went out.
            if (route.hops > 0 && !(direct && route.hops === 1)) {
                parts.push(replyText(route.hops));
            }
            if (route.took > 0) {
                parts.push(tookText(route.took));
            }
            break;
        case STATE.notDelivered:
            parts.push(direct ? "Last tried direct" : `Last tried via ${via}`);
            if (route.goes > 0) {
                parts.push(plural(route.goes, "try", "tries"));
            }
            break;
        default:
            parts.push(direct ? "Sent direct" : `Sent via ${via}`);
            if (route.goes > 1) {
                parts.push(`try ${route.goes}`);
            }
    }
    return parts.join(" · ");
}

/**
 * Every field of a route, each as a label and what it says, for the details behind a message, in
 * plain words; and, after them, what to bear in mind reading them.
 */
export function routeFacts(m: Went, route: Route | undefined, name: Namer): { facts: [string, string][]; notes: string[] } {
    const facts: [string, string][] = [];
    const notes: string[] = [];
    if (!route) {
        notes.push(
            "Your node hasn't said how this one went. It keeps that only for messages since its firmware could, and may lose it when it restarts.",
        );
        return { facts, notes };
    }
    const signal = () => {
        facts.push(["Signal-to-noise of the last hop", snrDb(route.snr)]);
        facts.push(["Signal strength of the last hop", `${route.rssi} dBm`]);
    };
    if (m.incoming) {
        const relays = route.hops - 1;
        facts.push([
            "Came",
            route.hops === 0
                ? "Not known"
                : route.hops === 1
                  ? "Straight from the other node: 1 hop"
                  : m.groupMessage
                    ? `At most ${plural(route.hops, "hop", "hops")}: ${route.hops} or ${relays}`
                    : `${route.hops} hops: ${plural(relays, "relay", "relays")} passed it on`,
        ]);
        if (route.hops > 0) {
            signal();
        }
        if (m.groupMessage) {
            notes.push("A group message's writer hides how far off it is, so it may have come one hop less than this.");
        }
        notes.push("No message names the relays that passed it on. A trace does: Trace route, in the chat's Contact details.");
        return { facts, notes };
    }
    if (m.groupMessage) {
        facts.push(["Sent out", route.goes === 1 ? "once" : `${route.goes} times`]);
        return { facts, notes };
    }
    facts.push([
        "First went to",
        route.via === 0
            ? "Nowhere yet"
            : route.via === m.to
              ? `Straight to ${label(name, route.via)}`
              : name(route.via) !== null
                ? `${name(route.via)} (${routingIdText(route.via)})`
                : routingIdText(route.via),
    ]);
    facts.push(["Tries on the air", String(route.goes)]);
    if (m.state === STATE.delivered && route.hops > 0) {
        facts.push(["Acknowledgement came back", hopsText(route.hops)]);
        signal();
        facts.push(["Round trip", tookText(route.took)]);
        notes.push(
            "The hops and signal are the acknowledgement's, on its way back. The other node sends it by its own route: most often through the same relays, but not always.",
        );
    } else {
        notes.push("Hops, signal and round trip come once it's delivered, from the acknowledgement on its way back.");
    }
    return { facts, notes };
}

// ----- Traces -----

export const TRACE_NEEDS_UPDATE = "Update the node's firmware to trace";
export const LEAF_HINT = "Handhelds (leaves) answer traces only from nodes they have a secure session with.";
export const TRACE_DISCLAIMER =
    "A trace shows the way frames went just then; the next message may go another way. Relays on the way can misreport it, and nothing checks what they add.";

/** What a trace does, before it is run. */
export function traceExplained(target: string): string {
    return `A trace goes out to ${target} the way your node's messages would, and comes back. Each node on the way adds itself, and how well it heard the one before.`;
}

/**
 * How a trace to `target` ended, in a sentence: who answered, or how far it got, or that it did not
 * go. The node that answered is the last on the way out. `leaf`: the node traced to is a neighbour
 * the node hears as a leaf, which drops a trace from a node it shares no session with, on purpose.
 */
export function traceResultText(t: Traced, target: string, name: Namer, leaf: boolean): string {
    const last = t.wayOut[t.wayOut.length - 1];
    const answerer = last ? label(name, last.routingId) : "a relay";
    switch (t.result) {
        case TRACE_RESULT.answered:
            return `Answered by ${target}`;
        case TRACE_RESULT.keeper:
            return `Answered by ${answerer}, which keeps ${target}'s messages while it sleeps: that's as far as they go until it wakes`;
        case TRACE_RESULT.noRoute:
            return `Got as far as ${answerer}, which has no route to ${target}`;
        case TRACE_RESULT.notAnswered:
            // Not that it may be out of reach: a leaf drops it unless it shares a session with this node.
            return leaf ? `No answer from ${target}. ${LEAF_HINT}` : `No answer in time. ${target} may be out of reach, or a relay on the way may not pass traces on.`;
        case TRACE_RESULT.notBegun:
            return `Not begun: your node has no route to ${target}`;
        default:
            return `Ended (${t.result})`;
    }
}

/** A trace answered, in numbers: "2 hops out · 1 hop back · 3.1 s". The way back ends at this node. */
export function traceSummary(t: Traced): string {
    const back = t.wayBack.length + 1;
    return [plural(t.wayOut.length, "hop out", "hops out"), plural(back, "hop back", "hops back"), tookText(t.took)].join(" · ");
}

const WAITING_FOR: Record<number, string> = {
    3: "the region's transmit limit",
    4: "the airtime budget",
    5: "the radio is busy",
};

/** Where a trace is before it ends: asking the node, waiting and what for, or out and waiting for an answer. */
export function traceStepText(t: Trace): string {
    if (t.id === null) {
        return "Handing it to your node…";
    }
    if (t.state === STATE.sent) {
        return "Out: waiting for the answer…";
    }
    if (t.state === STATE.waiting && t.reason === 1) {
        return "Finding a route…";
    }
    if (t.state === STATE.waiting && t.reason >= 3) {
        const base = `Waiting for ${WAITING_FOR[t.reason] ?? WAITING_FOR[5]}`;
        return t.wait > 0 ? `${base} · about ${t.wait} s` : base;
    }
    return "Waiting to go…";
}

export { answered };

/** Whether the node with routing id `id` is a neighbour the node hears as a leaf. */
export function isLeaf(neighbours: ReadonlyMap<number, { role: number }>, id: number): boolean {
    return neighbours.get(id)?.role === 0;
}

/**
 * Whether a trace from this node to `id` will not be answered: a neighbour that is a leaf, which
 * answers traces only from a node it shares a session with, and shares none with this one
 * (`session`: whether the contact with that routing id has one). A leaf that is not a neighbour is
 * not known to be one.
 */
export function leafWithoutSession(neighbours: ReadonlyMap<number, { role: number }>, id: number, session: boolean): boolean {
    return isLeaf(neighbours, id) && !session;
}

// ----- A range test -----

/** Where the browser was: degrees, and how exact, in metres, null for unknown; `age` seconds old. */
export interface PhoneFix {
    lat: number;
    lon: number;
    accuracy: number | null;
    age: number;
}

/** Why a ping did not reach the node as a message. */
export type Unsent = "not_connected" | "refused" | "unanswered";

/**
 * One ping: its number, when it was due by the browser's clock (milliseconds since 1970), the fix
 * the browser had then, and the message it became, by `id`, once the node said or a sync showed
 * it. `after` is the greatest id the node held when it went, for that match.
 */
export interface RangePing {
    n: number;
    at: number;
    text: string;
    fix: PhoneFix | null;
    after: number;
    id: number | null;
    unsent: Unsent | null;
}

/** A ping as what the node holds leaves it now: its message's state and route, null for none yet. */
export interface RangeRow {
    ping: RangePing;
    state: number | null;
    route: Route | null;
}

export const RANGE_TEXT = "range #";
export const RANGE_MIN_MS = 30_000;
export const RANGE_MAX_MS = 60_000;
export const RANGE_DEFAULT_MS = 30_000;

/**
 * A range test: numbered messages, "range #1", "range #2" and on, to one contact every so often,
 * each logged with where the browser was when it went and, from what the node holds, what became
 * of it. That is read whenever it is asked for, not copied: a ROUTE or a STATE that comes later,
 * even after the link dropped and came back, is in the next row. The page runs its clock.
 */
export class RangeTest {
    readonly to: string;
    readonly intervalMs: number;
    readonly startedAt: number;
    private readonly list: RangePing[] = [];

    constructor(to: string, intervalMs: number, startedAt: number) {
        if (!(intervalMs >= RANGE_MIN_MS && intervalMs <= RANGE_MAX_MS)) {
            throw new Error(`a ping every 30 to 60 s, not ${intervalMs} ms`);
        }
        this.to = to;
        this.intervalMs = intervalMs;
        this.startedAt = startedAt;
    }

    get pings(): readonly RangePing[] {
        return this.list;
    }

    /** When the next ping is due, by the browser's clock. The first goes at once. */
    get nextAt(): number {
        return this.startedAt + this.list.length * this.intervalMs;
    }

    /** The next ping, due now: logged at once, with its fix, and why it cannot go if it cannot. */
    next(at: number, fix: PhoneFix | null, after: number, unsent: Unsent | null = null): RangePing {
        const n = this.list.length + 1;
        const p: RangePing = { n, at, text: `${RANGE_TEXT}${n}`, fix, after, id: null, unsent };
        this.list.push(p);
        return p;
    }

    /** The node took ping `n` as the message `id`. */
    queued(n: number, id: number): void {
        const p = this.list.find((x) => x.n === n);
        if (p) {
            p.id = id;
            p.unsent = null;
        }
    }

    /** Ping `n` did not reach the node as a message. */
    unsent(n: number, why: Unsent): void {
        const p = this.list.find((x) => x.n === n);
        if (p && p.id === null) {
            p.unsent = why;
        }
    }

    /**
     * Pings the node did not answer for, matched against what it holds: a message to `to` with the
     * ping's text, past what it held when the ping went, is the ping, and it went.
     */
    resolve(messages: Iterable<Message>): boolean {
        let changed = false;
        const all = [...messages];
        for (const p of this.list) {
            if (p.id !== null || p.unsent !== "unanswered") {
                continue;
            }
            const match = all.find((m) => m.id > p.after && m.contact === this.to && m.state !== STATE.received && m.group === "" && m.text === p.text);
            if (match) {
                p.id = match.id;
                p.unsent = null;
                changed = true;
            }
        }
        return changed;
    }
}

/** Each ping as what the node holds leaves it now. */
export function rangeRows(pings: readonly RangePing[], messages: ReadonlyMap<number, Message>, routes: ReadonlyMap<number, Route>): RangeRow[] {
    return pings.map((p) => ({
        ping: { ...p },
        state: p.id === null ? null : (messages.get(p.id)?.state ?? null),
        route: p.id === null ? null : (routes.get(p.id) ?? null),
    }));
}

/** How many were delivered, of those the node took. */
export function rangeTally(rows: readonly RangeRow[]): { delivered: number; sent: number } {
    return { delivered: rows.filter((r) => r.state === STATE.delivered).length, sent: rows.filter((r) => r.ping.id !== null).length };
}

/** What became of a ping, in one word a spreadsheet can filter on. */
export function rangeResult(r: RangeRow): string {
    if (r.ping.unsent) {
        return r.ping.unsent;
    }
    if (r.ping.id === null) {
        return "asking";
    }
    switch (r.state) {
        case STATE.delivered:
            return "delivered";
        case STATE.notDelivered:
            return "not_delivered";
        case STATE.sent:
            return "sent";
        case STATE.waiting:
            return "waiting";
        default:
            return "unknown";
    }
}

/** One ping, as the log shows it: what became of it, and how, when the node says. */
export function rangeRowText(r: RangeRow, name: Namer): string {
    const p = r.ping;
    const route = r.route;
    const parts: string[] = [];
    parts.push(
        p.unsent === "not_connected"
            ? "Not sent: node not connected"
            : p.unsent === "refused"
              ? "Not sent: the node refused it"
              : p.unsent === "unanswered"
                ? "The node didn't answer"
                : p.id === null
                  ? "Handing it to your node…"
                  : r.state === STATE.delivered
                    ? "Delivered"
                    : r.state === STATE.notDelivered
                      ? "Not delivered"
                      : r.state === STATE.sent
                        ? "Sent"
                        : "Waiting",
    );
    if (route && r.state === STATE.delivered && route.hops > 0) {
        parts.push(hopsText(route.hops), snrText(route.snr), `${route.rssi} dBm`);
        if (route.took > 0) {
            parts.push(tookText(route.took));
        }
    }
    if (route && route.via !== 0) {
        parts.push(`via ${label(name, route.via)}`);
    }
    return parts.join(" · ");
}

/** Where the browser was for a ping, in words. */
export function fixText(fix: PhoneFix | null): string {
    if (!fix) {
        return "no fix";
    }
    const at = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;
    return fix.accuracy === null ? at : `${at} ±${Math.round(fix.accuracy)} m`;
}

/** A time as ISO 8601 with the offset of the zone it is read in: what a spreadsheet takes. */
function isoLocal(ms: number, offsetMinutes: number): string {
    const d = new Date(ms - offsetMinutes * 60_000);
    const sign = offsetMinutes <= 0 ? "+" : "-";
    const off = Math.abs(offsetMinutes);
    const hh = String(Math.floor(off / 60)).padStart(2, "0");
    const mm = String(off % 60).padStart(2, "0");
    return `${d.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/** A field quoted only when it has to be: a comma, a quote or a line break in it. */
function csvField(s: string): string {
    return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The log as CSV, one line each after a header, for a spreadsheet or a map: times in ISO 8601 with
 * the browser's offset (`offset` is Date's getTimezoneOffset for each time), positions in degrees,
 * SNR in dB, RSSI in dBm and the round trip in seconds; a field with nothing to say is empty.
 * Hops, signal and round trip are the acknowledgement's: nothing until it is delivered.
 */
export function rangeCsv(
    rows: readonly RangeRow[],
    to: string,
    name: Namer,
    offset: (ms: number) => number = (ms) => new Date(ms).getTimezoneOffset(),
): string {
    let out = "n,time,lat,lon,accuracy_m,fix_age_s,to,message_id,result,hops,snr_db,rssi_dbm,round_trip_s,tries,via_id,via\n";
    for (const r of rows) {
        const p = r.ping;
        const route = r.route;
        const back = route && r.state === STATE.delivered && route.hops > 0 ? route : null;
        const via = route && route.via !== 0 ? route.via : null;
        const fields = [
            String(p.n),
            isoLocal(p.at, offset(p.at)),
            p.fix ? p.fix.lat.toFixed(7) : "",
            p.fix ? p.fix.lon.toFixed(7) : "",
            p.fix?.accuracy != null ? p.fix.accuracy.toFixed(0) : "",
            p.fix ? String(p.fix.age) : "",
            to.slice(0, 8),
            p.id === null ? "" : String(p.id),
            rangeResult(r),
            back ? String(back.hops) : "",
            back ? (back.snr / 4).toFixed(2) : "",
            back ? String(back.rssi) : "",
            route && route.took > 0 ? (route.took / 1000).toFixed(3) : "",
            route && route.goes > 0 ? String(route.goes) : "",
            via === null ? "" : routingIdText(via),
            via === null ? "" : (name(via) ?? ""),
        ];
        out += fields.map(csvField).join(",") + "\n";
    }
    return out;
}
