import assert from "node:assert/strict";
import { test } from "node:test";

import { STATE } from "../src/lib/companion/protocol.ts";

import { History } from "../src/lib/app/history.ts";
import type { Message } from "../src/lib/companion/client.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);

const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";

function store() {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
const msg = (id: number, contact: string, time: number, state: number, text: string): Message => ({
    id,
    contact,
    group: "",
    from: 0,
    invite: false,
    time,
    read: false,
    state,
    reason: 0,
    wait: 0,
    text,
});

test("messages at rest are kept across a node that forgets them", () => {
    const s = store();
    const h = new History("node", s);
    const live = [msg(1, A, 100, 4, "hello"), msg(2, A, 110, 0, "on its way"), msg(3, B, 120, 2, "other")];
    h.absorb(live);
    assert.equal(h.kept.length, 2); // the one still waiting is the node's to tell of
    assert.deepEqual(h.earlier(A, live), []); // nothing the node does not also hold

    // The node restarts: its ids begin again, and it holds nothing.
    const again = new History("node", s);
    assert.deepEqual(
        again.earlier(A, []).map((k) => k.text),
        ["hello"],
    );
    assert.deepEqual([...again.contacts()].sort(), [A, B]);
    // A new message with an old id is a new message.
    again.absorb([msg(1, A, 500, 4, "after the restart")]);
    assert.equal(again.kept.length, 3);
    // And the same one seen twice is one.
    again.absorb([msg(1, A, 500, 4, "after the restart")]);
    assert.equal(again.kept.length, 3);
});

test("two messages that say the same thing in the same second are two", () => {
    const s = store();
    const h = new History("node", s);
    const live = [msg(4, A, 100, 2, "OK"), msg(5, A, 100, 2, "OK")];
    h.absorb(live);
    assert.equal(h.kept.length, 2);
    assert.deepEqual(h.earlier(A, live), []);
    assert.equal(new History("node", s).earlier(A, [live[1]!]).length, 1);
});

test("a message's last state is the one kept", () => {
    const h = new History("node", store());
    h.absorb([msg(1, A, 100, 2, "x")]);
    h.absorb([msg(1, A, 100, 3, "x")]);
    assert.equal(h.kept.length, 1);
    assert.equal(h.kept[0]!.state, 3);
});

test("a message with no time is not kept, and each node has its own history", () => {
    const s = store();
    const h = new History("one", s);
    h.absorb([msg(1, A, 0, 4, "no clock"), msg(2, A, 5, 4, "clock")]);
    assert.equal(h.kept.length, 1);
    assert.equal(new History("two", s).kept.length, 0);
});

test("storage that is off, or holds rubbish, is not fatal", () => {
    const h = new History("node", null);
    h.absorb([msg(1, A, 1, 4, "x")]);
    assert.equal(h.kept.length, 1);
    const s = store();
    s.data.set("tern.history.node", '{"not":"a list"}');
    assert.equal(new History("node", s).kept.length, 0);
    s.data.set(
        "tern.history.node",
        '[{"contact":1},{"id":1,"contact":"c","time":1,"incoming":true,"state":4,"text":"ok"}]',
    );
    assert.equal(new History("node", s).kept.length, 1);
    s.data.set("tern.history.node", "not json");
    assert.equal(new History("node", s).kept.length, 0);
});

test("a group message rests once sent, and an invite is kept as one", () => {
    const s = store();
    const h = new History("node", s);
    const hut = "0011223344556677";
    h.absorb([
        { ...msg(1, hut, 100, STATE.sent, "anyone?"), group: hut },
        { ...msg(2, hut, 110, STATE.received, "two of us"), group: hut, from: 0x1d2e3f40 },
        { ...msg(3, BOB, 120, STATE.sent, "on its way"), group: "" },
        { ...msg(4, BOB, 130, STATE.received, "Ridge"), group: "8899aabbccddeeff", invite: true },
    ]);
    // A message to an address that is only sent may yet be delivered or given up: not kept yet.
    assert.deepEqual(h.kept.map((k) => k.id), [1, 2, 4]);
    const again = new History("node", s);
    assert.equal(again.kept[1]?.from, 0x1d2e3f40);
    assert.deepEqual([again.kept[2]?.invite, again.kept[2]?.group], [true, "8899aabbccddeeff"]);
    assert.equal(again.kept[0]?.invite, undefined);
    assert.deepEqual([...again.contacts()].sort(), [hut, BOB].sort());
});
