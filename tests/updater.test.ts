// The updater as the client in the specification's update (tests/vectors/companion.json): one
// image over two connections, the link lost between them, and what it does with each refusal; and
// a node that its bootloader updates, asked to restart into it, as the vectors' bootloader has it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Refused } from "../src/lib/companion/client.ts";
import { UPDATE, decode, hex, unhex } from "../src/lib/companion/protocol.ts";
import { Updater, askBootloader, wayOf } from "../src/lib/companion/updater.ts";
import { Wire } from "./wire.ts";

type Step = { from: string; type: string; seq: number; frame: string };
const v: { image: string; image_digest: string; update: Step[][]; bootloader: Step[][] } = JSON.parse(
    readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"),
);
const quick = { answerWaitMs: 40, idleMs: 60_000, gapMs: 10, now: () => 1_790_000_000_000 };

/** Plays one connection of a vector: the node's frames as they come, each of the client's checked. */
async function play(wire: Wire, steps: Step[], during: () => Promise<void>): Promise<void> {
    let at = 0;
    const node = () => {
        while (at < steps.length && steps[at]!.from === "node") {
            wire.raw(unhex(steps[at++]!.frame)!);
        }
    };
    const run = during();
    while (at < steps.length) {
        const step = steps[at++]!;
        assert.equal(step.from, "client");
        assert.equal(hex(await wire.next()), step.frame, step.type);
        node();
    }
    return run;
}

test("update: one image over two connections, going on from where the node says", async () => {
    const u = await Updater.of(unhex(v.image)!);
    const states: string[] = [];
    u.onChange = (x) => states.push(x.state);

    // The first connection: begun from 0, two chunks taken, and then the link is lost.
    const w1 = new Wire(true);
    const c1 = new Client(w1, quick);
    let running: Promise<void> = Promise.resolve();
    await play(w1, v.update[0]!, async () => {
        await c1.start();
        running = u.run((type, fields) => c1.request(type, fields));
    });
    // The next chunk is on its way when the link goes.
    assert.equal(decode(await w1.next())!.fields.offset, 344);
    w1.onClose("lost");
    await running;
    assert.equal(u.state, "waiting");
    assert.equal(u.acknowledged, 344);

    // The second: the node holds 344 bytes, so the last 56 go, and then UPDATE_END.
    const w2 = new Wire(true);
    const c2 = new Client(w2, quick);
    await play(w2, v.update[1]!, async () => {
        await c2.start();
        running = u.run((type, fields) => c2.request(type, fields));
    });
    await running;
    assert.equal(u.state, "restarting");
    assert.equal(u.acknowledged, 400);
    assert.deepEqual([...new Set(states)], ["beginning", "sending", "waiting", "ending", "restarting"]);
    await c2.close();
});

/** An updater on a connection to a node played by hand: `answer` says what it says to each request. */
async function byHand(answer: (type: string, fields: Record<string, unknown>) => [string, object]): Promise<Updater> {
    const u = await Updater.of(unhex(v.image)!);
    const ask = async (type: string, fields: Record<string, unknown> = {}) => {
        const [t, f] = answer(type, fields);
        if (t === "ERROR") {
            const { Refused } = await import("../src/lib/companion/client.ts");
            throw new Refused((f as { code: number }).code, "refused");
        }
        return { type: t, seq: 1, fields: f as Record<string, number> };
    };
    await u.run(ask);
    return u;
}

test("an image the node will not run is refused, and UPDATE_END is not sent again", async () => {
    let ends = 0;
    const u = await byHand((type) => {
        if (type === "UPDATE_BEGIN") return ["UPDATING", { offset: 0 }];
        if (type === "UPDATE_END") return (ends++, ["ERROR", { code: 11 }]);
        return ["OK", {}];
    });
    assert.deepEqual([u.state, u.code, ends], ["refused", 11, 1]);
});

test("a node that cannot be updated this way says so at the start", async () => {
    const u = await byHand(() => ["ERROR", { code: 5 }]);
    assert.deepEqual([u.state, u.code, u.acknowledged], ["refused", 5, 0]);
});

test("a node that sends it back is asked where it is, a few times and no more", async () => {
    let begins = 0;
    const u = await byHand((type, f) => {
        if (type === "UPDATE_BEGIN") return (begins++, ["UPDATING", { offset: 172 }]);
        return f.offset === 172 ? ["ERROR", { code: 10 }] : ["OK", {}];
    });
    assert.deepEqual([u.state, u.code, begins], ["refused", 10, 4]);
});

test("an offset past the image's end is not this image's", async () => {
    const u = await byHand(() => ["UPDATING", { offset: 401 }]);
    assert.deepEqual([u.state, u.code], ["refused", 10]);
});

test("an UPDATE_END that went unanswered is not known, and is not sent again", async () => {
    let ends = 0;
    const u = await byHand((type) => {
        if (type === "UPDATE_BEGIN") return ["UPDATING", { offset: 0 }];
        if (type === "UPDATE_END") return (ends++, ["ERROR", { code: 0 }]);
        return ["OK", {}];
    });
    assert.equal(u.state, "unknown");
    await u.run(() => Promise.reject(new Error("not asked")));
    assert.equal(ends, 1);
});

test("a node that took the client for gone leaves the update to go on once greeted again", async () => {
    // Error 6 mid-image, as a Bluetooth link that came back unseen gets, and then on UPDATE_END.
    for (const at of ["UPDATE_DATA", "UPDATE_END"]) {
        let once = true;
        const u = await byHand((type) => {
            if (type === at && once) return ((once = false), ["ERROR", { code: 6 }]);
            if (type === "UPDATE_BEGIN") return ["UPDATING", { offset: 0 }];
            return ["OK", {}];
        });
        assert.equal(u.state, "waiting", at);
        let begun = false;
        await u.run(async (type) => {
            begun ||= type === "UPDATE_BEGIN";
            return { type: type === "UPDATE_BEGIN" ? "UPDATING" : "OK", seq: 1, fields: { offset: 400 } };
        });
        assert.deepEqual([begun, u.state], [true, "restarting"], at);
    }
});

test("bootloader: a node of version 12 that its bootloader updates refuses the link's update, and restarts into it when asked", async () => {
    const [mine] = v.bootloader;
    const steps = mine!;
    const w = new Wire(true);
    const c = new Client(w, quick);
    // The vector leaves out the clock and the sync, which this client sends on starting: they are
    // answered by hand, and the rest is the vector's, byte for byte.
    const up = c.start();
    assert.equal(hex(await w.next()), steps[0]!.frame);
    w.raw(unhex(steps[1]!.frame)!);
    w.say("OK", decode(await w.next())!.seq);
    w.say("SYNCED", decode(await w.next())!.seq, { news: 0 });
    await up;
    assert.deepEqual([c.board, c.release, c.update], ["heltec-t114", "0.2.0", UPDATE.bootloader]);
    assert.equal(wayOf(c), "bootloader");

    // Over the link it is refused: no room for a second image. A page never asks that of such a
    // node; the vector does, to see it refused.
    const u = await Updater.of(unhex(v.image)!);
    const asked = u.run((type, fields) => c.request(type, fields));
    assert.equal(hex(await w.next()), steps[2]!.frame, "UPDATE_BEGIN");
    w.raw(unhex(steps[3]!.frame)!);
    await asked;
    assert.deepEqual([u.state, u.code], ["refused", 5]);

    const restarting = askBootloader((type, fields) => c.request(type, fields));
    assert.equal(hex(await w.next()), steps[4]!.frame, "UPDATE_BOOTLOADER");
    w.raw(unhex(steps[5]!.frame)!);
    assert.equal(await restarting, "restarting");
    await c.close();
});

test("bootloader: to a client of version 11 the same node names no board, and cannot be updated from it", () => {
    const [, older] = v.bootloader;
    const info = decode(unhex(older![1]!.frame)!, 11)!;
    assert.deepEqual(info.fields, { version: 12, firmware: "tern 0.2.0 heltec-t114", board: "", release: "0.2.0" });
    assert.equal(wayOf({ version: 11, update: null, board: "" }), null);
    // That client's UPDATE_BEGIN is refused as this client's was.
    assert.deepEqual(decode(unhex(older![3]!.frame)!, 11)!.fields, { code: 5 });
});

test("how a node is updated: by its INFO's update from version 12, and before by whether it names a board", () => {
    assert.equal(wayOf({ version: 12, update: UPDATE.link, board: "heltec-v3" }), "link");
    assert.equal(wayOf({ version: 12, update: UPDATE.bootloader, board: "heltec-t114" }), "bootloader");
    assert.equal(wayOf({ version: 12, update: UPDATE.none, board: "rak4631" }), null);
    assert.equal(wayOf({ version: 12, update: 3, board: "heltec-v3" }), null, "a way not known yet");
    assert.equal(wayOf({ version: 11, update: null, board: "heltec-v3" }), "link");
    assert.equal(wayOf({ version: 3, update: null, board: "" }), null);
});

test("an UPDATE_BOOTLOADER unanswered is not sent again; one refused says why", async () => {
    let sent = 0;
    const silent = async () => {
        sent++;
        throw new Refused(0, "the node did not answer UPDATE_BOOTLOADER");
    };
    assert.equal(await askBootloader(silent), "unknown");
    assert.equal(sent, 1);
    await assert.rejects(
        askBootloader(async () => {
            throw new Refused(5, "the node has no room for more");
        }),
        (e: unknown) => e instanceof Refused && e.code === 5,
    );
});
