// A companion client: one connection to a node, and what the node holds as far as this client
// has been told. Specification draft 0, draft/companion.md in ternmesh/spec.
//
// It asks one request at a time, counts the node's news and syncs again when some is missed,
// says something every so often so the node does not take it for gone, and starts over when the
// node says it has. It knows nothing of the page or of how the bytes travel: a Transport carries
// them, and onChange says when what it holds has changed.

import { ANSWER_WAIT_MS, GAP_MS, IDLE_MS, STATE, StreamReader, VERSION, decode, encode, wrap } from "./protocol.ts";
import type { Fields, Frame } from "./protocol.ts";

export interface Transport {
    /** Whether the link carries whole frames, as Bluetooth does; a byte stream needs them wrapped. */
    readonly framed: boolean;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    /** Set by the client: bytes as they arrive, and the link ending. */
    onData: (data: Uint8Array) => void;
    onClose: (why: string) => void;
}

export interface Self {
    address: string;
    role: number;
    region: string;
    power: number;
    time: number;
}
export interface Contact {
    address: string;
    name: string;
    session: boolean;
}
export interface Message {
    id: number;
    contact: string;
    time: number;
    read: boolean;
    state: number;
    reason: number;
    wait: number;
    text: string;
}
export interface Neighbour {
    routingId: number;
    role: number;
    snrDb: number;
    /** When it was last heard, by this client's clock, in milliseconds. */
    heardAt: number;
}
export interface Airtime {
    period: number;
    allowed: number;
    used: number;
    wait: number;
}
export interface Power {
    millivolts: number;
    percent: number;
    charging: boolean;
    external: boolean;
}

/** A request the node refused, with the specification's code, or 0 for one it never answered. */
export class Refused extends Error {
    readonly code: number;
    constructor(code: number, what: string) {
        super(what);
        this.code = code;
    }
}

const ERRORS: Readonly<Record<number, string>> = {
    1: "the node does not know that request",
    2: "the node could not read the request",
    3: "the node refused that value",
    4: "that is not a valid address, or it is the node's own",
    5: "the node has no room for more",
    6: "the node wants a HELLO first",
    7: "the Bluetooth link's MTU is too small",
    8: "the node cannot do that just now",
};

export interface Options {
    now?: () => number; // milliseconds since 1970
    random?: () => number; // a u32
    answerWaitMs?: number;
    idleMs?: number;
    gapMs?: number;
}

interface Waiting {
    type: string;
    seq: number;
    resolve: (f: Frame) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class Client {
    firmware = "";
    version = 0;
    self: Self | null = null;
    readonly contacts = new Map<string, Contact>();
    readonly messages = new Map<number, Message>();
    readonly neighbours = new Map<number, Neighbour>();
    airtime: Airtime | null = null;
    power: Power | null = null;
    /** Up: the node has answered HELLO and a sync has finished. */
    ready = false;
    closed = false;

    onChange: () => void = () => {};
    onConsole: (text: string) => void = () => {};
    onClosed: (why: string) => void = () => {};

    private readonly transport: Transport;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly answerWaitMs: number;
    private readonly idleMs: number;
    private readonly gapMs: number;
    private readonly reader = new StreamReader();
    private readonly text = new TextDecoder();
    private gap: ReturnType<typeof setTimeout> | null = null;
    private idle: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;
    private waiting: Waiting | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private newsSeq = 0;
    private missed = false;
    private starting: Promise<void> | null = null;
    /** During a sync: the contacts and neighbours it has sent, to forget the rest when it ends. */
    private syncSeen: { contacts: Set<string>; neighbours: Set<number> } | null = null;

    constructor(transport: Transport, options: Options = {}) {
        this.transport = transport;
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
        this.answerWaitMs = options.answerWaitMs ?? ANSWER_WAIT_MS;
        this.idleMs = options.idleMs ?? IDLE_MS / 2;
        this.gapMs = options.gapMs ?? GAP_MS;
        transport.onData = (data) => this.received(data);
        transport.onClose = (why) => this.ended(why);
    }

    /** HELLO, the node's clock, and a sync: after it, this holds what the node holds. */
    start(): Promise<void> {
        this.starting ??= this.begin().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    private async begin(): Promise<void> {
        this.ready = false;
        const info = await this.request("HELLO", { version: VERSION });
        this.newsSeq = 0;
        this.missed = false;
        this.version = Number(info.fields.version);
        this.firmware = String(info.fields.firmware);
        await this.request("SET_TIME", { time: Math.floor(this.now() / 1000) });
        await this.sync();
        this.ready = true;
        this.onChange();
    }

    /** Asks for everything that may have changed unseen. */
    async sync(): Promise<void> {
        // Messages still on their way are the ones whose state may have changed; with none, only
        // those after the last this client holds are new to it.
        let after = 0;
        let moving = Infinity;
        for (const m of this.messages.values()) {
            after = Math.max(after, m.id);
            if (m.state === STATE.waiting || m.state === STATE.sent) {
                moving = Math.min(moving, m.id);
            }
        }
        if (moving !== Infinity) {
            after = moving - 1;
        }
        this.missed = false;
        const seen = { contacts: new Set<string>(), neighbours: new Set<number>() };
        this.syncSeen = seen;
        try {
            await this.request("SYNC", { after });
            for (const address of [...this.contacts.keys()]) {
                if (!seen.contacts.has(address)) {
                    this.contacts.delete(address);
                }
            }
            for (const id of [...this.neighbours.keys()]) {
                if (!seen.neighbours.has(id)) {
                    this.neighbours.delete(id);
                }
            }
        } finally {
            this.syncSeen = null;
        }
        this.onChange();
    }

    /**
     * Sends text to an address, and returns the node's id for the message. A try the node never
     * answered is made once more with the same ref, so it is one message whatever became of the
     * first.
     */
    async send(to: string, text: string, ref: number = this.random()): Promise<number> {
        const fields = { ref, to, text };
        try {
            return Number((await this.request("SEND", fields)).fields.id);
        } catch (e) {
            if (e instanceof Refused && e.code === 0 && !this.closed) {
                return Number((await this.request("SEND", fields)).fields.id);
            }
            throw e;
        }
    }

    async read(through: number): Promise<void> {
        await this.request("READ", { through });
    }
    async saveContact(address: string, name: string): Promise<void> {
        await this.request("SAVE_CONTACT", { address, name });
    }
    async removeContact(address: string): Promise<void> {
        await this.request("REMOVE_CONTACT", { address });
    }

    /** Text for the node's console, as if typed there. Only a byte stream has one. */
    async type(line: string): Promise<void> {
        if (!this.transport.framed) {
            await this.transport.write(new TextEncoder().encode(line + "\n"));
        }
    }

    async close(): Promise<void> {
        this.ended("closed");
        await this.transport.close().catch(() => {});
    }

    /** One request at a time: each waits for the answer to the one before. */
    request(type: string, fields: Fields = {}): Promise<Frame> {
        const next = this.queue.then(
            () => this.ask(type, fields),
            () => this.ask(type, fields),
        );
        this.queue = next.catch(() => {});
        return next;
    }

    private ask(type: string, fields: Fields): Promise<Frame> {
        if (this.closed) {
            return Promise.reject(new Refused(0, "the connection has closed"));
        }
        this.seq = (this.seq % 255) + 1;
        const seq = this.seq;
        const frame = encode(type, seq, fields);
        return new Promise<Frame>((resolve, reject) => {
            const gaveUp = () => {
                if (this.waiting?.seq === seq) {
                    this.waiting = null;
                }
                reject(new Refused(0, `the node did not answer ${type}`));
            };
            this.waiting = { type, seq, resolve, reject, timer: setTimeout(gaveUp, this.answerWaitMs) };
            this.transport.write(this.transport.framed ? frame : wrap(frame)).catch((e: unknown) => {
                if (this.waiting?.seq === seq) {
                    clearTimeout(this.waiting.timer);
                    this.waiting = null;
                }
                reject(e instanceof Error ? e : new Error(String(e)));
            });
        }).finally(() => this.restIdle());
    }

    /** Something is said no later than idleMs after the last answer, or the node lets go. */
    private restIdle(): void {
        if (this.idle) {
            clearTimeout(this.idle);
        }
        if (this.closed) {
            return;
        }
        this.idle = setTimeout(() => {
            if (this.waiting || this.starting) {
                return;
            }
            this.request("PING").catch((e: unknown) => {
                if (e instanceof Refused && e.code === 0) {
                    // Unanswered after ANSWER_WAIT: the node has gone.
                    void this.close().then(() => this.onClosed("the node stopped answering"));
                }
            });
        }, this.idleMs);
    }

    private received(data: Uint8Array): void {
        if (this.transport.framed) {
            this.frame(data);
            return;
        }
        if (this.gap) {
            clearTimeout(this.gap);
            this.gap = null;
        }
        this.items(this.reader.push(data));
        if (this.reader.pending.length > 0) {
            this.gap = setTimeout(() => this.items(this.reader.stale()), this.gapMs);
        }
    }

    private items(items: ReturnType<StreamReader["push"]>): void {
        for (const item of items) {
            if ("frame" in item) {
                this.frame(item.frame);
            } else {
                this.onConsole(this.text.decode(item.text, { stream: true }));
            }
        }
    }

    private frame(bytes: Uint8Array): void {
        const f = decode(bytes);
        if (!f) {
            return; // news of a type this version does not know, or a frame it cannot read
        }
        const t = bytes[0]!;
        if (t >= 0x80) {
            if (f.seq !== this.newsSeq) {
                this.missed = true;
            }
            this.newsSeq = (f.seq + 1) & 0xff;
            this.news(f);
            // The wait for a sync's answer starts again with each news frame.
            const w = this.waiting;
            if (w?.type === "SYNC") {
                clearTimeout(w.timer);
                w.timer = setTimeout(() => {
                    if (this.waiting === w) {
                        this.waiting = null;
                    }
                    w.reject(new Refused(0, "the node did not finish the sync"));
                }, this.answerWaitMs);
            } else if (this.missed && this.ready && !this.syncSeen) {
                this.missed = false;
                void this.sync().catch(() => {});
            }
            this.onChange();
            return;
        }
        const w = this.waiting;
        if (t < 0x40 || !w || f.seq !== w.seq) {
            return; // an answer to a request given up on
        }
        clearTimeout(w.timer);
        this.waiting = null;
        if (f.type !== "ERROR") {
            w.resolve(f);
            return;
        }
        const code = Number(f.fields.code);
        w.reject(new Refused(code, ERRORS[code] ?? `the node refused (error ${code})`));
        if (code === 6 && w.type !== "HELLO" && !this.starting) {
            // Taken for gone: start again.
            void this.start().catch(() => {});
        }
    }

    private news(f: Frame): void {
        const x = f.fields;
        switch (f.type) {
            case "SELF":
                this.self = {
                    address: String(x.address),
                    role: Number(x.role),
                    region: String(x.region),
                    power: Number(x.power),
                    time: Number(x.time),
                };
                break;
            case "CONTACT":
                this.contacts.set(String(x.address), {
                    address: String(x.address),
                    name: String(x.name),
                    session: x.session === 1,
                });
                this.syncSeen?.contacts.add(String(x.address));
                break;
            case "CONTACT_GONE":
                this.contacts.delete(String(x.address));
                break;
            case "MESSAGE":
                this.messages.set(Number(x.id), {
                    id: Number(x.id),
                    contact: String(x.contact),
                    time: Number(x.time),
                    read: (Number(x.flags) & 1) !== 0,
                    state: Number(x.state),
                    reason: Number(x.reason),
                    wait: Number(x.wait),
                    text: String(x.text),
                });
                break;
            case "STATE": {
                const m = this.messages.get(Number(x.id));
                if (m) {
                    m.state = Number(x.state);
                    m.reason = Number(x.reason);
                    m.wait = Number(x.wait);
                }
                break;
            }
            case "NEIGHBOUR":
                this.neighbours.set(Number(x.routing_id), {
                    routingId: Number(x.routing_id),
                    role: Number(x.role),
                    snrDb: Number(x.snr_quarter_db) / 4,
                    heardAt: this.now() - 1000 * Number(x.heard),
                });
                this.syncSeen?.neighbours.add(Number(x.routing_id));
                break;
            case "NEIGHBOUR_GONE":
                this.neighbours.delete(Number(x.routing_id));
                break;
            case "AIRTIME":
                this.airtime = {
                    period: Number(x.period),
                    allowed: Number(x.allowed),
                    used: Number(x.used),
                    wait: Number(x.wait),
                };
                break;
            case "POWER":
                this.power = {
                    millivolts: Number(x.millivolts),
                    percent: Number(x.percent),
                    charging: (Number(x.flags) & 1) !== 0,
                    external: (Number(x.flags) & 2) !== 0,
                };
                break;
        }
    }

    private ended(why: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.ready = false;
        for (const t of [this.idle, this.gap]) {
            if (t) {
                clearTimeout(t);
            }
        }
        const w = this.waiting;
        if (w) {
            clearTimeout(w.timer);
            this.waiting = null;
            w.reject(new Refused(0, "the connection has closed"));
        }
        if (why !== "closed") {
            this.onClosed(why);
        }
        this.onChange();
    }
}
