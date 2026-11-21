// Versions 19 and 20: names in first contact (ASKED's `name`, CONTACT's `says`) and asking who is
// about (LOOK, ERROR 16). Each read by the version both ends speak, and neither asked of, nor read
// from, a node of an earlier version.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused } from "../src/lib/companion/client.ts";
import { ASKED, NAMES_SINCE, VERSION, decode, encode, hex, since, unhex } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";
import { Wire } from "./wire.ts";

const v: { frames: { type: string; seq: number; fields: Fields; frame: string }[] } = JSON.parse(
    readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"),
);

const BOB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const CAROL = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

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

test("ASKED's name and CONTACT's says are version 19's, and LOOK is version 20's", () => {
    assert.equal(NAMES_SINCE, 19);
    assert.equal(since("LOOK"), 20);
    const look = v.frames.find((f) => f.type === "LOOK")!;
    assert.equal(hex(encode("LOOK", look.seq)), look.frame);
    assert.equal(decode(unhex(look.frame)!, 19), null);
    assert.deepEqual(decode(unhex(v.frames.find((f) => f.type === "ERROR" && f.fields.code === 16)!.frame)!)?.fields, { code: 16 });

    const asked = v.frames.find((f) => f.type === "ASKED" && f.fields.name === "Carol")!;
    assert.deepEqual(decode(unhex(asked.frame)!)?.fields, asked.fields);
    // To a client of version 18 the same bytes are an ASKED without a name: a node of that version sends none.
    assert.deepEqual(decode(unhex(asked.frame)!, 18)?.fields, { address: CAROL, why: asked.fields.why });
    const contact = v.frames.find((f) => f.type === "CONTACT" && f.fields.says === "Robert at the ridge")!;
    assert.deepEqual(decode(unhex(contact.frame)!)?.fields, contact.fields);
    assert.equal(decode(unhex(contact.frame)!, 18)?.fields.says, undefined);
    // A name is no longer than a contact's.
    assert.throws(() => encode("ASKED", 0, { address: CAROL, why: 1, name: "x".repeat(32) }));
    assert.throws(() => encode("CONTACT", 0, { address: BOB, session: 0, name: "", wake: 0, owner: 0, says: "x".repeat(32) }));
});

test("the name an asker and a contact give themselves is kept as their claim, beside the user's name", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, [
        ["CONTACT", { address: BOB, session: 1, name: "Bob", wake: 0, owner: 0, says: "Robert at the ridge" }],
        ["ASKED", { address: CAROL, why: ASKED.notContact, name: "Carol" }],
    ]);
    // The user's name stays the user's: the claim is held apart.
    assert.deepEqual([c.contacts.get(BOB)?.name, c.contacts.get(BOB)?.says], ["Bob", "Robert at the ridge"]);
    assert.deepEqual(c.asked.get(CAROL), { why: ASKED.notContact, name: "Carol" });
    // The latest ASKED replaces the one before, name and all.
    wire.say("ASKED", 9, { address: CAROL, why: ASKED.noRoom, name: "" });
    assert.deepEqual(c.asked.get(CAROL), { why: ASKED.noRoom, name: "" });
    // Once it is in, it is no longer asking.
    wire.say("CONTACT", 10, { address: CAROL, session: 1, name: "", wake: 0, owner: 0, says: "Carol" });
    assert.equal(c.asked.has(CAROL), false);
    assert.deepEqual([c.contacts.get(CAROL)?.name, c.contacts.get(CAROL)?.says], ["", "Carol"]);
    await c.close();
});

test("LOOK is asked only when called for, and ERROR 16 is too soon", async () => {
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await upWith(wire, c, []);
    assert.equal(c.can("LOOK"), true);
    assert.equal(wire.wrote.length, 0, "nothing is asked unasked");

    const first = c.look();
    const asked = decode(await wire.next())!;
    assert.deepEqual([asked.type, asked.fields], ["LOOK", {}]);
    wire.say("OK", asked.seq);
    await first;

    const again = c.look();
    const second = decode(await wire.next())!;
    wire.say("ERROR", second.seq, { code: 16 });
    await assert.rejects(again, (e: unknown) => e instanceof Refused && e.code === 16 && /too soon/.test(e.message));
    await c.close();
});

test("a node of version 19 gives names but is not asked to LOOK; one of version 18 gives none", async () => {
    const nineteen = new Wire(true);
    const c = new Client(nineteen, quick);
    await upWith(nineteen, c, [["CONTACT", { address: BOB, session: 0, name: "", wake: 0, owner: 0, says: "Bob" }]], 19);
    assert.equal(c.contacts.get(BOB)?.says, "Bob");
    assert.equal(c.can("LOOK"), false);
    await assert.rejects(c.look(), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(nineteen.wrote.length, 0, "nothing was asked of it");
    await c.close();

    const eighteen = new Wire(true);
    const d = new Client(eighteen, quick);
    await upWith(eighteen, d, [
        ["CONTACT", { address: BOB, session: 0, name: "Bob", wake: 0, owner: 0 }],
        ["ASKED", { address: CAROL, why: ASKED.notContact }],
    ], 18);
    assert.deepEqual([d.contacts.get(BOB)?.name, d.contacts.get(BOB)?.says], ["Bob", ""]);
    assert.deepEqual(d.asked.get(CAROL), { why: ASKED.notContact, name: "" });
    // Bytes past what version 18 defines are not read from it.
    eighteen.raw(encode("ASKED", 3, { address: CAROL, why: ASKED.noRoom, name: "Carol" }));
    assert.deepEqual(d.asked.get(CAROL), { why: ASKED.noRoom, name: "" });
    await d.close();
});
