// The client against a node played by the test: the specification's exchange, byte for byte, and
// what a connection can do that the exchange does not show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused } from "../src/lib/companion/client.ts";
import type { Transport } from "../src/lib/companion/client.ts";
import { STATE, decode, encode, hex, unhex, wrap } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";

const v: { exchange: { from: string; type: string; seq: number; frame: string }[] } = JSON.parse(
    readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"),
);
const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const CAROL = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";

/** The far end of the link: what the client wrote, and a way to say things back. */
class Wire implements Transport {
    readonly framed: boolean;
    wrote: Uint8Array[] = [];
    onData: (data: Uint8Array) => void = () => {};
    onClose: (why: string) => void = () => {};
    closedByClient = false;
    private arrived: (() => void) | null = null;

    constructor(framed: boolean) {
        this.framed = framed;
    }
    write(data: Uint8Array): Promise<void> {
        this.wrote.push(data);
        this.arrived?.();
        return Promise.resolve();
    }
    close(): Promise<void> {
        this.closedByClient = true;
        return Promise.resolve();
    }
    /** The next frame the client writes, as the frame alone. */
    async next(): Promise<Uint8Array> {
        while (this.wrote.length === 0) {
            await new Promise<void>((r) => (this.arrived = r));
        }
        const w = this.wrote.shift()!;
        return this.framed ? w : w.subarray(4, w.length - 2);
    }
    say(type: string, seq: number, fields: Fields = {}): void {
        const f = encode(type, seq, fields);
        this.onData(this.framed ? f : wrap(f));
    }
    raw(frame: Uint8Array): void {
        this.onData(this.framed ? frame : wrap(frame));
    }
}

const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

/** Answers HELLO, SET_TIME and a SYNC that sends `news`, and returns once the client is up. */
async function bringUp(wire: Wire, c: Client, news: [string, Fields][] = []): Promise<void> {
    const up = c.start();
    const hello = decode(await wire.next())!;
    assert.equal(hello.type, "HELLO");
    wire.say("INFO", hello.seq, { version: 0, firmware: "test" });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    assert.equal(sync.type, "SYNC");
    news.forEach(([type, fields], i) => wire.say(type, i, fields));
    wire.say("SYNCED", sync.seq);
    await up;
}

for (const framed of [false, true]) {
    test(`the specification's exchange, as its client, ${framed ? "in frames" : "on a byte stream"}`, async () => {
        const wire = new Wire(framed);
        const c = new Client(wire, quick);
        const steps = v.exchange;
        let at = 0;
        // Each of the client's frames must be the vector's, and the node's are played back as
        // they come in the exchange.
        const play = async () => {
            while (at < steps.length && steps[at]!.from === "node") {
                wire.raw(unhex(steps[at++]!.frame)!);
            }
        };
        const expect = async () => {
            const step = steps[at++]!;
            assert.equal(step.from, "client");
            assert.equal(hex(await wire.next()), step.frame, step.type);
            await play();
        };
        const up = c.start();
        await expect(); // HELLO
        await expect(); // SET_TIME
        await expect(); // SYNC
        await up;
        assert.equal(c.firmware, "tern 0.1.0 heltec-v3");
        assert.equal(c.self?.region, "EU868");
        assert.equal(c.contacts.get(BOB)?.name, "Bob");
        assert.equal(c.messages.get(17)?.read, false);
        assert.equal(c.neighbours.size, 1);
        assert.equal(c.airtime?.allowed, 360000);
        assert.equal(c.power?.percent, 81);

        const read = c.read(17);
        await expect();
        await read;
        assert.equal(c.messages.get(17)?.read, true);

        const sent = c.send(BOB, "On the ridge by six", 0xc0ffee01);
        await expect();
        assert.equal(await sent, 18);
        assert.equal(at, steps.length);
        assert.equal(c.messages.get(18)?.state, STATE.delivered);
        await c.close();
    });
}

test("a sync is the whole list of contacts and neighbours, and not of messages", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const message = { contact: BOB, time: 0, flags: 0, state: 4, reason: 0, wait: 0, text: "hi" };
    await bringUp(wire, c, [
        ["CONTACT", { address: BOB, session: 1, name: "Bob" }],
        ["CONTACT", { address: CAROL, session: 0, name: "Carol" }],
        ["NEIGHBOUR", { routing_id: 7, role: 1, snr_quarter_db: -20, heard: 3 }],
        ["MESSAGE", { id: 5, ...message }],
    ]);
    assert.equal(c.contacts.size, 2);
    assert.equal(c.neighbours.get(7)?.snrDb, -5);

    const again = c.sync();
    const sync = decode(await wire.next())!;
    assert.deepEqual(sync.fields, { after: 5 }); // nothing on its way: only what is new
    wire.say("CONTACT", 4, { address: CAROL, session: 1, name: "Carol" });
    wire.say("SYNCED", sync.seq);
    await again;
    assert.deepEqual([...c.contacts.keys()], [CAROL]);
    assert.equal(c.contacts.get(CAROL)?.session, true);
    assert.equal(c.neighbours.size, 0);
    assert.equal(c.messages.size, 1);
    await c.close();
});

test("news missed is asked for again, from before the oldest message still on its way", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const message = { contact: BOB, time: 0, flags: 0, reason: 0, wait: 0, text: "x" };
    await bringUp(wire, c, [
        ["MESSAGE", { id: 3, state: 2, ...message }],
        ["MESSAGE", { id: 4, state: 0, ...message }],
        ["MESSAGE", { id: 6, state: 4, ...message }],
    ]);
    wire.say("STATE", 5, { id: 4, state: 1, reason: 0, wait: 0 }); // 3 and 4 never came
    const sync = decode(await wire.next())!;
    assert.equal(sync.type, "SYNC");
    assert.deepEqual(sync.fields, { after: 3 });
    wire.say("MESSAGE", 6, { id: 4, state: 2, ...message });
    wire.say("SYNCED", sync.seq);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.messages.get(4)?.state, STATE.delivered);
    // In step again: the next news does not set off another.
    wire.say("STATE", 7, { id: 4, state: 2, reason: 0, wait: 0 });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(wire.wrote.length, 0);
    await c.close();
});

test("a refusal carries the node's code, and an answer to another request is ignored", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c);
    const save = c.saveContact(BOB, "Bob");
    const asked = decode(await wire.next())!;
    wire.say("OK", asked.seq + 9); // an answer to something given up on
    wire.say("ERROR", asked.seq, { code: 4 });
    await assert.rejects(save, (e: unknown) => e instanceof Refused && e.code === 4);
    await c.close();
});

test("a send the node never answered is tried once more, as the same message", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c);
    const sent = c.send(BOB, "once", 77);
    const first = decode(await wire.next())!;
    const second = decode(await wire.next())!; // after answerWaitMs of silence
    assert.deepEqual(second.fields, first.fields);
    assert.notEqual(second.seq, first.seq);
    wire.say("QUEUED", first.seq, { id: 1 }); // late, for the try given up on: ignored
    wire.say("QUEUED", second.seq, { id: 9 });
    assert.equal(await sent, 9);

    const lost = c.send(BOB, "never", 78);
    await wire.next();
    await wire.next();
    await assert.rejects(lost, (e: unknown) => e instanceof Refused && e.code === 0);
    await c.close();
});

test("requests go one at a time", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c);
    const a = c.read(1);
    const b = c.read(2);
    const first = decode(await wire.next())!;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(wire.wrote.length, 0); // the second waits for the first's answer
    wire.say("OK", first.seq);
    const second = decode(await wire.next())!;
    assert.deepEqual(second.fields, { through: 2 });
    wire.say("OK", second.seq);
    await Promise.all([a, b]);
    await c.close();
});

test("a node that took the client for gone is greeted again", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c);
    const read = c.read(1);
    wire.say("ERROR", decode(await wire.next())!.seq, { code: 6 });
    await assert.rejects(read, (e: unknown) => e instanceof Refused && e.code === 6);
    assert.equal(decode(await wire.next())!.type, "HELLO");
    await c.close();
});

test("with nothing to ask it pings, and a node that does not answer has gone", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, { ...quick, idleMs: 20 });
    let why = "";
    c.onClosed = (w) => (why = w);
    await bringUp(wire, c);
    const ping = decode(await wire.next())!;
    assert.equal(ping.type, "PING");
    wire.say("OK", ping.seq);
    assert.equal(decode(await wire.next())!.type, "PING"); // and again, idle after that answer
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(c.closed, true);
    assert.equal(wire.closedByClient, true);
    assert.equal(why, "the node stopped answering");
});

test("the node's console text comes through between frames", async () => {
    const wire = new Wire(false);
    const c = new Client(wire, quick);
    let text = "";
    c.onConsole = (t) => (text += t);
    wire.onData(new TextEncoder().encode("heard #3 \"hi\"\r\n"));
    await bringUp(wire, c);
    // A frame cut short is given up as text after the gap, and the next frame is still read.
    wire.onData(Uint8Array.of(0xf5, 0x54, 0x00));
    await new Promise((r) => setTimeout(r, 30));
    wire.say("CONTACT", 0, { address: BOB, session: 0, name: "B" });
    assert.ok(text.startsWith('heard #3 "hi"\r\n'));
    assert.equal(c.contacts.size, 1);
    await c.close();
});

test("a link that drops ends what was waiting", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    let why = "";
    c.onClosed = (w) => (why = w);
    await bringUp(wire, c);
    const read = c.read(1);
    await wire.next();
    wire.onClose("unplugged");
    await assert.rejects(read);
    assert.equal(why, "unplugged");
    await assert.rejects(c.read(2));
});
