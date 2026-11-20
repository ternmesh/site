// Managing a node over the mesh, as one of its owners (draft/managing.md): a Transport that carries
// a Client's requests to that node inside MANAGE, through the node the page is connected to, and
// brings its answers back out of MANAGED. A Client over it drives the managed node as one over a
// link drives its own: the same requests and news, read by the version given in the HELLO over
// the mesh, and kept apart from what the connected node holds.
//
// A request that was not delivered goes again, up to three times: each a node acts on over the mesh
// may be sent twice without harm, and a node that has just restarted, as one does to apply a power,
// may not yet have a route back. As tools/companion.py's Remote in ternmesh/firmware.

import { Client, Refused } from "./client.ts";
import type { Transport } from "./client.ts";
import { MESH_ANSWER_WAIT_MS, SETTING, STATE, TRIAL_MS, VERSION, isAnswer, unhex, unpackAnswer } from "./protocol.ts";
import type { Frame } from "./protocol.ts";

/**
 * The settings a node restarts to apply (role and power, when they change), and how long to give it
 * before the PING that confirms them: for about 30 s after a restart it acknowledges nothing, and two
 * messages unacknowledged in a row make the manager start first contact again.
 */
export const RESTARTS: ReadonlySet<number> = new Set([SETTING.role, SETTING.power]);
export const RESTART_SETTLE_MS = 45_000;

export interface MeshOptions {
    /** How long a request may take to be delivered before it is given up: a first contact may come first. */
    deliverWaitMs?: number;
    /** How long to wait for an answer once the request is delivered. */
    answerWaitMs?: number;
    /** After the connected node gives a request up, how long an answer from a copy that arrived may take. */
    lateWaitMs?: number;
    /** Between one try and the next: a node that has just restarted cannot acknowledge for a while. */
    againMs?: number;
    tries?: number;
    /** After a setting the node restarts to apply, before the PING that confirms it. */
    settleMs?: number;
    now?: () => number;
}

/** What has become of the request on its way, for the page to say. */
export interface Progress {
    /** Which try this is, from 1. */
    attempt: number;
    /** Its STATE (STATE.waiting to STATE.notDelivered), and why it waits; null until the node says. */
    state: number | null;
    reason: number;
    /**
     * Whether the connected node has taken it (QUEUED). A keeper holding it for a sleeping node sends
     * no STATE until that node wakes, so a request may stay queued, with no state, for a whole wake.
     */
    queued: boolean;
    /** When this try was handed to the connected node, by this client's clock, in milliseconds. */
    since: number;
    /** How long it waits, in seconds, when the node says (the region's limit, the airtime budget); 0 otherwise. */
    wait: number;
}

export class MeshTransport implements Transport {
    readonly framed = true;
    onData: (data: Uint8Array) => void = () => {};
    onClose: (why: string) => void = () => {};
    /** Where the request under way is, or null with none; onProgress says when it changes. */
    progress: Progress | null = null;
    onProgress: () => void = () => {};

    private readonly local: Client;
    private readonly to: string;
    private readonly deliverWaitMs: number;
    private readonly answerWaitMs: number;
    private readonly lateWaitMs: number;
    private readonly againMs: number;
    /** How many times a request is tried before it is given up. */
    readonly tries: number;
    private readonly now: () => number;
    private readonly tap: (f: Frame) => void;
    private events: Frame[] = [];
    private wake: (() => void) | null = null;
    private pending = false;
    private closed = false;
    /** One request at a time, the next only once the last is done with. */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(local: Client, to: string, options: MeshOptions = {}) {
        this.local = local;
        this.to = to;
        this.deliverWaitMs = options.deliverWaitMs ?? 600_000;
        this.answerWaitMs = options.answerWaitMs ?? MESH_ANSWER_WAIT_MS;
        this.lateWaitMs = options.lateWaitMs ?? 10_000;
        this.againMs = options.againMs ?? 15_000;
        this.tries = options.tries ?? 3;
        this.now = options.now ?? (() => Date.now());
        // Only while a request is under way: a copy of an earlier answer that comes after it would
        // bring news the managed node's client has already counted.
        this.tap = (f) => {
            if (this.pending && (f.type === "STATE" || (f.type === "MANAGED" && f.fields.from === to))) {
                this.events.push(f);
                this.wake?.();
            }
        };
        local.newsTaps.add(this.tap);
    }

    /**
     * Sends one request, and resolves once its answer has come back and gone to onData, with any
     * news before it. Rejects with Refused 0 if it was not delivered in three tries, or was and no
     * answer came; or with the connected node's refusal of the MANAGE.
     */
    write(frame: Uint8Array): Promise<void> {
        const next = this.chain.then(
            () => this.send(frame),
            () => this.send(frame),
        );
        this.chain = next.catch(() => {});
        return next;
    }

    private async send(frame: Uint8Array): Promise<void> {
        if (this.closed) {
            throw new Refused(0, "the connection has closed");
        }
        const seq = frame[1]!;
        this.pending = true;
        try {
            for (let attempt = 1; ; attempt++) {
                this.progress = { attempt, state: null, reason: 0, wait: 0, since: this.now(), queued: false };
                this.onProgress();
                const id = await this.local.manage(this.to, frame);
                this.progress = { ...this.progress, queued: true };
                this.onProgress();
                if (await this.watch(id, seq)) {
                    return;
                }
                if (attempt >= this.tries) {
                    throw new Refused(0, "the request was not delivered");
                }
                await this.pause(this.againMs);
            }
        } finally {
            this.pending = false;
            this.events = [];
            this.progress = null;
            this.onProgress();
        }
    }

    /** True once the answer to `seq` has come; false if the node gave the request up. */
    private async watch(id: number, seq: number): Promise<boolean> {
        let deadline = this.now() + this.deliverWaitMs;
        let delivered = false;
        let lost = false;
        for (;;) {
            if (this.closed) {
                throw new Refused(0, "the connection has closed");
            }
            for (const f of this.events.splice(0)) {
                if (f.type === "STATE") {
                    if (Number(f.fields.id) !== id) {
                        continue;
                    }
                    const state = Number(f.fields.state);
                    this.progress = { ...this.progress!, state, reason: Number(f.fields.reason), wait: Number(f.fields.wait ?? 0) };
                    this.onProgress();
                    if (state === STATE.delivered && !delivered) {
                        delivered = true;
                        deadline = this.now() + this.answerWaitMs;
                    } else if (state === STATE.notDelivered) {
                        // Its answer may still come, from a copy that did arrive: a moment for it.
                        lost = true;
                        deadline = this.now() + this.lateWaitMs;
                    }
                } else if (this.answered(f, seq)) {
                    return true;
                }
            }
            const left = deadline - this.now();
            if (left <= 0) {
                if (lost) {
                    return false;
                }
                throw new Refused(0, delivered ? "the managed node did not answer" : "the request was not delivered in time");
            }
            await this.pause(left);
        }
    }

    /** Passes on a MANAGED's frames, and says whether the answer to `seq` was among them. */
    private answered(f: Frame, seq: number): boolean {
        const frames = unpackAnswer(unhex(String(f.fields.answer)) ?? new Uint8Array());
        if (!frames) {
            return false;
        }
        // One that answers another request is a late copy of an earlier answer: none of it is new.
        if (frames.some((b) => isAnswer(b[0]!) && b[1] !== seq)) {
            return false;
        }
        for (const b of frames) {
            this.onData(b);
        }
        return frames.some((b) => isAnswer(b[0]!) && b[1] === seq);
    }

    /** Waits `ms`, or until news comes or the transport closes. */
    private pause(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            const self = this;
            function done(): void {
                clearTimeout(timer);
                if (self.wake === done) {
                    self.wake = null;
                }
                resolve();
            }
            this.wake = done;
        });
    }

    close(): Promise<void> {
        this.closed = true;
        this.local.newsTaps.delete(this.tap);
        this.wake?.();
        return Promise.resolve();
    }
}

/**
 * A node managed over the mesh: a Client of it through `local`, and what is under way. Its state
 * is HELLO and then SYNC, which over the mesh sends the node's own state only.
 */
export class Managed {
    readonly address: string;
    readonly client: Client;
    readonly transport: MeshTransport;
    /** When a setting changed over the mesh goes back unless the node hears from an owner: null if none is on trial. */
    trialEnds: number | null = null;
    /** A setting was answered, and the node is restarting to apply it: the PING waits until it can answer. */
    settling = false;
    private readonly settleMs: number;
    private readonly now: () => number;

    constructor(local: Client, address: string, options: MeshOptions = {}) {
        this.address = address;
        this.now = options.now ?? (() => Date.now());
        this.settleMs = options.settleMs ?? RESTART_SETTLE_MS;
        this.transport = new MeshTransport(local, address, options);
        // The transport says when to give up, so the client waits for it, and never pings unasked.
        this.client = new Client(this.transport, { answerWaitMs: 3_600_000, keepAlive: false, setsTime: false, now: this.now });
    }

    /**
     * One HELLO, to learn whether the connected node is one of this node's owners: it answers only
     * them, and since the specification's ERROR 15 refuses anyone else at once (Refused 15). Rejects
     * with Refused 0 if no answer came: asleep, out of reach, or not an owner of a node that keeps
     * silent.
     */
    async hello(): Promise<void> {
        await this.client.request("HELLO", { version: VERSION });
    }

    /** HELLO and SYNC: the node's version, and its own state. */
    async start(): Promise<void> {
        await this.client.start();
    }

    /**
     * Runs requests, and once more if the node has restarted since its HELLO, as one does to apply a
     * power or a role: it answers ERROR 6, and the client says HELLO again first.
     */
    async run<T>(what: (c: Client) => Promise<T>): Promise<T> {
        try {
            return await what(this.client);
        } catch (e) {
            if (!(e instanceof Refused && e.code === 6)) {
                throw e;
            }
            await this.client.start();
            return await what(this.client);
        }
    }

    /**
     * Changes settings over the mesh, which puts them on trial: the node takes them back after
     * TRIAL unless it hears from an owner. A PING then confirms them, if it arrives; a node that
     * restarted to apply them is greeted again, which confirms them as well. `restarts` says the node
     * restarts to apply them (RESTARTS), so the PING waits RESTART_SETTLE first. True if confirmed.
     */
    async set(apply: (c: Client) => Promise<void>, restarts = false): Promise<boolean> {
        await this.run(apply);
        this.trialEnds = this.now() + TRIAL_MS;
        this.settling = restarts;
        this.client.onChange();
        if (restarts) {
            await new Promise((r) => setTimeout(r, this.settleMs));
            this.settling = false;
            this.client.onChange();
        }
        try {
            await this.run((c) => c.request("PING"));
        } catch {
            return false;
        }
        this.trialEnds = null;
        this.client.onChange();
        return true;
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
