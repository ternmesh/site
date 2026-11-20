// Version 18: how each message went (ROUTE) and traces (TRACE, TRACED). The specification's `route`
// connection, as its client; routes kept across a sync and a reconnect and forgotten with their
// messages; and a node of version 17.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused, answered } from "../src/lib/companion/client.ts";
import type { Route } from "../src/lib/companion/client.ts";
import { STATE, TRACE_ENTRIES_MAX, TRACE_RESULT, VERSION, decode, encode, hex, traceHops, unhex } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";
import { Wire, playing } from "./wire.ts";
import type { Step } from "./wire.ts";

const v: {
    route: Step[];
    older: { version: number; frames: Step[] }[];
    frames: { type: string; seq: number; fields: Fields; frame: string }[];
} = JSON.parse(readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"));

const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const RELAY = 0x1d2e3f40;
const BOBS = 0x2dc93414;
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

test("ROUTE, TRACE and TRACED are version 18's, and a TRACED's entries are hops out and back", () => {
    for (const type of ["TRACE", "ROUTE", "TRACED"]) {
        const c = v.frames.find((f) => f.type === type)!;
        assert.equal(decode(unhex(c.frame)!, 17), null, type);
        assert.deepEqual(decode(unhex(c.frame)!)?.fields, c.fields, type);
    }
    // Signed fields at their ends, and four bytes of milliseconds.
    const far = { id: 0xffffffff, hops: 255, snr: -128, rssi: -32768, via: 0xffffffff, goes: 255, took: 0xffffffff };
    assert.deepEqual(decode(encode("ROUTE", 0, far))?.fields, far);
    assert.throws(() => encode("ROUTE", 0, { ...far, snr: 128 }));
    const traced = v.frames.find((f) => f.type === "TRACED" && f.fields.result === 0)!.fields;
    const hops = traceHops(String(traced.entries), Number(traced.out));
    assert.deepEqual(hops.wayOut, [
        { routingId: RELAY, snr: 24 },
        { routingId: 0x0a0b0c0d, snr: 40 },
    ]);
    assert.deepEqual(hops.wayBack, [{ routingId: RELAY, snr: 30 }]);
    // Sixteen each way fit a frame; more do not; an entry cut short is no hop.
    const longest = encode("TRACED", 0, { id: 25, to: 1, result: 0, out: 16, took: 0, snr: 0, entries: "00".repeat(TRACE_ENTRIES_MAX) });
    assert.equal(longest.length, 178);
    assert.throws(() => encode("TRACED", 0, { id: 25, to: 1, result: 0, out: 16, took: 0, snr: 0, entries: "00".repeat(TRACE_ENTRIES_MAX + 1) }));
    assert.equal(traceHops("00".repeat(9), 1).wayOut.length + traceHops("00".repeat(9), 1).wayBack.length, 1);
});

test("the specification's route connection: how messages went, and traces refused, answered, not answered and not begun", async () => {
    const wire = new Wire(true);
    let ref = 0xc0ffee21;
    const c = new Client(wire, { ...quick, random: () => ref++ });
    const p = playing(wire, v.route);
    const up = c.start();
    await p.expect(); // HELLO
    // This client sets the clock and syncs, which the connection leaves out.
    wire.say("OK", (await wire.next())[1]!);
    wire.say("SYNCED", (await wire.next())[1]!, { news: 0 });
    await up;
    assert.equal(c.version, VERSION);
    assert.equal(c.can("TRACE"), true);

    const seen: Route[] = [];
    c.newsTaps.add((f) => {
        if (f.type === "ROUTE" && f.fields.id === 17) {
            seen.push(c.routes.get(17)!);
        }
    });
    const sent = c.send(BOB, "Leaving the hut now");
    await p.expect();
    assert.equal(await sent, 17);
    assert.equal(c.messages.get(17)?.state, STATE.delivered);
    // Each try on the air, then delivered: nothing of the way back until it is.
    assert.deepEqual(
        seen.map((r) => [r.goes, r.hops]),
        [
            [1, 0],
            [2, 0],
            [2, 2],
        ],
    );
    assert.deepEqual(c.routes.get(17), { hops: 2, snr: 22, rssi: -98, via: RELAY, goes: 2, took: 19_640 });
    assert.deepEqual(c.routes.get(18), { hops: 2, snr: 19, rssi: -101, via: 0, goes: 0, took: 0 }, "received across two hops; no frame names where it came from");
    assert.equal(c.routes.get(19)?.hops, 1, "a group message: one hop, or none less");

    // Reserved, and the node's own: refused.
    for (const to of [0, 0x51657291]) {
        const r = c.trace(to);
        await p.expect();
        await assert.rejects(r, (e: unknown) => e instanceof Refused && e.code === 3);
        assert.equal(c.traces.get(to)?.failed?.code, 3);
    }
    // To Bob: taken. Asked again while it is out, the node refuses it; this client would not ask.
    const toBob = c.trace(BOBS);
    await p.expect();
    assert.equal(await toBob, 20);
    await assert.rejects(c.trace(BOBS), (e: unknown) => e instanceof Refused && e.code === 8);
    const again = c.request("TRACE", { ref: ref++, to: BOBS });
    await p.expect();
    await assert.rejects(again, (e: unknown) => e instanceof Refused && e.code === 8);
    // Its STATE and TRACED came: answered by Bob, out through the relay and back through it.
    const bob = c.traces.get(BOBS)!;
    assert.equal(bob.state, STATE.sent);
    const ended = bob.ended!;
    assert.equal(ended.result, TRACE_RESULT.answered);
    assert.ok(answered(ended));
    assert.deepEqual(ended.wayOut.map((h) => h.routingId), [RELAY, BOBS], "out through the relay, answered by Bob");
    assert.deepEqual(ended.wayBack.map((h) => h.routingId), [RELAY]);
    assert.deepEqual([ended.snr, ended.took], [26, 3_120]);

    const toRelay = c.trace(RELAY);
    await p.expect();
    assert.equal(await toRelay, 21);
    const nowhere = c.trace(0x30313233);
    await p.expect();
    assert.equal(await nowhere, 22);
    assert.ok(p.done());
    assert.equal(c.traces.get(RELAY)?.ended?.result, TRACE_RESULT.notAnswered);
    assert.equal(c.traces.get(0x30313233)?.ended?.result, TRACE_RESULT.notBegun);
    assert.equal(c.traces.get(0x30313233)?.reason, 1, "it waited for a route first");
    for (const to of [RELAY, 0x30313233]) {
        const t = c.traces.get(to)!.ended!;
        assert.deepEqual([t.wayOut, t.wayBack, t.took, answered(t)], [[], [], 0, false]);
    }
    // A trace's id is no message's, and its STATE changes none.
    assert.deepEqual([...c.messages.keys()], [17, 18, 19]);
    await c.close();
});

/** A client of version 18 up, with `news` sent in its sync. */
async function upWith(wire: Wire, c: Client, news: [string, Fields][], version = VERSION): Promise<void> {
    const up = c.start();
    const hello = decode(await wire.next())!;
    wire.say("INFO", hello.seq, { version, firmware: "test", board: "heltec-v3", release: "0.7.0", update: 1 });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    assert.equal(sync.type, "SYNC");
    news.forEach(([type, fields], i) => wire.say(type, i, fields));
    wire.say("SYNCED", sync.seq, { news: news.length });
    await up;
}

const message = (id: number, text: string, state: number = STATE.received, time = 1_790_000_000 + id): [string, Fields] => [
    "MESSAGE",
    { id, contact: BOB, time, flags: 0, state, reason: 0, wait: 0, text },
];
const route = (id: number, hops: number, via = 0, goes = 0, took = 0): [string, Fields] => ["ROUTE", { id, hops, snr: 19, rssi: -101, via, goes, took }];

test("routes are kept across a sync that sends none, replaced by the next, and forgotten with their messages", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, [message(17, "one"), route(17, 3), message(18, "two"), route(18, 2), route(18, 1)]);
    assert.equal(c.routes.get(18)?.hops, 1, "the last replaces the one before");

    // Connected again, to a node that restarted and kept the messages but not their routes: kept.
    await c.close();
    const wire2 = new Wire(true);
    const c2 = new Client(wire2, quick);
    for (const [id, r] of c.routes) {
        c2.routes.set(id, r);
    }
    for (const [id, m] of c.messages) {
        c2.messages.set(id, m);
    }
    await upWith(wire2, c2, [message(17, "one"), message(18, "two")]);
    assert.deepEqual([c2.routes.get(17)?.hops, c2.routes.get(18)?.hops], [3, 1]);

    // A node that counted again gives 17 to another message: its old route is not this one's.
    await c2.close();
    const wire3 = new Wire(true);
    const c3 = new Client(wire3, quick);
    for (const [id, r] of c2.routes) {
        c3.routes.set(id, r);
    }
    for (const [id, m] of c2.messages) {
        c3.messages.set(id, m);
    }
    await upWith(wire3, c3, [message(17, "after the restart", STATE.received, 1_790_009_999), message(18, "two"), route(18, 4)]);
    assert.deepEqual([c3.routes.has(17), c3.routes.get(18)?.hops], [false, 4]);

    // Forgotten: the messages and their routes.
    wire3.say("FORGOTTEN", 3, { contact: BOB, through: 17 });
    assert.deepEqual([[...c3.messages.keys()], [...c3.routes.keys()]], [[18], [18]]);
    wire3.say("FORGOTTEN", 4, { contact: BOB, through: 18 });
    assert.deepEqual([c3.messages.size, c3.routes.size], [0, 0]);
    await c3.close();
});

test("a node of version 17 is told nothing of how messages went, and is not asked to trace", async () => {
    const seventeen = v.older.find((o) => o.version === 17)!.frames;
    assert.deepEqual(
        seventeen.slice(-2).map((x) => x.type),
        ["TRACE", "ERROR"],
    );
    assert.equal(decode(unhex(seventeen.at(-2)!.frame)!, 17), null);
    assert.deepEqual(decode(unhex(seventeen.at(-1)!.frame)!, 17)!.fields, { code: 1 });
    assert.equal(seventeen.some((x) => x.type === "ROUTE" || x.type === "TRACED"), false);

    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, [message(17, "hi")], 17);
    assert.equal(c.version, 17);
    assert.equal(c.can("TRACE"), false);
    await assert.rejects(c.trace(RELAY), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(wire.wrote.length, 0, "nothing was asked of it");
    // A ROUTE or a TRACED from it is not read.
    wire.raw(encode("ROUTE", 1, { id: 17, hops: 1, snr: 0, rssi: 0, via: 0, goes: 0, took: 0 }));
    wire.raw(encode("TRACED", 2, { id: 20, to: 1, result: 4, out: 0, took: 0, snr: 0, entries: "" }));
    assert.deepEqual([c.routes.size, c.traces.get(1)?.ended ?? null], [0, null]);
    await c.close();
});

test("a TRACED for a trace another client began is shown, and a STATE before the QUEUED is read is not lost", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, []);
    wire.say("TRACED", 0, { id: 30, to: RELAY, result: TRACE_RESULT.notAnswered, out: 0, took: 0, snr: 0, entries: "" });
    assert.equal(c.traces.get(RELAY)?.ended?.result, TRACE_RESULT.notAnswered);
    const t = c.trace(BOBS);
    const asked = decode(await wire.next())!;
    assert.equal(asked.type, "TRACE");
    wire.say("STATE", 1, { id: 31, state: STATE.sent, reason: 0, wait: 0 });
    wire.say("QUEUED", asked.seq, { id: 31 });
    assert.equal(await t, 31);
    assert.equal(c.traces.get(BOBS)?.state, STATE.sent);
    await c.close();
});

test("a TRACED and a ROUTE build and read back through the page's frames", () => {
    for (const c of v.frames.filter((f) => f.type === "TRACED" || f.type === "ROUTE")) {
        assert.equal(hex(encode(c.type, c.seq, c.fields)), c.frame);
    }
});
