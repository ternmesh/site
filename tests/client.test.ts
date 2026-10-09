// The client against a node played by the test: the specification's exchange, byte for byte, and
// what a connection can do that the exchange does not show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused, positionKey } from "../src/lib/companion/client.ts";
import { routingId } from "../src/lib/companion/ids.ts";
import { Wire } from "./wire.ts";
import { STATE, decode, hex, unhex } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";

const v: { exchange: { from: string; type: string; seq: number; frame: string }[] } = JSON.parse(
    readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"),
);
const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const CAROL = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";
const DAVE = "278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e";

const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

/**
 * Answers HELLO, SET_TIME and a SYNC that sends `news`, as a node of `version`, and returns once
 * the client is up. Version 2 is the last whose SYNCED carries no count, which the tests that
 * answer a SYNC by hand rely on.
 */
async function bringUp(wire: Wire, c: Client, news: [string, Fields][] = [], version = 2): Promise<void> {
    const up = c.start();
    const hello = decode(await wire.next())!;
    assert.equal(hello.type, "HELLO");
    assert.equal(hello.fields.version, 6);
    const info: Fields = version >= 4 ? { board: "heltec-v3", release: "0.3.0" } : {};
    wire.say("INFO", hello.seq, { version, firmware: "test", ...info });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    assert.equal(sync.type, "SYNC");
    news.forEach(([type, fields], i) => wire.say(type, i, fields));
    wire.say("SYNCED", sync.seq, version >= 3 ? { news: news.length } : {});
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
        assert.equal(c.version, 6);
        assert.deepEqual([c.firmware, c.board, c.release], ["tern 0.2.0 heltec-v3", "heltec-v3", "0.2.0"]);
        assert.equal(c.self?.region, "EU868");
        assert.deepEqual([c.self?.cards, c.self?.cardName], [false, ""]);
        // Dave's card was accepted 1260 seconds before the sync: his claim, not a name given him.
        assert.equal(c.cards.get(DAVE)?.name, "Trail crew · ask me");
        assert.equal(c.cards.get(DAVE)?.heardAt, quick.now() - 1260_000);
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
        assert.equal(c.messages.get(18)?.state, STATE.delivered);

        // Carol asked, and was refused: saving her lets her in the next time.
        assert.equal(c.asked.get(CAROL), 1);
        const saved = c.saveContact(CAROL, "Carol");
        await expect();
        await saved;
        assert.equal(c.contacts.get(CAROL)?.session, false);

        // A group is made, Bob is invited to it, and a message is written to it.
        const made = c.makeGroup("Hut");
        await expect();
        const hut = await made;
        assert.equal(c.groups.get(hut)?.name, "Hut");
        const invited = c.invite(hut, BOB);
        await expect();
        assert.equal(await invited, 19);
        assert.deepEqual(
            [c.messages.get(19)?.invite, c.messages.get(19)?.contact, c.messages.get(19)?.state],
            [true, BOB, STATE.delivered],
        );
        const wrote = c.sendGroup(hut, "Anyone at the hut?", 0xc0ffee02);
        await expect();
        assert.equal(await wrote, 20);
        assert.deepEqual([c.messages.get(20)?.contact, c.messages.get(20)?.state], [hut, STATE.sent]);

        // Bob answered in the group, and invited this node to another: his message is with the
        // group, under the routing id its frame gave, and his invite is with him.
        const two = c.messages.get(21)!;
        assert.deepEqual([two.contact, two.group, two.text, two.read], [hut, hut, "Two of us", false]);
        assert.equal(two.from, await routingId(BOB));
        const asked = c.messages.get(22)!;
        assert.deepEqual([asked.invite, asked.contact, asked.text, asked.state], [true, BOB, "Ridge", STATE.received]);
        assert.equal(c.groups.has(asked.group), false);
        const joined = c.join(22);
        await expect();
        await joined;
        assert.equal(c.groups.get(asked.group)?.name, "Ridge");
        const named = c.nameGroup(asked.group, "Ridge walkers");
        await expect();
        await named;
        assert.equal(c.groups.get(asked.group)?.name, "Ridge walkers");
        const seen = c.read(22);
        await expect();
        await seen;
        assert.deepEqual([c.messages.get(21)?.read, c.messages.get(22)?.read], [true, true]);
        const left = c.leaveGroup(hut);
        await expect();
        await left;
        assert.deepEqual([...c.groups.keys()], [asked.group]);

        // The user's position, and sharing it with Bob, who shares his.
        const placed = c.setPosition(45.8325, 6.8644, 4806, 4, 3);
        await expect();
        await placed;
        const shared = c.share(BOB, 20, { interval: 900, minutes: 60 });
        await expect();
        await shared;
        assert.deepEqual(c.sharing.get(BOB), {
            precision: 20,
            altitude: false,
            accuracy: false,
            interval: 900,
            endsAt: quick.now() + 3600_000,
        });
        const bob = c.positions.get(BOB)!;
        assert.deepEqual([bob.precision, bob.lat, bob.lon, bob.altitude, bob.accuracy], [16, 60.3945922, 5.2871704, null, null]);
        assert.equal(bob.fixedAt, quick.now() - 40_000);
        const tooFine = c.share(asked.group, 25, { interval: 300 });
        await expect();
        await assert.rejects(tooFine, (e: unknown) => e instanceof Refused && e.code === 3);
        const unshared = c.share(BOB, 0);
        await expect();
        await unshared;
        assert.equal(c.sharing.has(BOB), false);

        assert.equal(c.contacts.get(BOB)?.session, true);
        const ended = c.endSession(BOB);
        await expect();
        await ended;
        assert.equal(c.contacts.get(BOB)?.session, false);

        // The node's own card: named, turned on, and a value that is neither refused.
        const named2 = c.setCardName("Ada · hut warden");
        await expect();
        await named2;
        const on = c.setCards(true);
        await expect();
        await on;
        assert.deepEqual([c.self?.cards, c.self?.cardName], [true, "Ada · hut warden"]);
        const neither = c.request("SET", { setting: 5, value: 2 });
        await expect();
        await assert.rejects(neither, (e: unknown) => e instanceof Refused && e.code === 3);
        assert.equal(c.cards.get(DAVE)?.heardAt, quick.now());

        // Dave is met from his card, under a name the user chose.
        const met = c.saveContact(DAVE, "Dave (trail crew)");
        await expect();
        await met;
        assert.equal(c.contacts.get(DAVE)?.name, "Dave (trail crew)");
        const off = c.setCards(false);
        await expect();
        await off;
        assert.equal(c.self?.cards, false);
        assert.equal(c.cards.has(DAVE), false);
        assert.equal(at, steps.length);
        await c.close();
    });
}

test("a node from before groups is asked for none, nor anything later", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, [], 1);
    assert.equal(c.version, 1);
    await assert.rejects(c.makeGroup("Hut"), (e: unknown) => e instanceof Refused && e.code === 1);
    await assert.rejects(c.sendGroup("0011223344556677", "hi"), Refused);
    await assert.rejects(c.join(3), Refused);
    await assert.rejects(c.setCards(true), (e: unknown) => e instanceof Refused && e.code === 1);
    await assert.rejects(c.share(BOB, 12), (e: unknown) => e instanceof Refused && e.code === 1);
    await assert.rejects(c.setPosition(1, 2, null, null, 0), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(wire.wrote.length, 0, "nothing was asked of it");
    // Nor is news of a later version read from it.
    wire.say("GROUP", 0, { group: "0011223344556677", name: "Hut" });
    wire.say("CARD", 1, { address: CAROL, heard: 1, name: "x" });
    assert.deepEqual([c.groups.size, c.cards.size], [0, 0]);
    assert.equal(c.self, null);
    await c.close();
});

test("a sync is the whole list of groups", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, []);

    // A group the node held, and holds no longer when it is next asked, is forgotten.
    wire.say("GROUP", 0, { group: "0011223344556677", name: "Hut" });
    wire.say("GROUP", 1, { group: "8899aabbccddeeff", name: "Ridge" });
    assert.equal(c.groups.size, 2);
    const again = c.sync();
    const sync = decode(await wire.next())!;
    wire.say("SELF", 2, { address: BOB, role: 0, region: "", power: 0, time: 0 });
    wire.say("GROUP", 3, { group: "8899aabbccddeeff", name: "Ridge" });
    wire.say("SYNCED", sync.seq);
    await again;
    assert.deepEqual([...c.groups.keys()], ["8899aabbccddeeff"]);
    wire.say("GROUP_GONE", 4, { group: "8899aabbccddeeff" });
    assert.equal(c.groups.size, 0);
    await c.close();
});

test("a group message that is sent is at rest, and a sync does not go back for it", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const hut = "0011223344556677";
    const at = { time: 5, flags: 0, reason: 0, wait: 0 };
    await bringUp(wire, c, [
        ["GROUP_MESSAGE", { id: 4, group: hut, from: 0, state: STATE.sent, text: "anyone?", ...at }],
        ["MESSAGE", { id: 9, contact: BOB, state: STATE.delivered, text: "hi", ...at }],
    ]);
    let again = c.sync();
    assert.equal(decode(await wire.next())!.fields.after, 9);
    wire.say("SYNCED", 4);
    await again;
    // An invite that is sent may yet be delivered: it is a message to an address.
    wire.say("INVITE", 2, { id: 10, contact: BOB, group: hut, state: STATE.sent, name: "Hut", ...at });
    again = c.sync();
    assert.equal(decode(await wire.next())!.fields.after, 9);
    wire.say("SYNCED", 5);
    await again;
    await c.close();
});

test("who asked is kept until let go of, or let in", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, [["CONTACT", { address: BOB, session: 0, name: "Bob" }]]);
    wire.say("ASKED", 1, { address: CAROL, why: 1 });
    wire.say("ASKED", 2, { address: BOB, why: 2 });
    wire.say("ASKED", 3, { address: CAROL, why: 2 });
    assert.deepEqual([...c.asked], [
        [CAROL, 2],
        [BOB, 2],
    ]);
    let changes = 0;
    c.onChange = () => changes++;
    c.forgetAsked(CAROL);
    c.forgetAsked(CAROL);
    assert.equal(changes, 1);
    // A session with it is the answer to its asking.
    wire.say("CONTACT", 4, { address: BOB, session: 1, name: "Bob" });
    assert.equal(c.asked.size, 0);
    await c.close();
});

test("settings are SET, and a session is not ended on a node too old to know how", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, [], 0);
    assert.equal(c.version, 0);
    await assert.rejects(c.endSession(BOB), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(wire.wrote.length, 0);

    for (const [setting, value, n] of [
        ["region", "EU868", 1],
        ["role", 0, 2],
        ["power", -9, 3],
    ] as const) {
        const set = c.set(setting, value);
        const f = decode(await wire.next())!;
        assert.equal(f.type, "SET");
        assert.deepEqual(f.fields, { setting: n, value });
        wire.say("OK", f.seq);
        await set;
    }
    const refused = c.set("power", 30);
    wire.say("ERROR", decode(await wire.next())!.seq, { code: 3 });
    await assert.rejects(refused, (e: unknown) => e instanceof Refused && e.code === 3);
    await c.close();
});

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

test("news missed before a message is asked for from the last the client is sure of", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const message = { contact: BOB, time: 0, flags: 0, state: 4, reason: 0, wait: 0, text: "x" };
    await bringUp(wire, c, [["MESSAGE", { id: 3, ...message }]]);
    wire.say("MESSAGE", 1, { id: 4, ...message }); // in step
    wire.say("MESSAGE", 3, { id: 6, ...message }); // 5 was lost on the way
    const sync = decode(await wire.next())!;
    assert.deepEqual(sync.fields, { after: 4 }); // not 6, the last it holds
    wire.say("MESSAGE", 4, { id: 5, ...message });
    wire.say("MESSAGE", 5, { id: 6, ...message });
    wire.say("SYNCED", sync.seq);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([...c.messages.keys()].sort(), [3, 4, 5, 6]);
    await c.close();
});

test("a sync with a gap in it is asked for again", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const up = c.start();
    wire.say("INFO", decode(await wire.next())!.seq, { version: 0, firmware: "test" });
    wire.say("OK", decode(await wire.next())!.seq);
    const first = decode(await wire.next())!;
    wire.say("CONTACT", 0, { address: BOB, session: 1, name: "Bob" });
    wire.say("NEIGHBOUR", 2, { routing_id: 7, role: 1, snr_quarter_db: 0, heard: 1 }); // 1 was lost
    wire.say("SYNCED", first.seq);
    const second = decode(await wire.next())!;
    assert.equal(second.type, "SYNC");
    assert.deepEqual(second.fields, first.fields);
    assert.equal(c.ready, false); // not up on half a list
    wire.say("CONTACT", 3, { address: BOB, session: 1, name: "Bob" });
    wire.say("CONTACT", 4, { address: CAROL, session: 0, name: "Carol" });
    wire.say("NEIGHBOUR", 5, { routing_id: 7, role: 1, snr_quarter_db: 0, heard: 1 });
    wire.say("SYNCED", second.seq);
    await up;
    assert.equal(c.contacts.size, 2);
    await c.close();
});

test("a node that has started again is asked for all it holds, and its old messages are not kept", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const message = { contact: BOB, time: 0, flags: 0, state: 4, reason: 0, wait: 0, text: "old" };
    await bringUp(wire, c, [["MESSAGE", { id: 40, ...message }]]);
    const read = c.read(40);
    wire.say("ERROR", decode(await wire.next())!.seq, { code: 6 });
    await assert.rejects(read);
    wire.say("INFO", decode(await wire.next())!.seq, { version: 0, firmware: "test" });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    assert.deepEqual(sync.fields, { after: 0 }); // not 40: its ids have begun again
    wire.say("MESSAGE", 0, { id: 1, ...message, text: "new" });
    wire.say("SYNCED", sync.seq);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([...c.messages.values()].map((m) => m.text), ["new"]);
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

test("a sync whose count the SYNCED does not match is asked for again", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, [], 6);
    const again = c.sync();
    const first = decode(await wire.next())!;
    wire.say("CONTACT", 0, { address: BOB, session: 1, name: "Bob" });
    // The last news before the answer was lost: no gap shows it, but the count does.
    wire.say("SYNCED", first.seq, { news: 2 });
    const second = decode(await wire.next())!;
    assert.equal(second.type, "SYNC");
    // The node counts on from the one that was lost, and so does the client, from the SYNCED.
    wire.say("CONTACT", 2, { address: BOB, session: 1, name: "Bob" });
    wire.say("CONTACT", 3, { address: CAROL, session: 0, name: "Carol" });
    wire.say("SYNCED", second.seq, { news: 4 });
    await again;
    assert.equal(c.contacts.size, 2);
    await c.close();
});

test("a sync is the whole list of positions, sharing and cards, and a record of precision 0 is none", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const hut = "c8eafadc0857a696";
    const at = { lat: 458325040, lon: 68644058, altitude: 4806, accuracy: 4, age: 12 };
    await bringUp(
        wire,
        c,
        [
            ["POSITION", { contact: BOB, precision: 16, ...at }],
            ["GROUP_POSITION", { group: hut, from: 7, precision: 24, ...at }],
            ["SHARING", { contact: BOB, precision: 20, fields: 1, interval: 900, minutes: 0 }],
            ["GROUP_SHARING", { group: hut, precision: 12, fields: 2, interval: 300, minutes: 5 }],
            ["CARD", { address: DAVE, heard: 5, name: "Dave" }],
            ["CARD", { address: CAROL, heard: 9, name: "" }],
        ],
        6,
    );
    assert.deepEqual([...c.positions.keys()], [BOB, positionKey("", hut, 7)]);
    assert.deepEqual([c.positions.get(`${hut}/7`)?.from, c.positions.get(`${hut}/7`)?.altitude], [7, 4806]);
    assert.deepEqual([c.sharing.get(BOB)?.altitude, c.sharing.get(BOB)?.endsAt], [true, 0]);
    assert.deepEqual([c.sharing.get(hut)?.accuracy, c.sharing.get(hut)?.endsAt], [true, quick.now() + 300_000]);
    assert.equal(c.cards.size, 2);

    wire.say("POSITION", 6, { contact: BOB, precision: 0, lat: 0, lon: 0, altitude: 0, accuracy: 0, age: 0 });
    assert.equal(c.positions.has(BOB), false);

    const again = c.sync();
    const sync = decode(await wire.next())!;
    wire.say("GROUP_SHARING", 7, { group: hut, precision: 12, fields: 0, interval: 300, minutes: 0 });
    wire.say("CARD", 8, { address: CAROL, heard: 0, name: "Carol" });
    wire.say("SYNCED", sync.seq, { news: 9 });
    await again;
    assert.deepEqual([c.positions.size, [...c.sharing.keys()], [...c.cards.keys()]], [0, [hut], [CAROL]]);
    await c.close();
});
