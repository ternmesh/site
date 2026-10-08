import assert from "node:assert/strict";
import { test } from "node:test";

import { History } from "../src/lib/app/history.ts";
import type { Message } from "../src/lib/companion/client.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);

function store() {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
const msg = (id: number, contact: string, time: number, state: number, text: string): Message => ({
    id,
    contact,
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
    s.data.set("tern.history.node", '[{"contact":1},{"contact":"c","time":1,"incoming":true,"state":4,"text":"ok"}]');
    assert.equal(new History("node", s).kept.length, 1);
    s.data.set("tern.history.node", "not json");
    assert.equal(new History("node", s).kept.length, 0);
});
