// A companion client: one connection to a node, and what the node holds as far as this client
// has been told. Version 6 of draft/companion.md in ternmesh/spec, and any earlier version a node
// speaks: it asks a node for nothing that node's version does not define.
//
// It asks one request at a time, counts the node's news and syncs again when some is missed,
// says something every so often so the node does not take it for gone, and starts over when the
// node says it has. It knows nothing of the page or of how the bytes travel: a Transport carries
// them, and onChange says when what it holds has changed.

import {
    ANSWER_WAIT_MS,
    GAP_MS,
    IDLE_MS,
    SETTING,
    STATE,
    StreamReader,
    VERSION,
    decode,
    encode,
    settingSince,
    since,
    wrap,
} from "./protocol.ts";
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
    /** Whether the node sends presence cards, and the name they carry: null from a node before cards. */
    cards: boolean | null;
    cardName: string | null;
}
export interface Contact {
    address: string;
    name: string;
    session: boolean;
}
/** A group the node holds: its id, as lower-case hex, and the user's name for it. */
export interface Group {
    id: string;
    name: string;
}
/**
 * A message, a group message or an invite: all three are counted together by the node.
 * `contact` is whom it is with: an address, or for a group message its group's id. `group` is
 * the group a group message is in or an invite is to, and empty for anything else. `from` is the
 * routing id a received group message gave for its writer, which is that writer's claim and no
 * proof; 0 otherwise. An invite's `text` is the name its inviter gave the group.
 */
export interface Message {
    id: number;
    contact: string;
    group: string;
    from: number;
    invite: boolean;
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
/**
 * A position the node holds: from a contact (`group` empty, `from` 0), or from a routing id in a
 * group, which is what that member claimed. `lat` and `lon` are the centre of its cell, in degrees;
 * the cell is 360 / 2^precision degrees each way.
 */
export interface Position {
    contact: string;
    group: string;
    from: number;
    precision: number;
    lat: number;
    lon: number;
    /** In metres, or null if the position gave none. */
    altitude: number | null;
    accuracy: number | null;
    /** When the fix was taken, by this client's clock, in milliseconds. */
    fixedAt: number;
}
/** How the node shares its position with a contact or a group. */
export interface Sharing {
    precision: number;
    altitude: boolean;
    accuracy: boolean;
    /** Seconds between positions. */
    interval: number;
    /** When the node turns it off, by this client's clock, in milliseconds; 0 for when it is told to. */
    endsAt: number;
}
/** A presence card the node holds: who is about, by their own account. */
export interface Card {
    address: string;
    /** The name its sender chose: their claim, not a name the user gave. */
    name: string;
    /** When the node accepted it, by this client's clock, in milliseconds. */
    heardAt: number;
}

/** A position's key in Client.positions: the contact's address, or a group's id and the writer's routing id. */
export function positionKey(contact: string, group = "", from = 0): string {
    return group === "" ? contact : `${group}/${from}`;
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
    9: "the node is not in that group, or no longer holds that invite",
    10: "the node is not where the update is",
    11: "the node will not run that image",
    12: "that address is not a contact",
};

export interface Options {
    now?: () => number; // milliseconds since 1970
    random?: () => number; // a u32
    answerWaitMs?: number;
    idleMs?: number;
    gapMs?: number;
}

interface Seen {
    contacts: Set<string>;
    groups: Set<string>;
    neighbours: Set<number>;
    positions: Set<string>;
    sharing: Set<string>;
    cards: Set<string>;
}

/** After a whole list: what the list did not send is no longer the node's. */
function forgetUnseen<K>(held: Map<K, unknown>, seen: Set<K>): void {
    for (const key of [...held.keys()]) {
        if (!seen.has(key)) {
            held.delete(key);
        }
    }
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
    /** The version both ends speak: the lesser of the node's and this client's. */
    version = 0;
    /** What the node's firmware is built for, and its release: empty from a node before updates. */
    board = "";
    release = "";
    self: Self | null = null;
    readonly contacts = new Map<string, Contact>();
    readonly groups = new Map<string, Group>();
    readonly messages = new Map<number, Message>();
    readonly neighbours = new Map<number, Neighbour>();
    /** By positionKey(). */
    readonly positions = new Map<string, Position>();
    /** By the contact's address or the group's id. */
    readonly sharing = new Map<string, Sharing>();
    readonly cards = new Map<string, Card>();
    /**
     * Addresses the node refused first contact from since this client connected, each with the
     * latest reason (ASKED). The node does not keep them, so neither does a sync: they go when
     * the page lets go of them, or the node gains a session with the address.
     */
    readonly asked = new Map<string, number>();
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
    /** The greatest message id this client is sure it holds everything up to. */
    private through = 0;
    private starting: Promise<void> | null = null;
    /** Whether the node has answered HELLO on this connection, so that `version` is the one both speak. */
    private greeted = false;
    /** During a sync: what it has sent of each list, to forget the rest when it ends. */
    private syncSeen: Seen | null = null;

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
        this.greeted = false;
        const info = await this.request("HELLO", { version: VERSION });
        this.newsSeq = 0;
        this.missed = false;
        // A node that has restarted counts its messages from the start again, and one that only
        // took this client for gone still holds them: either way, what it holds now is asked for
        // whole, and nothing held from before is taken to be the node's.
        this.messages.clear();
        this.through = 0;
        this.version = Math.min(VERSION, Number(info.fields.version));
        this.firmware = String(info.fields.firmware);
        this.board = String(info.fields.board ?? "");
        this.release = String(info.fields.release ?? "");
        this.greeted = true;
        await this.request("SET_TIME", { time: Math.floor(this.now() / 1000) });
        await this.sync();
        this.ready = true;
        this.onChange();
    }

    /**
     * Asks for everything that may have changed unseen, and again if news went missing while it
     * was answered: a sync with a gap in it is not the whole of anything.
     */
    async sync(): Promise<void> {
        // Messages still on their way are the ones whose state may have changed. Otherwise only
        // those after the last this client is sure of are new to it: not after the last it
        // holds, since when news has been missed there may be one before that it never saw.
        let after = this.through;
        for (const m of this.messages.values()) {
            // A group message that is sent is at rest: nothing answers it, so nothing more
            // becomes of it.
            const groupMessage = m.group !== "" && !m.invite;
            if (m.state === STATE.waiting || (m.state === STATE.sent && !groupMessage)) {
                after = Math.min(after, m.id - 1);
            }
        }
        for (let tries = 0; ; tries++) {
            if (await this.syncFrom(after)) {
                break;
            }
            if (tries === 2) {
                throw new Refused(0, "news kept going missing while the node synced");
            }
        }
        for (const m of this.messages.values()) {
            this.through = Math.max(this.through, m.id);
        }
        this.onChange();
    }

    /** One SYNC. False if news was missed during it. */
    private async syncFrom(after: number): Promise<boolean> {
        this.missed = false;
        const seen: Seen = {
            contacts: new Set(),
            groups: new Set(),
            neighbours: new Set(),
            positions: new Set(),
            sharing: new Set(),
            cards: new Set(),
        };
        this.syncSeen = seen;
        try {
            const synced = await this.request("SYNC", { after });
            // From version 3 the answer says what the count should be next: news lost at the end
            // of a sync leaves no gap to see.
            if (synced.fields.news !== undefined && Number(synced.fields.news) !== this.newsSeq) {
                this.missed = true;
                this.newsSeq = Number(synced.fields.news); // the node's count is the one to follow
            }
            if (this.missed) {
                return false;
            }
            forgetUnseen(this.contacts, seen.contacts);
            forgetUnseen(this.groups, seen.groups);
            forgetUnseen(this.neighbours, seen.neighbours);
            forgetUnseen(this.positions, seen.positions);
            forgetUnseen(this.sharing, seen.sharing);
            forgetUnseen(this.cards, seen.cards);
        } finally {
            this.syncSeen = null;
        }
        return true;
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

    private needsGroups(): void {
        if (this.version < 2) {
            throw new Refused(1, "the node's firmware is from before groups");
        }
    }

    /** Whether the version both ends speak defines a request, or a setting. */
    can(type: string, setting?: number): boolean {
        return since(type) <= this.version && (setting === undefined || settingSince(setting) <= this.version);
    }

    /**
     * Gives the node the user's position: degrees, WGS 84; altitude above the ellipsoid and
     * accuracy in metres, null for none; how many seconds old the fix is.
     */
    async setPosition(lat: number, lon: number, altitude: number | null, accuracy: number | null, age: number): Promise<void> {
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
        await this.request("SET_POSITION", {
            lat: clamp(lat * 1e7, -900000000, 900000000),
            lon: clamp(lon * 1e7, -1800000000, 1800000000),
            altitude: altitude === null ? -32768 : clamp(altitude, -32767, 32767),
            accuracy: accuracy === null ? 0 : clamp(accuracy, 1, 0xffff),
            age: clamp(age, 0, 0xffff),
        });
    }
    /**
     * Turns sharing of the node's position with a contact, or a group's id, on or changes it, or
     * with precision 0 turns it off. Only ever because the user asked.
     */
    async share(
        to: string,
        precision: number,
        how: { altitude?: boolean; accuracy?: boolean; interval?: number; minutes?: number } = {},
    ): Promise<void> {
        const fields = {
            precision,
            fields: precision === 0 ? 0 : (how.altitude ? 1 : 0) | (how.accuracy ? 2 : 0),
            interval: precision === 0 ? 0 : (how.interval ?? 0),
            minutes: precision === 0 ? 0 : (how.minutes ?? 0),
        };
        if (to.length === 16) {
            await this.request("SHARE_GROUP", { group: to, ...fields });
        } else {
            await this.request("SHARE", { contact: to, ...fields });
        }
    }
    /** Turns the node's presence cards on or off. Only ever because the user asked. */
    async setCards(on: boolean): Promise<void> {
        await this.request("SET", { setting: SETTING.cards, value: on ? 1 : 0 });
    }
    /** The name the node's cards carry, in clear, to everyone near. */
    async setCardName(name: string): Promise<void> {
        await this.request("SET", { setting: SETTING.cardName, value: name });
    }

    /** Makes a group on the node, which draws its secret, and returns its id. */
    async makeGroup(name: string): Promise<string> {
        this.needsGroups();
        return String((await this.request("MAKE_GROUP", { name })).fields.group);
    }
    /** Leaves a group: the node forgets its secret. The other members are not told. */
    async leaveGroup(group: string): Promise<void> {
        this.needsGroups();
        await this.request("LEAVE_GROUP", { group });
    }
    async nameGroup(group: string, name: string): Promise<void> {
        this.needsGroups();
        await this.request("NAME_GROUP", { group, name });
    }
    /** Writes to a group, and returns the node's id for the message: as send(), once for a ref. */
    async sendGroup(group: string, text: string, ref: number = this.random()): Promise<number> {
        this.needsGroups();
        const fields = { ref, group, text };
        try {
            return Number((await this.request("SEND_GROUP", fields)).fields.id);
        } catch (e) {
            if (e instanceof Refused && e.code === 0 && !this.closed) {
                return Number((await this.request("SEND_GROUP", fields)).fields.id);
            }
            throw e;
        }
    }
    /** Sends an address an invite to a group, over this node's session with it. */
    async invite(group: string, to: string): Promise<number> {
        this.needsGroups();
        return Number((await this.request("SEND_INVITE", { group, to })).fields.id);
    }
    /** Takes the group a received invite was to. */
    async join(id: number): Promise<void> {
        this.needsGroups();
        await this.request("JOIN", { id });
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
    /** Ends the node's session with an address. Only a node of version 1 knows how. */
    async endSession(address: string): Promise<void> {
        if (this.version < 1) {
            throw new Refused(1, "the node's firmware is too old to end a session from here");
        }
        await this.request("END_SESSION", { address });
    }
    /**
     * Changes a setting. A node may restart to apply it once it has answered: the caller starts
     * the connection again.
     */
    async set(setting: Exclude<keyof typeof SETTING, "cards" | "cardName">, value: number | string): Promise<void> {
        await this.request("SET", { setting: SETTING[setting], value });
    }
    /** Lets go of an address the node said had asked. */
    forgetAsked(address: string): void {
        if (this.asked.delete(address)) {
            this.onChange();
        }
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
        // A client sends nothing the version both speak does not define: the node could not tell
        // it what the request changed.
        const setting = type === "SET" ? Number(fields.setting) : undefined;
        if (this.greeted && !this.can(type, setting)) {
            return Promise.reject(new Refused(1, "the node's firmware is too old for that: update it"));
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
        const f = decode(bytes, this.greeted ? this.version : VERSION);
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
            const counted = f.type === "MESSAGE" || f.type === "GROUP_MESSAGE" || f.type === "INVITE";
            if (counted && !this.missed && !this.syncSeen) {
                // In step, so nothing before it was missed.
                this.through = Math.max(this.through, Number(f.fields.id));
            }
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
                    cards: x.cards === undefined ? null : x.cards === 1,
                    cardName: x.card_name === undefined ? null : String(x.card_name),
                };
                break;
            case "CONTACT":
                this.contacts.set(String(x.address), {
                    address: String(x.address),
                    name: String(x.name),
                    session: x.session === 1,
                });
                this.syncSeen?.contacts.add(String(x.address));
                if (x.session === 1) {
                    this.asked.delete(String(x.address)); // it is in
                }
                break;
            case "CONTACT_GONE":
                this.contacts.delete(String(x.address));
                break;
            case "MESSAGE":
            case "GROUP_MESSAGE":
            case "INVITE": {
                const group = f.type === "MESSAGE" ? "" : String(x.group);
                this.messages.set(Number(x.id), {
                    id: Number(x.id),
                    contact: f.type === "GROUP_MESSAGE" ? group : String(x.contact),
                    group,
                    from: f.type === "GROUP_MESSAGE" ? Number(x.from) : 0,
                    invite: f.type === "INVITE",
                    time: Number(x.time),
                    read: (Number(x.flags) & 1) !== 0,
                    state: Number(x.state),
                    reason: Number(x.reason),
                    wait: Number(x.wait),
                    text: String(f.type === "INVITE" ? x.name : x.text),
                });
                break;
            }
            case "GROUP":
                this.groups.set(String(x.group), { id: String(x.group), name: String(x.name) });
                this.syncSeen?.groups.add(String(x.group));
                break;
            case "GROUP_GONE":
                this.groups.delete(String(x.group));
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
            case "ASKED":
                this.asked.set(String(x.address), Number(x.why));
                break;
            case "POSITION":
            case "GROUP_POSITION": {
                const group = f.type === "GROUP_POSITION" ? String(x.group) : "";
                const from = f.type === "GROUP_POSITION" ? Number(x.from) : 0;
                const key = positionKey(String(x.contact ?? ""), group, from);
                if (x.precision === 0) {
                    this.positions.delete(key);
                    break;
                }
                this.positions.set(key, {
                    contact: group === "" ? String(x.contact) : "",
                    group,
                    from,
                    precision: Number(x.precision),
                    lat: Number(x.lat) / 1e7,
                    lon: Number(x.lon) / 1e7,
                    altitude: x.altitude === -32768 ? null : Number(x.altitude),
                    accuracy: x.accuracy === 0 ? null : Number(x.accuracy),
                    fixedAt: this.now() - 1000 * Number(x.age),
                });
                this.syncSeen?.positions.add(key);
                break;
            }
            case "SHARING":
            case "GROUP_SHARING": {
                const key = String(f.type === "SHARING" ? x.contact : x.group);
                if (x.precision === 0) {
                    this.sharing.delete(key);
                    break;
                }
                this.sharing.set(key, {
                    precision: Number(x.precision),
                    altitude: (Number(x.fields) & 1) !== 0,
                    accuracy: (Number(x.fields) & 2) !== 0,
                    interval: Number(x.interval),
                    endsAt: x.minutes === 0 ? 0 : this.now() + 60000 * Number(x.minutes),
                });
                this.syncSeen?.sharing.add(key);
                break;
            }
            case "CARD":
                this.cards.set(String(x.address), {
                    address: String(x.address),
                    name: String(x.name),
                    heardAt: this.now() - 1000 * Number(x.heard),
                });
                this.syncSeen?.cards.add(String(x.address));
                break;
            case "CARD_GONE":
                this.cards.delete(String(x.address));
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
