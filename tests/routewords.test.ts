// Version 18 in the page's words: the line under each message and the details behind it, a trace,
// what this browser keeps of each message's route, and the range test's log (src/lib/app/route.ts,
// as the Android app's RouteWords and RangeTest say them).
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "../src/lib/companion/client.ts";
import type { Message, Route, Traced } from "../src/lib/companion/client.ts";
import { History } from "../src/lib/app/history.ts";
import {
    RangeTest,
    leafWithoutSession,
    rangeCsv,
    rangeRowText,
    rangeRows,
    rangeTally,
    routeFacts,
    routeLine,
    traceResultText,
    traceStepText,
    traceSummary,
} from "../src/lib/app/route.ts";
import type { Namer, Went } from "../src/lib/app/route.ts";
import { STATE, VERSION, decode } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";
import { Wire } from "./wire.ts";

const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const RELAY = 0x1d2e3f40;
const BOBS = 0x2dc93414;
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

async function upWith(wire: Wire, c: Client, news: [string, Fields][]): Promise<void> {
    const up = c.start();
    const hello = decode(await wire.next())!;
    wire.say("INFO", hello.seq, { version: VERSION, firmware: "test", board: "heltec-v3", release: "0.7.0", update: 1 });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    news.forEach(([type, fields], i) => wire.say(type, i, fields));
    wire.say("SYNCED", sync.seq, { news: news.length });
    await up;
}
const message = (id: number, text: string, state: number = STATE.received, time = 1_790_000_000 + id): [string, Fields] => [
    "MESSAGE",
    { id, contact: BOB, time, flags: 0, state, reason: 0, wait: 0, text },
];
const route = (id: number, hops: number, via = 0, goes = 0, took = 0): [string, Fields] => ["ROUTE", { id, hops, snr: 19, rssi: -101, via, goes, took }];

test("this browser keeps each message's route with it, and lets it go with the message", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, [message(17, "one"), route(17, 1), message(18, "two", STATE.delivered), route(18, 2, RELAY, 1, 3120)]);
    const s = new Map<string, string>();
    const storage = { getItem: (k: string) => s.get(k) ?? null, setItem: (k: string, x: string) => void s.set(k, x) };
    const h = new History("node", storage);
    h.absorb(c.messages.values(), c.routes);
    // A later ROUTE for a message kept replaces the one kept.
    wire.say("ROUTE", 5, { id: 17, hops: 2, snr: -8, rssi: -110, via: 0, goes: 0, took: 0 });
    h.absorb(c.messages.values(), c.routes);
    const back = new History("node", storage);
    assert.deepEqual(
        back.kept.map((k) => [k.id, k.route?.hops, k.route?.via]),
        [
            [17, 2, 0],
            [18, 2, RELAY],
        ],
    );
    // A node that restarted holds the message but said nothing of how it went: this browser did.
    assert.equal(back.routeOf(c.messages.get(18)!)?.took, 3120);
    // The node has forgotten them: what the page shows from here keeps its route.
    assert.deepEqual(back.earlier(BOB, []).map((k) => k.route?.took), [0, 3120]);
    back.forgotten(BOB, 17);
    assert.deepEqual(new History("node", storage).kept.map((k) => k.id), [18]);
    // A route that is not one is not read back.
    s.set("tern.history.bad", JSON.stringify([{ id: 1, contact: BOB, time: 1, incoming: true, state: 4, text: "x", route: { hops: "2" } }]));
    assert.equal(new History("bad", storage).kept[0]?.route, undefined);
    await c.close();
});

// ----- The words -----

const names: Record<number, string> = { [RELAY]: "Hilltop", [BOBS]: "Bob" };
const name: Namer = (id) => names[id] ?? null;
const r = (hops: number, snr: number, rssi: number, via: number, goes: number, took: number): Route => ({ hops, snr, rssi, via, goes, took });
const got: Went = { incoming: true, state: STATE.received, groupMessage: false, to: null };
const sentAs = (state: number): Went => ({ incoming: false, state, groupMessage: false, to: BOBS });

test("the line under a message received: direct or relayed, and a group message at most that far", () => {
    assert.equal(routeLine(got, r(1, 26, -71, 0, 0, 0), name), "Direct · SNR 6.5 dB");
    assert.equal(routeLine(got, r(2, 19, -101, 0, 0, 0), name), "2 hops · SNR 4.8 dB");
    assert.equal(routeLine(got, r(3, -38, -112, 0, 0, 0), name), "3 hops · SNR -9.5 dB");
    assert.equal(routeLine(got, r(0, 0, 0, 0, 0, 0), name), null, "nothing known");
    assert.equal(routeLine(got, undefined, name), null, "no ROUTE: a node of version 17, or one that kept none");
    const group: Went = { ...got, groupMessage: true };
    assert.equal(routeLine(group, r(2, 19, -101, 0, 0, 0), name), "≤2 hops · SNR 4.8 dB");
    assert.equal(routeLine(group, r(1, -9, -117, 0, 0, 0), name), "Direct · SNR -2.3 dB");
    const { facts, notes } = routeFacts(group, r(2, 19, -101, 0, 0, 0), name);
    assert.equal(facts[0]![1], "At most 2 hops: 2 or 1");
    assert.ok(notes[0]!.startsWith("A group message's writer hides how far off it is"));
    assert.equal(routeLine({ ...group, incoming: false, state: STATE.sent }, r(0, 0, 0, 0, 2, 0), name), "Went out 2 times");
});

test("the line under a message sent: the neighbour it went to, and the reply's hops", () => {
    const delivered = sentAs(STATE.delivered);
    assert.equal(routeLine(delivered, r(2, 22, -98, RELAY, 2, 19_640), name), "Delivered via Hilltop · reply 2 hops · 19.6 s");
    assert.equal(routeLine(delivered, r(2, 22, -98, RELAY, 1, 3_120), () => null), "Delivered via 1d2e3f40 · reply 2 hops · 3.1 s");
    assert.equal(routeLine(delivered, r(1, 30, -60, BOBS, 1, 1_200), name), "Delivered direct · 1.2 s");
    assert.equal(routeLine(delivered, r(2, 30, -60, BOBS, 1, 1_200), name), "Delivered direct · reply 2 hops · 1.2 s");
    // Through a relay, and the acknowledgement straight back: no contradiction.
    assert.equal(routeLine(delivered, r(1, 30, -60, RELAY, 1, 300), name), "Delivered via Hilltop · reply direct · 0.3 s");
    assert.equal(routeLine(sentAs(STATE.sent), r(0, 0, 0, RELAY, 1, 0), name), "Sent via Hilltop");
    assert.equal(routeLine(sentAs(STATE.sent), r(0, 0, 0, RELAY, 2, 0), name), "Sent via Hilltop · try 2");
    assert.equal(routeLine(sentAs(STATE.waiting), r(0, 0, 0, BOBS, 1, 0), name), "Sent direct");
    assert.equal(routeLine(sentAs(STATE.notDelivered), r(0, 0, 0, RELAY, 4, 0), name), "Last tried via Hilltop · 4 tries");
    assert.equal(routeLine(sentAs(STATE.waiting), r(0, 0, 0, 0, 0, 0), name), null, "gone nowhere yet");
});

test("the details say every field", () => {
    const { facts, notes } = routeFacts(sentAs(STATE.delivered), r(2, 22, -98, RELAY, 2, 19_640), name);
    assert.deepEqual(facts, [
        ["First went to", "Hilltop (1d2e3f40)"],
        ["Tries on the air", "2"],
        ["Acknowledgement came back", "2 hops"],
        ["Signal-to-noise of the last hop", "5.5 dB"],
        ["Signal strength of the last hop", "-98 dBm"],
        ["Round trip", "19.6 s"],
    ]);
    assert.ok(notes[0]!.startsWith("The hops and signal are the acknowledgement's"));
    const came = routeFacts(got, r(3, -38, -112, 0, 0, 0), name);
    assert.equal(came.facts[0]![1], "3 hops: 2 relays passed it on");
    assert.ok(came.notes.at(-1)!.startsWith("No message names the relays"));
    assert.equal(routeFacts(sentAs(STATE.sent), r(0, 0, 0, BOBS, 1, 0), name).facts[0]![1], "Straight to Bob");
    assert.equal(routeFacts(sentAs(STATE.sent), r(0, 0, 0, RELAY, 1, 0), () => null).facts[0]![1], "1d2e3f40", "an id is not named by itself");
    assert.ok(routeFacts(got, undefined, name).notes[0]!.startsWith("Your node hasn't said how this one went."));
});

test("a trace in words, and a leaf with no session, which drops it", () => {
    const hop = (routingId: number, snr = 20) => ({ routingId, snr });
    const ok: Traced = { result: 0, wayOut: [hop(RELAY), hop(BOBS)], wayBack: [hop(RELAY)], snr: 26, took: 3_120 };
    assert.equal(traceResultText(ok, "Bob", name, false), "Answered by Bob");
    assert.equal(traceSummary(ok), "2 hops out · 2 hops back · 3.1 s");
    const keeper: Traced = { ...ok, result: 1, wayOut: [hop(RELAY)], wayBack: [] };
    assert.equal(
        traceResultText(keeper, "Bob", name, false),
        "Answered by Hilltop, which keeps Bob's messages while it sleeps: that's as far as they go until it wakes",
    );
    assert.equal(traceResultText({ ...keeper, result: 2 }, "Bob", name, false), "Got as far as Hilltop, which has no route to Bob");
    const none: Traced = { result: 3, wayOut: [], wayBack: [], snr: 0, took: 0 };
    assert.equal(
        traceResultText(none, "Bob", name, false),
        "No answer in time. Bob may be out of reach, or a relay on the way may not pass traces on.",
    );
    assert.equal(
        traceResultText(none, "Bob", name, true),
        "No answer from Bob. Handhelds (leaves) answer traces only from nodes they have a secure session with.",
    );
    assert.equal(traceResultText({ ...none, result: 4 }, "30313233", name, false), "Not begun: your node has no route to 30313233");

    const neighbours = new Map([
        [BOBS, { role: 0 }],
        [RELAY, { role: 1 }],
    ]);
    assert.equal(leafWithoutSession(neighbours, BOBS, false), true, "a leaf, and no session");
    assert.equal(leafWithoutSession(neighbours, BOBS, true), false, "a session: it answers");
    assert.equal(leafWithoutSession(neighbours, RELAY, false), false, "a relay answers anyone");
    assert.equal(leafWithoutSession(neighbours, 0x30313233, false), false, "not a neighbour: not known to be a leaf");
});

test("where a trace is", () => {
    const t = { to: BOBS, id: null, state: null, reason: 0, wait: 0, ended: null, failed: null };
    assert.equal(traceStepText(t), "Handing it to your node…");
    assert.equal(traceStepText({ ...t, id: 20, state: STATE.waiting, reason: 1 }), "Finding a route…");
    assert.equal(traceStepText({ ...t, id: 20, state: STATE.waiting, reason: 4, wait: 12 }), "Waiting for the airtime budget · about 12 s");
    assert.equal(traceStepText({ ...t, id: 20, state: STATE.sent }), "Out: waiting for the answer…");
    assert.equal(traceStepText({ ...t, id: 20 }), "Waiting to go…");
});

// ----- The range test -----

const msg = (id: number, text: string, state: number): Message => ({
    id,
    contact: BOB,
    group: "",
    from: 0,
    invite: false,
    time: 0,
    read: false,
    state,
    reason: 0,
    wait: 0,
    text,
});

test("a range test: numbered pings every 30 to 60 s, each read from what the node holds now", () => {
    assert.throws(() => new RangeTest(BOB, 29_000, 0));
    assert.throws(() => new RangeTest(BOB, 61_000, 0));
    const t = new RangeTest(BOB, 30_000, 1_000);
    assert.equal(t.nextAt, 1_000, "the first goes at once");
    const fix = { lat: 46.5, lon: 6.6, accuracy: 8, age: 2 };
    const one = t.next(1_000, fix, 16);
    assert.deepEqual([one.n, one.text, t.nextAt], [1, "range #1", 31_000]);
    t.queued(1, 17);
    const two = t.next(31_000, null, 17);
    t.unsent(2, "unanswered");
    t.next(61_000, null, 17, "not_connected");
    // A sync shows the second went: matched by its text, after what the node held.
    const messages = new Map([
        [17, msg(17, "range #1", STATE.delivered)],
        [18, msg(18, "range #2", STATE.sent)],
    ]);
    assert.equal(t.resolve(messages.values()), true);
    assert.equal(two.id, 18);
    const routes = new Map([
        [17, r(2, 22, -98, RELAY, 1, 3_120)],
        [18, r(0, 0, 0, RELAY, 1, 0)],
    ]);
    const rows = rangeRows(t.pings, messages, routes);
    assert.deepEqual(rangeTally(rows), { delivered: 1, sent: 2 });
    assert.equal(rangeRowText(rows[0]!, name), "Delivered · 2 hops · SNR 5.5 dB · -98 dBm · 3.1 s · via Hilltop");
    assert.equal(rangeRowText(rows[1]!, name), "Sent · via Hilltop");
    assert.equal(rangeRowText(rows[2]!, name), "Not sent: node not connected");

    const csv = rangeCsv(rows, BOB, name, () => 0).split("\n");
    assert.equal(csv[0], "n,time,lat,lon,accuracy_m,fix_age_s,to,message_id,result,hops,snr_db,rssi_dbm,round_trip_s,tries,via_id,via");
    assert.equal(csv[1], "1,1970-01-01T00:00:01+00:00,46.5000000,6.6000000,8,2,3d4017c3,17,delivered,2,5.50,-98,3.120,1,1d2e3f40,Hilltop");
    assert.equal(csv[2], "2,1970-01-01T00:00:31+00:00,,,,,3d4017c3,18,sent,,,,,1,1d2e3f40,Hilltop");
    assert.equal(csv[3], "3,1970-01-01T00:01:01+00:00,,,,,3d4017c3,,not_connected,,,,,,,");
    // A name with a comma in it is quoted; a time is in the browser's zone.
    const quoted = rangeCsv(rows.slice(0, 1), BOB, () => 'Hut, "upper"', () => -60).split("\n")[1]!;
    assert.ok(quoted.endsWith(',"Hut, ""upper"""'));
    assert.ok(quoted.includes("1970-01-01T01:00:01+01:00"));
});

