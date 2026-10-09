// The updater as the client in the specification's update (tests/vectors/companion.json): one
// image over two connections, the link lost between them, and what it does with each refusal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "../src/lib/companion/client.ts";
import { decode, hex, unhex } from "../src/lib/companion/protocol.ts";
import { Updater } from "../src/lib/companion/updater.ts";
import { Wire } from "./wire.ts";

type Step = { from: string; type: string; seq: number; frame: string };
const v: { image: string; image_digest: string; update: Step[][] } = JSON.parse(
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
