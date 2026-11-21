// A companion client: one connection to a node, and what the node holds as far as this client
// has been told. Version 20 of draft/companion.md in ternmesh/spec, and any earlier version a node
// speaks: it asks a node for nothing that node's version does not define.
//
// It asks one request at a time, counts the node's news and syncs again when some is missed,
// says something every so often so the node does not take it for gone, and starts over when the
// node says it has. It knows nothing of the page or of how the bytes travel: a Transport carries
// them, and onChange says when what it holds has changed.

import {
    ANSWER_WAIT_MS,
    FIX_SOURCE,
    GAP_MS,
    IDLE_MS,
    RECEIVER,
    SETTING,
    SLEEP,
    STATE,
    StreamReader,
    TRACE_RESULT,
    VERSION,
    decode,
    encode,
    fieldsFor,
    hex,
    settingSince,
    since,
    traceHops,
    wrap,
} from "./protocol.ts";
import type { Fields, Frame, TraceHop } from "./protocol.ts";

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
    /** Whether the node worked this power out as the most it may send at; null before version 10. */
    most: boolean | null;
    /** How it pairs over Bluetooth (PAIRING): null before version 11. */
    pairing: number | null;
    /** Whether its Bluetooth is locked, so that only USB and its owners change it: null before version 17. */
    locked: boolean | null;
}
export interface Contact {
    address: string;
    name: string;
    session: boolean;
    /**
     * How long the contact said it sleeps between wakes, in seconds (version 15): 0 if it does not,
     * has said nothing, or shares no session. A message to it waits with its keeper until it wakes.
     */
    wake: number;
    /** Whether it is one of the node's owners, who may manage it over the mesh (version 17). */
    owner: boolean;
    /**
     * The name it gave itself in the last first contact the node made with it (version 19), empty
     * if none: its claim, not the user's name for it, which it never takes the place of.
     */
    says: string;
}
/**
 * Why the node refused first contact from an address (ASKED's `why`, one of ASKED), and the name
 * the asker gave itself in its handshake (version 19), empty if none: its claim, shown with the
 * address's short code, that the user may take as its name.
 */
export interface Asked {
    why: number;
    name: string;
}
/**
 * A node told this one that its owners changed (OWNER_CHANGED, version 17): `contact` became one
 * of them, or stopped being one, at the node over USB or Bluetooth (`by` OWNER_BY.link) or by an
 * owner over the mesh. The node does not keep these, so neither does a sync.
 */
export interface OwnerChange {
    from: string;
    contact: string;
    owner: boolean;
    by: number;
    /** When it was told, by this client's clock, in milliseconds. */
    at: number;
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
/**
 * How a message, a group message or an invite went, as the node's last ROUTE for it said (version
 * 18). `hops` is how many hops the frame that brought it came, 1 for straight from its sender and 0
 * for unknown; for a group message received, the most it can have come. `snr` (quarters of a dB) and
 * `rssi` (dBm) are how that frame was heard. For one sent, `via` is the routing id of the neighbour
 * it last went to, the destination's own when it went straight there, 0 while it has gone nowhere;
 * `goes` how many tries have gone on the air; and once it is delivered, `hops`, `snr` and `rssi`
 * are the acknowledgement's on its way back, and `took` the round trip in milliseconds.
 */
export interface Route {
    hops: number;
    snr: number;
    rssi: number;
    via: number;
    goes: number;
    took: number;
}
/**
 * A trace to the routing id `to` (version 18), from when it was asked for until it ends: `id` once
 * the node took it, where it is on the air from its STATE, and how it ended (TRACED), or `failed`,
 * why the node did not take it. A TRACED for a trace another client began is kept likewise.
 */
export interface Trace {
    to: number;
    id: number | null;
    /** Its STATE: null until the node says. */
    state: number | null;
    reason: number;
    wait: number;
    /** When it ended: TRACE_RESULT, and for one answered the hops each way. */
    ended: Traced | null;
    failed: Refused | null;
}
export interface Traced {
    result: number;
    /** The nodes that passed it on, and last the one that answered. */
    wayOut: TraceHop[];
    /** The nodes that passed the answer back, before it reached this node. */
    wayBack: TraceHop[];
    /** How well this node heard the answer, in quarters of a dB. */
    snr: number;
    /** From the trace first going on the air until its answer came, in milliseconds. */
    took: number;
}
/** Whether a trace is still on its way: neither ended nor refused. */
export function tracing(t: Trace | undefined): boolean {
    return t !== undefined && t.ended === null && t.failed === null;
}
/** Whether something answered a trace: its destination, its keeper, or a relay with no route. */
export function answered(t: Traced): boolean {
    return t.result <= TRACE_RESULT.noRoute;
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
/**
 * The node's own fix: where it takes itself to be, which is where it shares its position from, and
 * what its satellite receiver is doing. `receiver` is one of RECEIVER, a value this client does not
 * know taken as searching; `source` one of FIX_SOURCE, and with none the rest says nothing.
 */
export interface Fix {
    receiver: number;
    source: number;
    /** Degrees, WGS 84. */
    lat: number;
    lon: number;
    /** In metres above the ellipsoid, or null if the fix gave none. */
    altitude: number | null;
    accuracy: number | null;
    /** How many satellites the receiver's fix was made from: 0 if it does not say, or the fix is a client's. */
    satellites: number;
    /** When the fix was taken, by this client's clock, in milliseconds. */
    fixedAt: number;
}
/**
 * Whether the node, as a leaf, sleeps (SLEEP, version 15): its radio off between polls of a relay,
 * its keeper, that holds its messages. `state` is one of SLEEP.
 */
export interface Sleep {
    /** The longest between polls, in seconds, or 0 if it is not to sleep. */
    wake: number;
    /** How long it listens after each poll, in seconds. */
    listen: number;
    state: number;
    /** Asleep, its keeper's routing id; resting, the relay it tries again; otherwise 0. */
    keeper: number;
    /** Resting: when it tries `keeper` again, by this client's clock, in milliseconds; otherwise null. */
    retryAt: number | null;
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
    13: "a node does not do that when managed over the mesh",
    14: "the node's Bluetooth is locked: only USB, or one of its owners over the mesh, can change it",
    15: "not an owner: a node managed over the mesh answers only its owners",
    16: "too soon: the node asked who is about less than ten minutes ago",
};

export interface Options {
    now?: () => number; // milliseconds since 1970
    random?: () => number; // a u32
    answerWaitMs?: number;
    idleMs?: number;
    gapMs?: number;
    /** Whether to PING when there is nothing to ask, so that the node does not let go: not over the mesh. */
    keepAlive?: boolean;
    /** Whether start() sets the node's clock: not over the mesh, where each request costs airtime. */
    setsTime?: boolean;
}

interface Seen {
    contacts: Set<string>;
    groups: Set<string>;
    neighbours: Set<number>;
    positions: Set<string>;
    sharing: Set<string>;
    cards: Set<string>;
    fix: boolean;
    sleep: boolean;
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
    /**
     * What the node's firmware is built for, and its release: empty from a node before updates.
     * Before version 12 a node names its board only if it is updated over the link.
     */
    board = "";
    release = "";
    /** How the node is given new firmware (UPDATE): null before version 12, which does not say. */
    update: number | null = null;
    self: Self | null = null;
    readonly contacts = new Map<string, Contact>();
    readonly groups = new Map<string, Group>();
    readonly messages = new Map<number, Message>();
    /**
     * How each message went, by its id, as the node's last ROUTE for it said (version 18). Not every
     * message has one: a node keeps none for one from before it kept them, and may keep none across a
     * restart, so a sync that sends none takes none away; one goes with its message when forgotten.
     */
    readonly routes = new Map<number, Route>();
    /** Traces, by the routing id each is to: the last to each, until another. Not kept by the node. */
    readonly traces = new Map<number, Trace>();
    readonly neighbours = new Map<number, Neighbour>();
    /** By positionKey(). */
    readonly positions = new Map<string, Position>();
    /** By the contact's address or the group's id. */
    readonly sharing = new Map<string, Sharing>();
    readonly cards = new Map<string, Card>();
    /**
     * Addresses the node refused first contact from since this client connected, each with the
     * latest reason and name (ASKED). The node does not keep them, so neither does a sync: they go
     * when the page lets go of them, or the node gains a session with the address.
     */
    readonly asked = new Map<string, Asked>();
    /** Owner changes nodes told this one of since this client connected, oldest first, until the page lets go. */
    readonly ownerChanges: OwnerChange[] = [];
    airtime: Airtime | null = null;
    power: Power | null = null;
    /** The node's own fix: null from a node before version 8, which tells of none. */
    fix: Fix | null = null;
    /** Whether the node sleeps: null from a node before version 15, which tells of none. */
    sleep: Sleep | null = null;
    /**
     * How much of each conversation the user has forgotten (FORGOTTEN and GROUP_FORGOTTEN, version
     * 16), by the contact's address or the group's id: every message and invite with that address,
     * or group message to that group, whose id is this or less, is gone, here and wherever else a
     * copy is kept. A record only grows, and every sync sends it again.
     */
    readonly forgotten = new Map<string, number>();
    /**
     * The node said OK to OFF, and is turning off: the connection is closed, and nothing in the
     * protocol turns the node on again, so it is not to be connected to until the user asks.
     */
    turnedOff = false;
    /** The node said OK to WIPE: it is erasing itself, and the node this client knew is gone. */
    wiped = false;
    /** Up: the node has answered HELLO and a sync has finished. */
    ready = false;
    closed = false;

    onChange: () => void = () => {};
    onConsole: (text: string) => void = () => {};
    onClosed: (why: string) => void = () => {};
    /** Every news frame as it is read, for what drives another node through this one (remote.ts). */
    readonly newsTaps = new Set<(f: Frame) => void>();

    private readonly transport: Transport;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly answerWaitMs: number;
    private readonly idleMs: number;
    private readonly gapMs: number;
    private readonly keepAlive: boolean;
    private readonly setsTime: boolean;
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
    /** STATEs for ids no message has, which may be a trace's before its QUEUED is read. */
    private readonly otherStates = new Map<number, { state: number; reason: number; wait: number }>();

    constructor(transport: Transport, options: Options = {}) {
        this.transport = transport;
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
        this.answerWaitMs = options.answerWaitMs ?? ANSWER_WAIT_MS;
        this.idleMs = options.idleMs ?? IDLE_MS / 2;
        this.gapMs = options.gapMs ?? GAP_MS;
        this.keepAlive = options.keepAlive ?? true;
        this.setsTime = options.setsTime ?? true;
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
        const before = new Map(this.messages);
        this.messages.clear();
        this.forgotten.clear();
        this.through = 0;
        this.traces.clear();
        this.otherStates.clear();
        const routed = new Set<number>();
        const tap = (f: Frame) => {
            if (f.type === "ROUTE") {
                routed.add(Number(f.fields.id));
            }
        };
        this.newsTaps.add(tap);
        try {
            await this.greet(info);
        } finally {
            this.newsTaps.delete(tap);
        }
        // A route the sync did not send again is kept only for the same message: a node that keeps
        // none across a restart sends none, and one that counts again may give an old id to a new one.
        for (const id of [...this.routes.keys()]) {
            const was = before.get(id);
            const is = this.messages.get(id);
            const same = was && is && was.contact === is.contact && was.time === is.time && was.text === is.text && was.invite === is.invite;
            if (!routed.has(id) && !same) {
                this.routes.delete(id);
            }
        }
        this.ready = true;
        this.onChange();
    }

    private async greet(info: Frame): Promise<void> {
        this.version = Math.min(VERSION, Number(info.fields.version));
        this.firmware = String(info.fields.firmware);
        this.board = String(info.fields.board ?? "");
        this.release = String(info.fields.release ?? "");
        this.update = info.fields.update === undefined ? null : Number(info.fields.update);
        this.greeted = true;
        if (this.setsTime) {
            await this.request("SET_TIME", { time: Math.floor(this.now() / 1000) });
        }
        await this.sync();
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
            fix: false,
            sleep: false,
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
            // From version 8 every sync sends one FIX; a node that sent none tells of no fix.
            if (!seen.fix) {
                this.fix = null;
            }
            // From version 15 every sync sends one SLEEP.
            if (!seen.sleep) {
                this.sleep = null;
            }
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
    /**
     * Runs the node's satellite receiver, or turns it off to save the power it draws. Nothing goes
     * on the air either way, and the node keeps its last fix.
     */
    async setReceiver(on: boolean): Promise<void> {
        await this.request("SET", { setting: SETTING.receiver, value: on ? 1 : 0 });
    }
    /**
     * Sets how long the node, as a leaf, lets pass between polls when it sleeps, in seconds: 0 not
     * to sleep, or WAKE_MIN to WAKE_MAX. Messages to it then wait until it wakes. Only ever
     * because the user asked.
     */
    async setWake(seconds: number): Promise<void> {
        await this.request("SET", { setting: SETTING.wake, value: seconds });
    }
    /** Sets how long the node listens after each poll when it sleeps, in seconds: LISTEN_MIN to 255. */
    async setListen(seconds: number): Promise<void> {
        await this.request("SET", { setting: SETTING.listen, value: seconds });
    }
    /**
     * Locks the node's Bluetooth, or unlocks it (SET 10, version 17): while locked it does nothing
     * asked over Bluetooth but HELLO and PING, and only USB or its owners over the mesh unlock it.
     * Only ever because the user asked, having been told so.
     */
    async setLock(on: boolean): Promise<void> {
        await this.request("SET", { setting: SETTING.lock, value: on ? 1 : 0 });
    }
    /**
     * Makes a contact one of the node's owners, who may manage it over the mesh, or not (OWNER,
     * version 17). Only ever because the user asked, having been told what an owner can do.
     */
    async setOwner(address: string, owner: boolean): Promise<void> {
        await this.request("OWNER", { address, owner: owner ? 1 : 0 });
    }
    /**
     * Has the node ask the nodes in earshot for their cards (LOOK, version 20): those with cards on
     * answer within half a minute, and their cards come as any card does. Only ever because the
     * user asked. Rejects with Refused 16 if the node asked less than ASK_GAP, ten minutes, before.
     */
    async look(): Promise<void> {
        await this.request("LOOK");
    }
    /** Restarts the node (RESTART, version 17): it answers, and then restarts, and every connection drops. */
    async restart(): Promise<void> {
        await this.request("RESTART");
    }
    /**
     * Sends one companion request, as its frame, to the node at `to` over the mesh, to manage it
     * (MANAGE, version 17), and returns the id that STATE news about it carries. Its answer comes
     * back as MANAGED news: remote.ts reads both.
     */
    async manage(to: string, frame: Uint8Array, ref: number = this.random()): Promise<number> {
        return Number((await this.request("MANAGE", { ref, to, request: hex(frame) })).fields.id);
    }
    /**
     * Traces the way frames go to the node whose routing id is `to`, and back (TRACE, version 18):
     * a contact's, a neighbour's, or any other. Its STATE and TRACED land in `traces`. One to an id
     * a trace is already out to is not asked: the node would refuse it. Rejects with Refused if the
     * node refused: ERROR 3 for a reserved id or its own, 8 for one already out.
     */
    async trace(to: number, ref?: number): Promise<number> {
        if (tracing(this.traces.get(to))) {
            throw new Refused(8, ERRORS[8]!);
        }
        ref ??= this.random();
        const run: Trace = { to, id: null, state: null, reason: 0, wait: 0, ended: null, failed: null };
        this.traces.set(to, run);
        this.onChange();
        try {
            const id = Number((await this.request("TRACE", { ref, to })).fields.id);
            if (run.id === null) {
                run.id = id;
            }
            const early = this.otherStates.get(id);
            if (early) {
                Object.assign(run, early);
                this.otherStates.delete(id);
            }
            this.onChange();
            return id;
        } catch (e) {
            run.failed = e instanceof Refused ? e : new Refused(0, String(e));
            this.onChange();
            throw e;
        }
    }

    /** Lets go of an owner change the page has shown. */
    forgetOwnerChange(change: OwnerChange): void {
        const at = this.ownerChanges.indexOf(change);
        if (at >= 0) {
            this.ownerChanges.splice(at, 1);
            this.onChange();
        }
    }

    /**
     * Turns the node off, and closes the connection once it says OK: only the node itself, by its
     * button, its reset or its power, turns it on again. Only ever because the user asked, having
     * been told so. A try the node never answered is made once more, since OFF does no harm sent
     * twice; a node that is already off does not answer, and is taken as gone.
     */
    async turnOff(): Promise<void> {
        try {
            await this.request("OFF");
        } catch (e) {
            if (!(e instanceof Refused && e.code === 0 && !this.closed)) {
                throw e;
            }
            await this.request("OFF");
        }
        this.turnedOff = true;
        await this.close();
    }

    /**
     * Erases the node (WIPE, version 13): its address, sessions, contacts, groups, messages,
     * cards, positions, settings and Bluetooth bonds go for good, and it restarts as a new node that
     * must be paired again. Only ever because the user asked, having been told so. Once it says OK
     * the connection is closed; it is not asked twice, since a node that did not answer may be
     * erasing itself. Rejects with Refused if the node refused: ERROR 8 if it cannot now.
     */
    async wipe(): Promise<void> {
        await this.request("WIPE");
        this.wiped = true;
        await this.close();
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

    /**
     * A group's join code, as its link: the group's secret, which whoever sees it can read the
     * group with. Ask only when the user asked to see or share it, and keep it nowhere.
     */
    async groupLink(group: string): Promise<string> {
        return String((await this.request("GROUP_LINK", { group })).fields.link);
    }
    /**
     * Takes the group a join code is for, under the name it gives, and returns its id: the code as
     * the user gave it, which the node reads. Only when the user asked to join from it.
     */
    async joinLink(link: string): Promise<string> {
        return String((await this.request("JOIN_LINK", { link })).fields.group);
    }

    async read(through: number): Promise<void> {
        await this.request("READ", { through });
    }
    /**
     * Forgets the conversation with an address on the node and every client of it, for good: every
     * message and invite with it whose id is `through` or less (FORGET, version 16). Only ever because
     * the user asked, having been told so, with `through` the greatest id they were shown in it, so
     * that a message that arrives while they decide is not forgotten unseen. The node's FORGOTTEN
     * takes them from here.
     */
    async forget(contact: string, through: number): Promise<void> {
        await this.request("FORGET", { contact, through });
    }
    /** FORGET for a group's conversation: every group message to it whose id is `through` or less. */
    async forgetGroup(group: string, through: number): Promise<void> {
        await this.request("FORGET_GROUP", { group, through });
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
    async set(setting: Exclude<keyof typeof SETTING, "cards" | "cardName" | "receiver" | "wake" | "listen" | "lock">, value: number | string): Promise<void> {
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
        // Nor a field a later version added: an UPDATE_BEGIN to a node before version 13 carries
        // no signature.
        const frame = encode(type, seq, this.greeted ? fieldsFor(type, fields, this.version) : fields);
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
        if (this.closed || !this.keepAlive) {
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
            for (const tap of this.newsTaps) {
                tap(f);
            }
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
                    most: x.most === undefined ? null : x.most === 1,
                    pairing: x.pairing === undefined ? null : Number(x.pairing),
                    locked: x.locked === undefined ? null : x.locked === 1,
                };
                break;
            case "CONTACT":
                this.contacts.set(String(x.address), {
                    address: String(x.address),
                    name: String(x.name),
                    session: x.session === 1,
                    wake: x.wake === undefined ? 0 : Number(x.wake),
                    owner: x.owner === 1,
                    says: x.says === undefined ? "" : String(x.says),
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
                const id = Number(x.id);
                const now = { state: Number(x.state), reason: Number(x.reason), wait: Number(x.wait) };
                const m = this.messages.get(id);
                if (m) {
                    Object.assign(m, now);
                    break;
                }
                // A trace's, or a MANAGE's: it changes no message.
                const run = [...this.traces.values()].find((t) => t.id === id && tracing(t));
                if (run) {
                    Object.assign(run, now);
                } else {
                    this.otherStates.set(id, now);
                    if (this.otherStates.size > 16) {
                        this.otherStates.delete(this.otherStates.keys().next().value!);
                    }
                }
                break;
            }
            case "ROUTE":
                this.routes.set(Number(x.id), {
                    hops: Number(x.hops),
                    snr: Number(x.snr),
                    rssi: Number(x.rssi),
                    via: Number(x.via),
                    goes: Number(x.goes),
                    took: Number(x.took),
                });
                break;
            case "TRACED": {
                const to = Number(x.to);
                const id = Number(x.id);
                const ended: Traced = {
                    result: Number(x.result),
                    ...traceHops(String(x.entries), Number(x.out)),
                    snr: Number(x.snr),
                    took: Number(x.took),
                };
                const mine = this.traces.get(to);
                if (mine && (mine.id === id || (mine.id === null && tracing(mine)))) {
                    mine.id = id;
                    mine.ended = ended;
                } else if (!tracing(mine)) {
                    // Another client's trace, or one from before this connection: shown all the same.
                    this.traces.set(to, { to, id, state: null, reason: 0, wait: 0, ended, failed: null });
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
                this.asked.set(String(x.address), { why: Number(x.why), name: x.name === undefined ? "" : String(x.name) });
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
            case "FIX": {
                const receiver = Number(x.receiver);
                const source = Number(x.source);
                const known = Object.values(RECEIVER) as number[];
                this.fix = {
                    receiver: known.includes(receiver) ? receiver : RECEIVER.searching,
                    source,
                    lat: source === FIX_SOURCE.none ? 0 : Number(x.lat) / 1e7,
                    lon: source === FIX_SOURCE.none ? 0 : Number(x.lon) / 1e7,
                    altitude: source === FIX_SOURCE.none || x.altitude === -32768 ? null : Number(x.altitude),
                    accuracy: source === FIX_SOURCE.none || x.accuracy === 0 ? null : Number(x.accuracy),
                    satellites: Number(x.satellites),
                    fixedAt: this.now() - 1000 * Number(x.age),
                };
                if (this.syncSeen) {
                    this.syncSeen.fix = true;
                }
                break;
            }
            case "SLEEP":
                this.sleep = {
                    wake: Number(x.wake),
                    listen: Number(x.listen),
                    state: Number(x.state),
                    keeper: Number(x.keeper),
                    retryAt: Number(x.state) === SLEEP.resting ? this.now() + 1000 * Number(x.retry) : null,
                };
                if (this.syncSeen) {
                    this.syncSeen.sleep = true;
                }
                break;
            case "FORGOTTEN":
            case "GROUP_FORGOTTEN": {
                // Told outright, so taken even from a sync that missed news. A FORGOTTEN covers
                // messages and invites with the address, whose `contact` is it; a GROUP_FORGOTTEN
                // the group's messages, whose `contact` is the group's id, and not invites to it.
                const key = String(f.type === "FORGOTTEN" ? x.contact : x.group);
                const through = Math.max(this.forgotten.get(key) ?? 0, Number(x.through));
                this.forgotten.set(key, through);
                for (const [id, m] of this.messages) {
                    if (m.contact === key && id <= through) {
                        this.messages.delete(id);
                        this.routes.delete(id); // and how it went
                    }
                }
                break;
            }
            case "OWNER_CHANGED":
                this.ownerChanges.push({
                    from: String(x.from),
                    contact: String(x.contact),
                    owner: x.owner === 1,
                    by: Number(x.by),
                    at: this.now(),
                });
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
