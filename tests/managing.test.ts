// Version 17: managing a node over the mesh (draft/managing.md), owners, owner changes, the
// Bluetooth lock and restarting. The specification's `manage` connection, as its client, and a node
// managed through it as one of its owners; and what managing.json says of answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused } from "../src/lib/companion/client.ts";
import { Managed, RESTARTS } from "../src/lib/companion/remote.ts";
import { OWNER_BY, SETTING, STATE, TRIAL_MS, VERSION, decode, encode, hex, unhex, unpackAnswer } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";
import { Wire, playing } from "./wire.ts";
import type { Step } from "./wire.ts";

const v: {
    manage: Step[];
    older: { version: number; frames: Step[] }[];
    frames: { type: string; seq: number; fields: Fields; frame: string }[];
} = JSON.parse(readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"));
const m: {
    parameters: Record<string, number>;
    requests: { why: string; frame: string; content: string }[];
    answers: { why: string; frames: string[]; contents: string[] }[];
    rejected: { why: string; content: string }[];
    syncs: { answers: string[]; neighbours: unknown[] }[];
} = JSON.parse(readFileSync(new URL("./vectors/managing.json", import.meta.url), "utf8"));

const SELF_ADDRESS = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const CAROL = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";
const NOW = 1_790_000_000_000;
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => NOW };
const meshQuick = { deliverWaitMs: 200, answerWaitMs: 200, lateWaitMs: 20, againMs: 1, settleMs: 1, now: () => Date.now() };

test("the parameters are the specification's", () => {
    assert.equal(TRIAL_MS, m.parameters.TRIAL! * 1000);
    assert.equal(SETTING.lock, 10);
});

test("answers: each is unpacked into its frames, and one that is not an answer is ignored", () => {
    for (const a of m.answers) {
        // A MANAGED carries an answer's content after its kind.
        const frames = a.contents.flatMap((c) => unpackAnswer(unhex(c.slice(2))!)!.map(hex));
        assert.deepEqual(frames, a.frames, a.why);
    }
    for (const r of m.rejected.filter((x) => x.content.startsWith("06"))) {
        assert.equal(unpackAnswer(unhex(r.content.slice(2))!), null, r.why);
    }
    // Each request's frame is a companion request this client reads.
    for (const r of m.requests) {
        assert.ok(decode(unhex(r.frame)!), r.why);
        assert.equal(r.content, `05${r.frame}`);
    }
});

test("version 17's frames are not read by a client of 16, and its OWNER is refused it", () => {
    const sixteen = v.older.find((o) => o.version === 16)!.frames;
    assert.deepEqual(
        sixteen.slice(-2).map((c) => c.type),
        ["OWNER", "ERROR"],
    );
    assert.deepEqual(decode(unhex(sixteen.at(-1)!.frame)!, 16)!.fields, { code: 1 });
    // A CONTACT and a SELF to it carry no owner and no lock.
    for (const c of sixteen.filter((f) => f.type === "CONTACT" || f.type === "SELF")) {
        const f = decode(unhex(c.frame)!, 16)!;
        assert.equal("owner" in f.fields || "locked" in f.fields, false, c.type);
    }
    for (const c of v.frames.filter((f) => f.type === "SELF")) {
        assert.equal(decode(unhex(c.frame)!)!.fields.locked, c.fields.locked);
    }
});

test("the specification's managing: owners refused and made, and a node driven over the mesh as its owner", async () => {
    const wire = new Wire(true);
    let ref = 0xc0ffee10;
    const c = new Client(wire, { ...quick, random: () => ref++ });
    const p = playing(wire, v.manage);
    const up = c.start();
    await p.expect(); // HELLO
    // This client sets the clock and syncs, which the connection leaves out.
    wire.say("OK", (await wire.next())[1]!);
    wire.say("SYNCED", (await wire.next())[1]!, { news: 0 });
    await up;
    assert.equal(c.version, VERSION);
    assert.deepEqual([c.can("MANAGE"), c.can("OWNER"), c.can("RESTART"), c.can("SET", SETTING.lock)], [true, true, true, true]);

    // Carol is no contact; an owner is 0 or 1; Bob is made one, and his CONTACT says so.
    const carol = c.setOwner(CAROL, true);
    await p.expect();
    await assert.rejects(carol, (e: unknown) => e instanceof Refused && e.code === 12);
    const two = c.request("OWNER", { address: BOB, owner: 2 });
    await p.expect();
    await assert.rejects(two, (e: unknown) => e instanceof Refused && e.code === 3);
    const bob = c.setOwner(BOB, true);
    await p.expect();
    await bob;
    assert.deepEqual([c.contacts.get(BOB)?.name, c.contacts.get(BOB)?.owner], ["Bob", true]);

    // The node's own address, and a request of nothing, are refused.
    const own = c.manage(SELF_ADDRESS, unhex("0301")!);
    await p.expect();
    await assert.rejects(own, (e: unknown) => e instanceof Refused && e.code === 4);
    const empty = c.manage(BOB, new Uint8Array());
    await p.expect();
    await assert.rejects(empty, (e: unknown) => e instanceof Refused && e.code === 3);

    // Bob's node, over the mesh: HELLO and SYNC, its own state only.
    const bobs = new Managed(c, BOB, meshQuick);
    const changes: number[] = [];
    bobs.client.onChange = () => changes.push(1);
    const started = bobs.start();
    await p.expect(); // HELLO
    await p.expect(); // SYNC
    await started;
    const r = bobs.client;
    assert.equal(r.version, VERSION);
    assert.deepEqual([r.self?.address, r.self?.role, r.self?.region, r.self?.locked], [BOB, 1, "EU868", false]);
    assert.deepEqual(
        [...r.contacts.values()].map((x) => [x.address, x.name, x.owner]),
        [[SELF_ADDRESS, "Alice", true]],
    );
    assert.equal(r.neighbours.size, 3);
    assert.ok(r.airtime && r.power && r.fix && r.sleep);
    // None of it is the connected node's.
    assert.deepEqual([c.neighbours.size, c.contacts.has(SELF_ADDRESS)], [0, false]);

    // A power of 10 dBm, on trial until the PING that follows arrives.
    let onTrial: number | null = null;
    bobs.client.onChange = () => {
        onTrial ??= bobs.trialEnds;
    };
    let settled = false;
    bobs.client.onChange = () => {
        onTrial ??= bobs.trialEnds;
        settled ||= bobs.settling;
    };
    const set = bobs.set((x) => x.set("power", 10), RESTARTS.has(SETTING.power));
    await p.expect(); // SET
    await p.expect(); // PING
    assert.equal(await set, true);
    assert.ok(onTrial !== null, "it was said to be on trial");
    assert.ok(settled, "the PING waited for the node to restart");
    assert.equal(bobs.trialEnds, null);

    // What a node does not do over the mesh is refused with ERROR 13.
    const send = r.send(SELF_ADDRESS, "hello", 1);
    await p.expect();
    await assert.rejects(send, (e: unknown) => e instanceof Refused && e.code === 13);
    const restart = bobs.run((x) => x.restart());
    await p.expect();
    await restart;

    // Bob's node tells its owners that Carol was made one, at the node.
    assert.deepEqual(
        c.ownerChanges.map((x) => [x.from, x.contact, x.owner, x.by]),
        [[BOB, CAROL, true, OWNER_BY.link]],
    );
    c.forgetOwnerChange(c.ownerChanges[0]!);
    assert.equal(c.ownerChanges.length, 0);

    // And this node restarts.
    const local = c.restart();
    await p.expect();
    await local;
    assert.ok(p.done());
    await bobs.close();
    await c.close();
});

/** A connected node of version 17 that answers what the test says: HELLO, SET_TIME and an empty sync. */
async function connected(): Promise<{ wire: Wire; c: Client }> {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const up = c.start();
    wire.say("INFO", (await wire.next())[1]!, { version: 17, firmware: "test", board: "heltec-v3", release: "0.8.0", update: 1 });
    wire.say("OK", (await wire.next())[1]!);
    wire.say("SYNCED", (await wire.next())[1]!, { news: 0 });
    await up;
    return { wire, c };
}

/** Packs companion frames into a MANAGED's answer: each after its length. */
function packed(...frames: Uint8Array[]): string {
    return frames.map((f) => f.length.toString(16).padStart(2, "0") + hex(f)).join("");
}

/** The next MANAGE the connected node is asked: its seq, id to give, and the request it carries. */
async function nextManage(wire: Wire): Promise<{ seq: number; request: Uint8Array }> {
    const f = decode(await wire.next())!;
    assert.equal(f.type, "MANAGE");
    return { seq: f.seq, request: unhex(String(f.fields.request))! };
}

test("a request not delivered goes again, and one the node restarted since its HELLO is greeted again first", async () => {
    const { wire, c } = await connected();
    let news = 0;
    let id = 100;
    const managed = new Managed(c, BOB, meshQuick);
    const answer = (...frames: Uint8Array[]) => {
        const q = ++id;
        return {
            q,
            deliver: () => {
                wire.say("STATE", news++, { id: q, state: STATE.delivered, reason: 0, wait: 0 });
                wire.say("MANAGED", news++, { from: BOB, answer: packed(...frames) });
            },
        };
    };
    // HELLO, its first try not delivered; SYNC with the specification's sync of a relay.
    const started = managed.start();
    let ask = await nextManage(wire);
    wire.say("QUEUED", ask.seq, { id: ++id });
    wire.say("STATE", news++, { id, state: STATE.notDelivered, reason: 0, wait: 0 });
    ask = await nextManage(wire);
    assert.equal(managed.transport.progress?.attempt, 2);
    const hello = answer(encode("INFO", ask.request[1]!, { version: 17, firmware: "tern", board: "heltec-v4", release: "0.8.0", update: 1 }));
    wire.say("QUEUED", ask.seq, { id: hello.q });
    hello.deliver();
    ask = await nextManage(wire);
    assert.equal(decode(ask.request)!.type, "SYNC");
    const sync = m.syncs[0]!.answers.map((a) => unpackAnswer(unhex(a.slice(2))!)!);
    // The specification's sync answers seq 2, as this one is.
    assert.equal(ask.request[1], 2);
    wire.say("QUEUED", ask.seq, { id: ++id });
    wire.say("STATE", news++, { id, state: STATE.delivered, reason: 0, wait: 0 });
    for (const frames of sync) {
        wire.say("MANAGED", news++, { from: BOB, answer: packed(...frames) });
    }
    await started;
    assert.deepEqual([managed.client.neighbours.size, managed.client.self?.power, managed.client.contacts.get(SELF_ADDRESS)?.owner], [3, 14, true]);

    // The node restarted to apply something: a PING is answered ERROR 6, so HELLO and SYNC go
    // first, and the PING again.
    const pinged = managed.run((x) => x.request("PING"));
    ask = await nextManage(wire);
    const six = answer(encode("ERROR", ask.request[1]!, { code: 6 }));
    wire.say("QUEUED", ask.seq, { id: six.q });
    six.deliver();
    ask = await nextManage(wire);
    assert.equal(decode(ask.request)!.type, "HELLO");
    const again = answer(encode("INFO", ask.request[1]!, { version: 17, firmware: "tern", board: "heltec-v4", release: "0.8.0", update: 1 }));
    wire.say("QUEUED", ask.seq, { id: again.q });
    again.deliver();
    ask = await nextManage(wire);
    assert.equal(decode(ask.request)!.type, "SYNC");
    const synced = answer(encode("SYNCED", ask.request[1]!, { news: 0 }));
    wire.say("QUEUED", ask.seq, { id: synced.q });
    synced.deliver();
    ask = await nextManage(wire);
    assert.equal(decode(ask.request)!.type, "PING");
    const ok = answer(encode("OK", ask.request[1]!));
    wire.say("QUEUED", ask.seq, { id: ok.q });
    ok.deliver();
    await pinged;

    // A request given up three times is not delivered; one delivered and never answered, no answer.
    const lost = managed.run((x) => x.request("PING"));
    for (let i = 0; i < 3; i++) {
        ask = await nextManage(wire);
        wire.say("QUEUED", ask.seq, { id: ++id });
        wire.say("STATE", news++, { id, state: STATE.notDelivered, reason: 0, wait: 0 });
    }
    await assert.rejects(lost, (e: unknown) => e instanceof Refused && e.code === 0 && /not delivered/.test(e.message));
    const silent = managed.run((x) => x.request("PING"));
    ask = await nextManage(wire);
    wire.say("QUEUED", ask.seq, { id: ++id });
    wire.say("STATE", news++, { id, state: STATE.delivered, reason: 0, wait: 0 });
    await assert.rejects(silent, (e: unknown) => e instanceof Refused && e.code === 0 && /did not answer/.test(e.message));
    await managed.close();
    await c.close();
});

test("a node of version 16 is asked nothing of managing, and its news of it is not read", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const up = c.start();
    wire.say("INFO", (await wire.next())[1]!, { version: 16, firmware: "test", board: "heltec-v3", release: "0.7.0", update: 1 });
    wire.say("OK", (await wire.next())[1]!);
    const sync = (await wire.next())[1]!;
    wire.say("CONTACT", 0, { address: BOB, session: 1, name: "Bob", wake: 0 });
    wire.say("SYNCED", sync, { news: 1 });
    await up;
    assert.deepEqual([c.can("MANAGE"), c.can("OWNER"), c.can("RESTART"), c.can("SET", SETTING.lock)], [false, false, false, false]);
    assert.equal(c.contacts.get(BOB)?.owner, false);
    await assert.rejects(c.setOwner(BOB, true), (e: unknown) => e instanceof Refused && e.code === 1);
    await assert.rejects(c.setLock(true), (e: unknown) => e instanceof Refused && e.code === 1);
    await assert.rejects(c.restart(), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(wire.wrote.length, 0, "nothing was asked of it");
    wire.raw(encode("OWNER_CHANGED", 1, { from: BOB, contact: CAROL, owner: 1, by: 0 }));
    assert.equal(c.ownerChanges.length, 0);
    await c.close();
});

test("a locked node's SELF says so, and over Bluetooth it refuses with ERROR 14", async () => {
    const { wire, c } = await connected();
    wire.say("SELF", 0, { address: SELF_ADDRESS, role: 0, region: "EU868", power: 14, time: 0, cards: 0, card_name: "", most: 0, pairing: 1, locked: 1 });
    assert.equal(c.self?.locked, true);
    const lock = c.setLock(false);
    const f = decode(await wire.next())!;
    assert.deepEqual([f.type, f.fields.setting, f.fields.value], ["SET", 10, 0]);
    wire.say("ERROR", f.seq, { code: 14 });
    await assert.rejects(lock, (e: unknown) => e instanceof Refused && e.code === 14 && /locked/.test(e.message));
    await c.close();
});
