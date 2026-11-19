// Versions 13 and 14 as a client sees them: HELLO says this client's version; UPDATE_BEGIN carries a signature only
// to a node of version 13 or later, and WIPE is asked only of one; ERROR 11 to UPDATE_BEGIN is a
// signature the node does not take, and to UPDATE_END an image it will not run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused } from "../src/lib/companion/client.ts";
import { VERSION, decode, hex, unhex } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";
import { Updater } from "../src/lib/companion/updater.ts";
import { Wire } from "./wire.ts";

type Step = { from: string; type: string; seq: number; frame: string };
const v: { image: string; image_digest: string; image_signature: string; wipe: Step[] } = JSON.parse(
    readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"),
);
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

async function bringUp(wire: Wire, c: Client, version: number): Promise<void> {
    const up = c.start();
    const hello = decode(await wire.next())!;
    assert.deepEqual([hello.type, hello.fields.version], ["HELLO", VERSION]);
    wire.say("INFO", hello.seq, { version, firmware: "test", board: "heltec-v3", release: "0.6.0", update: 1 });
    wire.say("OK", decode(await wire.next())!.seq);
    const sync = decode(await wire.next())!;
    wire.say("SYNCED", sync.seq, { news: 0 });
    await up;
}

test("this client speaks version 15", () => {
    assert.equal(VERSION, 15);
});

test("UPDATE_BEGIN carries the signature to a node of version 13 or later, and not to one before", async () => {
    for (const [version, signed] of [
        [12, false],
        [13, true],
        [14, true],
    ] as const) {
        const wire = new Wire(true);
        const c = new Client(wire, quick);
        await bringUp(wire, c, version);
        const u = await Updater.of(unhex(v.image)!, unhex(v.image_signature)!);
        const running = u.run((type, fields) => c.request(type, fields));
        const begin = await wire.next();
        const head = `3004${(400).toString(16).padStart(8, "0")}${v.image_digest}`;
        assert.equal(hex(begin).slice(0, 2), "30");
        assert.equal(hex(begin).slice(4), signed ? `${head.slice(4)}40${v.image_signature}` : head.slice(4), `version ${version}`);
        assert.equal(begin.length, signed ? 103 : 38, `version ${version}`);
        wire.say("ERROR", begin[1]!, { code: 5 });
        await running;
        await c.close();
    }
    // An image with no signature goes to a node of version 13 with an empty one: the node says.
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    await bringUp(wire, c, 13);
    const u = await Updater.of(unhex(v.image)!);
    const running = u.run((type, fields) => c.request(type, fields));
    const begin = await wire.next();
    assert.equal(begin.length, 39);
    assert.equal(begin[38], 0);
    // ERROR 11 to UPDATE_BEGIN: not signed by a key the node holds, before any byte is sent.
    wire.say("ERROR", begin[1]!, { code: 11 });
    await running;
    assert.deepEqual([u.state, u.code, u.refusedAt, u.acknowledged], ["refused", 11, "beginning", 0]);
    await c.close();
});

test("ERROR 11 to UPDATE_END is an image the node will not run", async () => {
    const u = await Updater.of(unhex(v.image)!, unhex(v.image_signature)!);
    await u.run(async (type: string, fields: Fields = {}) => {
        if (type === "UPDATE_BEGIN") {
            return { type: "UPDATING", seq: 1, fields: { offset: 400 } };
        }
        assert.equal(type, "UPDATE_END", String(fields));
        throw new Refused(11, "refused");
    });
    assert.deepEqual([u.state, u.code, u.refusedAt], ["refused", 11, "ending"]);
});

test("WIPE is asked only of a node of version 13 or later, and the connection then closes", async () => {
    const old = new Wire(true);
    const c12 = new Client(old, quick);
    await bringUp(old, c12, 12);
    assert.equal(c12.can("WIPE"), false);
    await assert.rejects(c12.wipe(), (e: unknown) => e instanceof Refused && e.code === 1);
    assert.equal(old.wrote.length, 0, "nothing was asked of it");
    assert.equal(c12.wiped, false);
    await c12.close();

    // The specification's wipe, as its client.
    const wire = new Wire(true);
    const c = new Client(wire, quick);
    const up = c.start();
    assert.equal(hex(await wire.next()), v.wipe[0]!.frame, "HELLO");
    wire.raw(unhex(v.wipe[1]!.frame)!);
    wire.say("OK", decode(await wire.next())!.seq);
    wire.say("SYNCED", decode(await wire.next())!.seq, { news: 0 });
    await up;
    assert.equal(c.can("WIPE"), true);
    const wiping = c.wipe();
    const asked = await wire.next();
    assert.equal(decode(asked)!.type, "WIPE");
    assert.equal(hex(asked).slice(0, 2), v.wipe[2]!.frame.slice(0, 2));
    wire.say("OK", asked[1]!);
    await wiping;
    assert.deepEqual([c.wiped, c.closed, wire.closedByClient], [true, true, true]);

    // A node that cannot erase itself now says so, and nothing is closed.
    const busy = new Wire(true);
    const c8 = new Client(busy, quick);
    await bringUp(busy, c8, 13);
    const tried = c8.wipe();
    busy.say("ERROR", (await busy.next())[1]!, { code: 8 });
    await assert.rejects(tried, (e: unknown) => e instanceof Refused && e.code === 8);
    assert.deepEqual([c8.wiped, c8.closed], [false, false]);
    await c8.close();
});
