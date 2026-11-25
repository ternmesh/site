// The node's battery and airtime over time, as this browser heard them. The node keeps no history:
// it sends POWER and AIRTIME when they change, and once in each sync, and the client holds only the
// last of each. So the page keeps what it hears, stamped with the browser's clock, for the meters'
// charts. Kept under the node's own address, as the messages are.
//
// A reading the same as the one before is kept only once it is EVERY after it; one that changes is
// kept at once. When the link ends, the last of each is kept again, marked as an end, so that a
// chart draws a value held up to then and no further: what the node did while the page was away is
// not known. Readings older than KEPT go. The phone apps keep the same, in a file.

import type { Airtime, Power } from "../companion/client.ts";

export interface PowerReading {
    /** The browser's clock, milliseconds since 1970. */
    at: number;
    millivolts: number;
    /** 255 if the node has no estimate. */
    percent: number;
    charging: boolean;
    external: boolean;
    /** The link ended then. */
    end?: boolean;
}

export interface AirtimeReading {
    at: number;
    period: number;
    allowed: number;
    used: number;
    wait: number;
    end?: boolean;
}

/** One point of a chart: `value` from `at` until the next, or, if `end`, nothing after it. */
export interface ChartPoint {
    at: number;
    value: number;
    end: boolean;
}

/** How long a reading that holds still goes before it is kept again. */
export const EVERY = 5 * 60_000;
/** How long a reading is kept. */
export const KEPT = 7 * 24 * 3_600_000;
/** The most of each kind kept, the newest. */
const MOST = 5000;

const samePower = (a: PowerReading, b: Power) =>
    a.millivolts === b.millivolts && a.percent === b.percent && a.charging === b.charging && a.external === b.external;
const sameAirtime = (a: AirtimeReading, b: Airtime) =>
    a.period === b.period && a.allowed === b.allowed && a.used === b.used && a.wait === b.wait;

function trimmed<T extends { at: number }>(list: T[], now: number): T[] {
    const kept = list.filter((r) => now - r.at <= KEPT);
    return kept.slice(-MOST);
}

/** How much of the period's allowance `a` has used, 0 to 1; null for a profile with no limit. */
export function airtimeFraction(a: Pick<AirtimeReading, "period" | "allowed" | "used">): number | null {
    return a.period === 0 ? null : Math.min(1, a.used / Math.max(a.allowed, 1));
}

function isNumber(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
}

export class Readings {
    static forget(node: string, storage: Pick<Storage, "removeItem"> | null): void {
        try {
            storage?.removeItem(`tern.readings.${node}`);
        } catch {
            // Storage is off: there is nothing kept to forget.
        }
    }

    power: PowerReading[] = [];
    airtime: AirtimeReading[] = [];
    /** The address of the node these are of. */
    readonly node: string;
    private readonly key: string;
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;

    constructor(node: string, storage: Pick<Storage, "getItem" | "setItem"> | null) {
        this.node = node;
        this.key = `tern.readings.${node}`;
        this.storage = storage;
        try {
            const saved = JSON.parse(storage?.getItem(this.key) ?? "{}") as { power?: unknown; airtime?: unknown };
            if (Array.isArray(saved.power)) {
                for (const p of saved.power as Partial<PowerReading>[]) {
                    if (isNumber(p.at) && isNumber(p.millivolts) && isNumber(p.percent)) {
                        this.power.push({
                            at: p.at,
                            millivolts: p.millivolts,
                            percent: p.percent,
                            charging: p.charging === true,
                            external: p.external === true,
                            ...(p.end === true ? { end: true } : {}),
                        });
                    }
                }
            }
            if (Array.isArray(saved.airtime)) {
                for (const a of saved.airtime as Partial<AirtimeReading>[]) {
                    if (isNumber(a.at) && isNumber(a.period) && isNumber(a.allowed) && isNumber(a.used) && isNumber(a.wait)) {
                        this.airtime.push({
                            at: a.at,
                            period: a.period,
                            allowed: a.allowed,
                            used: a.used,
                            wait: a.wait,
                            ...(a.end === true ? { end: true } : {}),
                        });
                    }
                }
            }
        } catch {
            // Unreadable, or storage is off: the charts start from now.
        }
        this.power.sort((a, b) => a.at - b.at);
        this.airtime.sort((a, b) => a.at - b.at);
        // Kept by a page closed while connected, the last of each had no end: it ends where it was heard.
        this.endLast(0);
    }

    /** Takes the node's battery and airtime as the client holds them now, at `now`. */
    take(power: Power | null, airtime: Airtime | null, now: number): void {
        let changed = false;
        const lp = this.power.at(-1);
        if (power && !(lp && !lp.end && samePower(lp, power) && now - lp.at < EVERY)) {
            this.power = trimmed([...this.power, { at: now, ...power }], now);
            changed = true;
        }
        const la = this.airtime.at(-1);
        if (airtime && !(la && !la.end && sameAirtime(la, airtime) && now - la.at < EVERY)) {
            this.airtime = trimmed([...this.airtime, { at: now, ...airtime }], now);
            changed = true;
        }
        if (changed) {
            this.save();
        }
    }

    /** The link ended at `now`: each last reading is kept again, as an end. */
    ended(now: number): void {
        if (this.endLast(now)) {
            this.save();
        }
    }

    /** How many times since `from` the node said it had to wait to send: each run of readings with a wait, once. */
    waits(from: number): number {
        let count = 0;
        let waiting = false;
        for (const r of this.airtime) {
            if (r.at < from) {
                continue;
            }
            if (r.end) {
                waiting = false;
                continue;
            }
            if (r.wait > 0 && !waiting) {
                count++;
            }
            waiting = r.wait > 0;
        }
        return count;
    }

    private endLast(now: number): boolean {
        let changed = false;
        const p = this.power.at(-1);
        if (p && !p.end) {
            this.power = [...this.power, { ...p, at: Math.max(now, p.at), end: true }];
            changed = true;
        }
        const a = this.airtime.at(-1);
        if (a && !a.end) {
            this.airtime = [...this.airtime, { ...a, at: Math.max(now, a.at), end: true }];
            changed = true;
        }
        return changed;
    }

    private save(): void {
        try {
            this.storage?.setItem(this.key, JSON.stringify({ power: this.power, airtime: this.airtime }));
        } catch {
            // Full, or storage is off: the charts keep what this page has heard until it closes.
        }
    }
}

/**
 * The points of `points` that a chart from `from` needs: those after it, and the one before it,
 * which holds at its start. One that ended before `from` holds nothing.
 */
export function inSpan(points: ChartPoint[], from: number): ChartPoint[] {
    let firstIn = points.findIndex((p) => p.at >= from);
    if (firstIn < 0) {
        firstIn = points.length;
    }
    const before = points[firstIn - 1];
    return [...(before && !before.end ? [{ ...before, at: from }] : []), ...points.slice(firstIn)];
}

/** `points` cut into runs, each ending at an end, the last held to `to` if it has none. */
export function runs(points: ChartPoint[], to: number): ChartPoint[][] {
    const out: ChartPoint[][] = [];
    let run: ChartPoint[] = [];
    for (const p of points) {
        run.push(p);
        if (p.end) {
            out.push(run);
            run = [];
        }
    }
    const last = run.at(-1);
    if (last) {
        out.push([...run, { ...last, at: Math.max(to, last.at), end: true }]);
    }
    return out;
}
