// Which nodes the connected node owns, as the web app keeps it (src/lib/app/managing.ts): from
// OWNER_CHANGED notices about the connected node, an answer over the mesh, and ERROR 15; kept per
// connected node; and what a request over the mesh is said to wait for.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Owned, answerWaitMs, deliverWaitMs, sleepOf, stepText } from "../src/lib/app/managing.ts";
import { Client, Refused } from "../src/lib/companion/client.ts";
import type { OwnerChange } from "../src/lib/companion/client.ts";
import { Managed } from "../src/lib/companion/remote.ts";
import { MESH_ANSWER_WAIT_MS, OWNER_BY, SLEEP, STATE, decode, encode, hex, unhex } from "../src/lib/companion/protocol.ts";
import { Wire } from "./wire.ts";

const ME = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const OTHER_NODE = "aa".repeat(32);
const RELAY = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const CAROL = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";

function store() {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    };
}
const change = (from: string, contact: string, owner: boolean): OwnerChange => ({ from, contact, owner, by: OWNER_BY.link, at: 0 });

test("a notice about the connected node makes it an owner, or not; one about another address does nothing", () => {
    const s = store();
    const o = new Owned(ME, s);
    assert.equal(o.owner(RELAY), null);
    const changes = [change(RELAY, CAROL, true)];
    assert.equal(o.take(changes, ME), false);
    assert.equal(o.owner(RELAY), null, "Carol's ownership is not this node's");
    changes.push(change(RELAY, ME, true));
    assert.equal(o.take(changes, ME), true);
    assert.equal(o.owner(RELAY), true);
    // Taken once: a notice still shown is not taken again over a later change.
    o.learn(RELAY, new Refused(15, "not an owner"));
    assert.equal(o.take(changes, ME), false);
    assert.equal(o.owner(RELAY), false);
    changes.push(change(RELAY, ME, false));
    o.setOwner(RELAY, true);
    o.take(changes, ME);
    assert.equal(o.owner(RELAY), false);
});

test("an answer means owner, ERROR 15 not, and anything else says nothing", () => {
    const o = new Owned(ME, store());
    o.learn(RELAY, new Refused(0, "the managed node did not answer"));
    assert.equal(o.owner(RELAY), null);
    o.learn(RELAY, null);
    assert.equal(o.owner(RELAY), true);
    o.learn(RELAY, new Refused(0, "the request was not delivered"));
    o.learn(RELAY, new Refused(13, "not over the mesh"));
    assert.equal(o.owner(RELAY), true);
    o.learn(RELAY, new Refused(15, "not an owner"));
    assert.equal(o.owner(RELAY), false);
});

test("kept per connected node, across pages, and forgotten with a wiped node", () => {
    const s = store();
    const o = new Owned(ME, s);
    o.setOwner(RELAY, true);
    o.setSleep(RELAY, 900, 3);
    assert.deepEqual(new Owned(ME, s).get(RELAY), { owner: true, wake: 900, listen: 3 });
    assert.equal(new Owned(OTHER_NODE, s).owner(RELAY), null, "another board's nodes are its own");
    Owned.forget(ME, s);
    assert.equal(new Owned(ME, s).owner(RELAY), null);
    // Storage that throws, or holds nonsense, is nothing known.
    const broken = {
        getItem: () => {
            throw new Error("denied");
        },
        setItem: () => {
            throw new Error("full");
        },
    };
    const b = new Owned(ME, broken);
    b.setOwner(RELAY, true);
    assert.equal(b.owner(RELAY), true, "known for this page");
    s.data.set(`tern.owned.${ME}`, "{not json");
    assert.equal(new Owned(ME, s).owner(RELAY), null);
    assert.equal(new Owned(ME, null).owner(RELAY), null);
});

test("what a request is waiting for, in words", () => {
    const p = (state: number | null, reason = 0, attempt = 1, wait = 0) => ({ attempt, state, reason, wait });
    const asleep = { wake: 900 };
    assert.equal(stepText(p(null), "Mast", null), "Handing it to your node…");
    assert.equal(stepText(p(STATE.waiting, 2), "Mast", null), "Making first contact with Mast…");
    assert.equal(stepText(p(STATE.waiting, 1), "Mast", null), "Finding a route…");
    assert.equal(stepText(p(STATE.waiting, 3, 1, 40), "Mast", null), "Waiting for the region's limit, about 40 s…");
    assert.equal(stepText(p(STATE.waiting, 4), "Mast", null), "Waiting for its share of the air…");
    assert.equal(stepText(p(STATE.waiting, 5), "Mast", null), "Waiting for the radio…");
    assert.equal(stepText(p(STATE.sent), "Mast", null), "On its way…");
    assert.equal(stepText(p(STATE.sent), "Mast", asleep), "Mast is asleep: it wakes every 15 min, so this can take up to 15 min.");
    assert.equal(stepText(p(STATE.waiting, 0), "Mast", asleep), "Mast is asleep: it wakes every 15 min, so this can take up to 15 min.");
    assert.equal(stepText(p(STATE.waiting, 0), "Mast", null), "Waiting…");
    assert.equal(stepText(p(STATE.delivered), "Mast", null), "Delivered — waiting for Mast's answer…");
    assert.equal(stepText(p(STATE.delivered, 0, 2), "Mast", null), "Delivered — waiting for Mast's answer… Try 2 of 3.");
    assert.equal(stepText(p(STATE.notDelivered, 0, 3), "Mast", null), "Not delivered: trying again shortly… Try 3 of 3.");
});

test("how long a node sleeps, as far as the page knows, and how long to wait for it", () => {
    // Its last sync here says first; then what was kept of an earlier sync; then its session.
    const leafAsleep = { role: 0, sleep: { wake: 1800, listen: 4, state: SLEEP.asleep } };
    assert.deepEqual(sleepOf(undefined, 600, leafAsleep), { wake: 1800, listen: 4 });
    assert.equal(sleepOf(undefined, 600, { role: 1, sleep: { wake: 1800, listen: 4, state: SLEEP.awake } }), null, "a relay never sleeps");
    assert.deepEqual(sleepOf({ owner: true, wake: 900, listen: 3 }, 600), { wake: 900, listen: 3 });
    assert.equal(sleepOf({ owner: true, wake: 0, listen: 0 }, 600), null, "its sync said it is awake");
    assert.deepEqual(sleepOf({ owner: true }, 600), { wake: 600, listen: 0 });
    assert.equal(sleepOf(undefined, 0), null, "nothing says it sleeps: say nothing");
    assert.equal(answerWaitMs(null), MESH_ANSWER_WAIT_MS);
    assert.equal(answerWaitMs({ wake: 1800, listen: 4 }), 1804_000 + MESH_ANSWER_WAIT_MS);
    assert.equal(deliverWaitMs(null), 600_000);
    assert.equal(deliverWaitMs({ wake: 3600, listen: 4 }), 3604_000 + MESH_ANSWER_WAIT_MS);
});

/** A connected node of version 17, after HELLO, SET_TIME and an empty sync. */
async function connected(): Promise<{ wire: Wire; c: Client }> {
    const wire = new Wire(true);
    const c = new Client(wire, { answerWaitMs: 40, idleMs: 60_000, gapMs: 10 });
    const up = c.start();
    wire.say("INFO", (await wire.next())[1]!, { version: 17, firmware: "test", board: "heltec-v3", release: "0.8.0", update: 1 });
    wire.say("OK", (await wire.next())[1]!);
    wire.say("SYNCED", (await wire.next())[1]!, { news: 0 });
    await up;
    return { wire, c };
}

test("ERROR 15 over the mesh is a refusal at once, not tried again; one HELLO with no answer is no answer", async () => {
    const { wire, c } = await connected();
    const quick = { deliverWaitMs: 200, answerWaitMs: 50, lateWaitMs: 20, againMs: 1, settleMs: 1 };
    const o = new Owned(ME, store());
    o.setOwner(RELAY, true);
    const m = new Managed(c, RELAY, quick);
    const started = m.start();
    const f = decode(await wire.next())!;
    assert.equal(f.type, "MANAGE");
    const request = unhex(String(f.fields.request))!;
    wire.say("QUEUED", f.seq, { id: 7 });
    wire.say("STATE", 0, { id: 7, state: STATE.delivered, reason: 0, wait: 0 });
    const error = encode("ERROR", request[1]!, { code: 15 });
    wire.say("MANAGED", 1, { from: RELAY, answer: (error.length.toString(16).padStart(2, "0") + hex(error)) });
    let refused: unknown = null;
    await started.catch((e: unknown) => (refused = e));
    assert.ok(refused instanceof Refused && refused.code === 15);
    o.learn(RELAY, refused);
    assert.equal(o.owner(RELAY), false);
    assert.equal(wire.wrote.length, 0, "not tried again");
    await m.close();

    // Checking: one HELLO, tried once; delivered and unanswered, it is no answer, and records nothing.
    const check = new Managed(c, CAROL, { ...quick, tries: 1 });
    const hello = check.hello();
    const g = decode(await wire.next())!;
    assert.equal(decode(unhex(String(g.fields.request))!)!.type, "HELLO");
    wire.say("QUEUED", g.seq, { id: 8 });
    wire.say("STATE", 2, { id: 8, state: STATE.delivered, reason: 0, wait: 0 });
    let silent: unknown = null;
    await hello.catch((e: unknown) => (silent = e));
    assert.ok(silent instanceof Refused && silent.code === 0);
    o.learn(CAROL, silent);
    assert.equal(o.owner(CAROL), null);
    assert.equal(wire.wrote.length, 0, "one HELLO only");
    await check.close();
    await c.close();
});
