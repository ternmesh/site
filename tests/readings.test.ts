// The battery and airtime the page keeps over time: what is kept, what goes, what storage keeps,
// and what a chart takes of them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { EVERY, KEPT, Readings, inSpan, runs } from "../src/lib/app/readings.ts";

const t0 = 1_790_000_000_000;

class Memory {
    items = new Map<string, string>();
    getItem(k: string) {
        return this.items.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.items.set(k, v);
    }
}

const power = (millivolts: number, percent: number) => ({ millivolts, percent, charging: false, external: false });

test("a change is kept at once, and the same value only after a while", () => {
    const r = new Readings("n", null);
    r.take(power(4100, 90), null, t0);
    r.take(power(4100, 90), null, t0 + 10_000);
    assert.equal(r.power.length, 1);
    r.take(power(4080, 89), null, t0 + 20_000);
    assert.equal(r.power.length, 2);
    r.take(power(4080, 89), null, t0 + 20_000 + EVERY);
    assert.equal(r.power.length, 3);
});

test("an end keeps the last again once, and the same value after it starts a new stretch", () => {
    const r = new Readings("n", null);
    r.take(power(4100, 90), { period: 3600, allowed: 36_000, used: 1000, wait: 0 }, t0);
    r.ended(t0 + 60_000);
    assert.deepEqual(r.power.at(-1), { at: t0 + 60_000, ...power(4100, 90), end: true });
    assert.equal(r.airtime.at(-1)?.end, true);
    r.ended(t0 + 70_000);
    assert.equal(r.power.length, 2);
    r.take(power(4100, 90), null, t0 + 80_000);
    assert.equal(r.power.length, 3);
});

test("readings older than a week go", () => {
    const r = new Readings("n", null);
    r.take(power(4100, 90), null, t0);
    r.take(power(4000, 80), null, t0 + KEPT + 1);
    assert.deepEqual(r.power.map((p) => p.percent), [80]);
});

test("storage keeps them under the node, and a page closed while connected ends where it was heard", () => {
    const m = new Memory();
    const r = new Readings("node-a", m);
    r.take(power(4100, 90), { period: 3600, allowed: 36_000, used: 12_345, wait: 2000 }, t0);
    assert.ok(m.items.has("tern.readings.node-a"));
    const again = new Readings("node-a", m);
    assert.deepEqual(again.power, [{ at: t0, ...power(4100, 90) }, { at: t0, ...power(4100, 90), end: true }]);
    assert.equal(again.airtime.length, 2);
    assert.equal(new Readings("node-b", m).power.length, 0);
    m.setItem("tern.readings.node-c", "not json");
    assert.equal(new Readings("node-c", m).power.length, 0);
});

test("a chart takes the value held at its start, and holds the last run to now", () => {
    const p = [
        { at: t0, value: 90, end: false },
        { at: t0 + 100, value: 80, end: false },
        { at: t0 + 200, value: 70, end: false },
    ];
    assert.deepEqual(inSpan(p, t0 + 150), [
        { at: t0 + 150, value: 80, end: false },
        { at: t0 + 200, value: 70, end: false },
    ]);
    const ended = [
        { at: t0, value: 90, end: false },
        { at: t0 + 100, value: 90, end: true },
        { at: t0 + 300, value: 70, end: false },
    ];
    assert.deepEqual(inSpan(ended, t0 + 150), [{ at: t0 + 300, value: 70, end: false }]);
    const r = runs(ended, t0 + 400);
    assert.equal(r.length, 2);
    assert.deepEqual(r[1].at(-1), { at: t0 + 400, value: 70, end: true });
});

test("waits are counted once for each run", () => {
    const r = new Readings("n", null);
    r.airtime = [
        { at: t0, period: 3600, allowed: 36_000, used: 35_000, wait: 500 },
        { at: t0 + 1, period: 3600, allowed: 36_000, used: 35_500, wait: 300 },
        { at: t0 + 2, period: 3600, allowed: 36_000, used: 20_000, wait: 0 },
        { at: t0 + 3, period: 3600, allowed: 36_000, used: 36_000, wait: 900 },
    ];
    assert.equal(r.waits(t0), 2);
    assert.equal(r.waits(t0 + 2), 1);
});
