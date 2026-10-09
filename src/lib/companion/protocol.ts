// The companion protocol's frames: version 7 of draft/companion.md in ternmesh/spec.
//
// Nothing here touches a port or the page. It builds frames, reads them, wraps them for a byte
// stream and finds them in one, and tests/protocol.test.ts holds it to the specification's
// vectors.

export const VERSION = 7;
export const MAX_FRAME = 180;
export const ANSWER_WAIT_MS = 5000;
export const IDLE_MS = 20000;
export const GAP_MS = 500;
export const ADDRESS_LEN = 32;
export const GROUP_LEN = 8;
export const DIGEST_LEN = 32;
export const TEXT_MAX = 128;
export const NAME_MAX = 31;
export const UPDATE_CHUNK = 172;
/** The longest a join code's link is (draft/groups.md). */
export const LINK_MAX = 102;

type Kind = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "addr" | "gid" | "digest" | "str" | "bytes";
/** How many bytes a field of fixed bytes is: an address, a group's id or a digest. */
const FIXED: Readonly<Partial<Record<Kind, number>>> = { addr: ADDRESS_LEN, gid: GROUP_LEN, digest: DIGEST_LEN };
const WIDTH: Readonly<Partial<Record<Kind, number>>> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4 };
/** A field: its name and kind, the longest a str or bytes may be, and the version that added it. */
type Field = readonly [name: string, kind: Kind, longest?: number, since?: number];

const sharing: readonly Field[] = [
    ["precision", "u8"],
    ["fields", "u8"],
    ["interval", "u16"],
    ["minutes", "u16"],
];
const position: readonly Field[] = [
    ["precision", "u8"],
    ["lat", "i32"],
    ["lon", "i32"],
    ["altitude", "i16"],
    ["accuracy", "u8"],
    ["age", "u32"],
];

// Every frame of version 7, by type: its name, its fields in order, and the version that added it.
// A field added at the end of a frame by a later version says so; a receiver reads a frame by the
// version both ends speak, so a node of version 2's SYNCED is the two bytes it is.
const FRAMES: Readonly<Record<number, readonly [name: string, fields: readonly Field[], since: number]>> = {
    0x01: ["HELLO", [["version", "u8"]], 0],
    0x02: ["SYNC", [["after", "u32"]], 0],
    0x03: ["PING", [], 0],
    0x04: ["SET_TIME", [["time", "u32"]], 0],
    0x05: ["SET", [["setting", "u8"]], 0],
    0x10: ["SEND", [["ref", "u32"], ["to", "addr"], ["text", "str", TEXT_MAX]], 0],
    0x11: ["READ", [["through", "u32"]], 0],
    0x18: ["SAVE_CONTACT", [["address", "addr"], ["name", "str", NAME_MAX]], 0],
    0x19: ["REMOVE_CONTACT", [["address", "addr"]], 0],
    0x1a: ["END_SESSION", [["address", "addr"]], 1],
    0x20: ["MAKE_GROUP", [["name", "str", NAME_MAX]], 2],
    0x21: ["LEAVE_GROUP", [["group", "gid"]], 2],
    0x22: ["NAME_GROUP", [["group", "gid"], ["name", "str", NAME_MAX]], 2],
    0x23: ["SEND_GROUP", [["ref", "u32"], ["group", "gid"], ["text", "str", TEXT_MAX]], 2],
    0x24: ["SEND_INVITE", [["group", "gid"], ["to", "addr"]], 2],
    0x25: ["JOIN", [["id", "u32"]], 2],
    0x26: ["GROUP_LINK", [["group", "gid"]], 7],
    0x27: ["JOIN_LINK", [["link", "str", LINK_MAX]], 7],
    0x30: ["UPDATE_BEGIN", [["size", "u32"], ["digest", "digest"]], 4],
    0x31: ["UPDATE_DATA", [["offset", "u32"], ["data", "bytes", UPDATE_CHUNK]], 4],
    0x32: ["UPDATE_END", [], 4],
    0x33: [
        "SET_POSITION",
        [["lat", "i32"], ["lon", "i32"], ["altitude", "i16"], ["accuracy", "u16"], ["age", "u16"]],
        5,
    ],
    0x34: ["SHARE", [["contact", "addr"], ...sharing], 5],
    0x35: ["SHARE_GROUP", [["group", "gid"], ...sharing], 5],
    0x40: ["OK", [], 0],
    0x41: ["ERROR", [["code", "u8"]], 0],
    0x42: [
        "INFO",
        [
            ["version", "u8"],
            ["firmware", "str", 31],
            ["board", "str", 31, 4],
            ["release", "str", 31, 4],
        ],
        0,
    ],
    0x43: ["SYNCED", [["news", "u8", undefined, 3]], 0],
    0x44: ["QUEUED", [["id", "u32"]], 0],
    0x45: ["MADE", [["group", "gid"]], 2],
    0x46: ["UPDATING", [["offset", "u32"]], 4],
    0x47: ["LINK", [["link", "str", LINK_MAX]], 7],
    0x80: [
        "SELF",
        [
            ["address", "addr"],
            ["role", "u8"],
            ["region", "str", 15],
            ["power", "i8"],
            ["time", "u32"],
            ["cards", "u8", undefined, 6],
            ["card_name", "str", NAME_MAX, 6],
        ],
        0,
    ],
    0x81: ["CONTACT", [["address", "addr"], ["session", "u8"], ["name", "str", NAME_MAX]], 0],
    0x82: ["CONTACT_GONE", [["address", "addr"]], 0],
    0x83: [
        "MESSAGE",
        [
            ["id", "u32"],
            ["contact", "addr"],
            ["time", "u32"],
            ["flags", "u8"],
            ["state", "u8"],
            ["reason", "u8"],
            ["wait", "u16"],
            ["text", "str", TEXT_MAX],
        ],
        0,
    ],
    0x84: ["STATE", [["id", "u32"], ["state", "u8"], ["reason", "u8"], ["wait", "u16"]], 0],
    0x85: ["NEIGHBOUR", [["routing_id", "u32"], ["role", "u8"], ["snr_quarter_db", "i8"], ["heard", "u16"]], 0],
    0x86: ["NEIGHBOUR_GONE", [["routing_id", "u32"]], 0],
    0x87: ["AIRTIME", [["period", "u32"], ["allowed", "u32"], ["used", "u32"], ["wait", "u32"]], 0],
    0x88: ["POWER", [["millivolts", "u16"], ["percent", "u8"], ["flags", "u8"]], 0],
    0x89: ["ASKED", [["address", "addr"], ["why", "u8"]], 1],
    0x8a: ["GROUP", [["group", "gid"], ["name", "str", NAME_MAX]], 2],
    0x8b: ["GROUP_GONE", [["group", "gid"]], 2],
    0x8c: [
        "GROUP_MESSAGE",
        [
            ["id", "u32"],
            ["group", "gid"],
            ["from", "u32"],
            ["time", "u32"],
            ["flags", "u8"],
            ["state", "u8"],
            ["reason", "u8"],
            ["wait", "u16"],
            ["text", "str", TEXT_MAX],
        ],
        2,
    ],
    0x8d: [
        "INVITE",
        [
            ["id", "u32"],
            ["contact", "addr"],
            ["group", "gid"],
            ["time", "u32"],
            ["flags", "u8"],
            ["state", "u8"],
            ["reason", "u8"],
            ["wait", "u16"],
            ["name", "str", NAME_MAX],
        ],
        2,
    ],
    0x8e: ["POSITION", [["contact", "addr"], ...position], 5],
    0x8f: ["GROUP_POSITION", [["group", "gid"], ["from", "u32"], ...position], 5],
    0x90: ["SHARING", [["contact", "addr"], ...sharing], 5],
    0x91: ["GROUP_SHARING", [["group", "gid"], ...sharing], 5],
    0x92: ["CARD", [["address", "addr"], ["heard", "u32"], ["name", "str", NAME_MAX]], 6],
    0x93: ["CARD_GONE", [["address", "addr"]], 6],
};

const TYPES: Readonly<Record<string, number>> = Object.fromEntries(
    Object.entries(FRAMES).map(([type, [name]]) => [name, Number(type)]),
);

// SET's value follows its setting, and its kind depends on which; each with the version that added it.
const SETTINGS: Readonly<Record<number, readonly [Field, number]>> = {
    1: [["value", "str", 15], 0],
    2: [["value", "u8"], 0],
    3: [["value", "i8"], 0],
    4: [["value", "u32"], 0],
    5: [["value", "u8"], 6],
    6: [["value", "str", NAME_MAX], 6],
};

export const SETTING = { region: 1, role: 2, power: 3, passkey: 4, cards: 5, cardName: 6 } as const;
/** Why a node refused first contact: ASKED's `why`. */
export const ASKED = { notContact: 1, noRoom: 2 } as const;

export const STATE = { waiting: 0, sent: 1, delivered: 2, notDelivered: 3, received: 4 } as const;

/** The version that added a request, which a client does not send to a node that speaks an earlier one. */
export function since(type: string): number {
    const t = TYPES[type];
    return t === undefined ? Infinity : FRAMES[t]![2];
}
/** The version that added a setting. */
export function settingSince(setting: number): number {
    return SETTINGS[setting]?.[1] ?? Infinity;
}

/** A field's value: a number, text, or an address, a group's id, a digest or bytes as lower-case hex. */
export type Value = number | string;
export type Fields = Record<string, Value>;

export interface Frame {
    type: string;
    seq: number;
    fields: Fields;
}

export function isRequest(type: number): boolean {
    return type >= 0x01 && type <= 0x3f;
}
export function isAnswer(type: number): boolean {
    return type >= 0x40 && type <= 0x7f;
}
export function isNews(type: number): boolean {
    return type >= 0x80 && type <= 0xbf;
}

export function hex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) {
        out += b.toString(16).padStart(2, "0");
    }
    return out;
}

/** The bytes a string of hex digits stands for, or null if it is not one. */
export function unhex(text: string): Uint8Array | null {
    if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) {
        return null;
    }
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
    }
    return out;
}

/** CRC-16/IBM-3740: over "123456789" it is 0x29B1. */
export function crc16(data: Uint8Array): number {
    let crc = 0xffff;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
        }
    }
    return crc;
}

/** A frame's fields, with SET's value after its setting; null for a type or setting not defined. */
function fieldsOf(type: number, setting: number | undefined): readonly Field[] | null {
    const frame = FRAMES[type];
    if (!frame) {
        return null;
    }
    if (frame[0] !== "SET") {
        return frame[1];
    }
    const value = setting === undefined ? undefined : SETTINGS[setting];
    return value ? [...frame[1], value[0]] : null;
}

/**
 * Builds a frame. Throws if the type is not one of this version's, a field is missing or of the
 * wrong kind, text or bytes are longer than their field allows, or the frame is longer than
 * MAX_FRAME: these are the caller's mistakes, not the wire's. A field a later version added at the
 * end of a frame is left out when it is not given, with every field after it: that is the frame
 * as an earlier version builds it.
 */
export function encode(type: string, seq: number, fields: Fields = {}): Uint8Array {
    const t = TYPES[type];
    const list = t === undefined ? null : fieldsOf(t, typeof fields.setting === "number" ? fields.setting : undefined);
    if (t === undefined || !list) {
        throw new Error(`not a frame of this version: ${type}`);
    }
    const out: number[] = [t, seq & 0xff];
    let ended = false;
    for (const [name, kind, longest, added] of list) {
        const v = fields[name];
        if (added !== undefined && (v === undefined || ended)) {
            if (v !== undefined) {
                throw new Error(`${type}.${name} is given without the fields before it`);
            }
            ended = true;
            continue;
        }
        const width = FIXED[kind];
        if (width !== undefined) {
            const bytes = typeof v === "string" ? unhex(v) : null;
            if (!bytes || bytes.length !== width) {
                throw new Error(`${type}.${name} is not ${width} bytes of hex`);
            }
            out.push(...bytes);
        } else if (kind === "str" || kind === "bytes") {
            const bytes = typeof v !== "string" ? null : kind === "str" ? new TextEncoder().encode(v) : unhex(v);
            if (!bytes) {
                throw new Error(`${type}.${name} is not ${kind === "str" ? "text" : "bytes as hex"}`);
            }
            if (bytes.length > (longest ?? 255)) {
                throw new Error(`${type}.${name} is longer than ${longest} bytes`);
            }
            out.push(bytes.length, ...bytes);
        } else {
            if (typeof v !== "number" || !Number.isInteger(v)) {
                throw new Error(`${type}.${name} is not a whole number`);
            }
            const size = WIDTH[kind]!;
            const n = v < 0 ? v + 2 ** (8 * size) : v;
            for (let i = size - 1; i >= 0; i--) {
                out.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
            }
        }
    }
    if (out.length > MAX_FRAME) {
        throw new Error(`${type} is ${out.length} bytes, more than a frame holds`);
    }
    return Uint8Array.from(out);
}

/**
 * Reads a frame by `version`, the one both ends speak, or returns null for one that is malformed
 * or of a type, or naming a setting, that version does not define. Bytes after the fields that
 * version defines are ignored, as the specification requires: that is how a later version adds a
 * field. An INFO is read by the lesser of `version` and the version it carries, since it is how a
 * client learns the node's.
 */
export function decode(frame: Uint8Array, version: number = VERSION): Frame | null {
    if (frame.length < 2 || frame.length > MAX_FRAME) {
        return null;
    }
    const def = FRAMES[frame[0]!];
    if (!def || def[2] > version) {
        return null;
    }
    const fields: Fields = {};
    let at = 2;
    let spoken = version;
    let list: readonly Field[] = def[1];
    for (let i = 0; i < list.length; i++) {
        const [name, kind, longest, added] = list[i]!;
        if (added !== undefined && added > spoken) {
            break; // and so is every field after it: later versions add only at the end
        }
        const width = FIXED[kind];
        if (width !== undefined) {
            if (at + width > frame.length) {
                return null;
            }
            fields[name] = hex(frame.subarray(at, at + width));
            at += width;
        } else if (kind === "str" || kind === "bytes") {
            const n = frame[at];
            if (n === undefined || n > (longest ?? 255) || at + 1 + n > frame.length) {
                return null;
            }
            const bytes = frame.subarray(at + 1, at + 1 + n);
            if (kind === "bytes") {
                fields[name] = hex(bytes);
            } else {
                try {
                    fields[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                } catch {
                    return null;
                }
            }
            at += 1 + n;
        } else {
            const size = WIDTH[kind]!;
            if (at + size > frame.length) {
                return null;
            }
            let v = 0;
            for (let k = 0; k < size; k++) {
                v = v * 256 + frame[at + k]!;
            }
            fields[name] = kind[0] === "i" && v >= 2 ** (8 * size - 1) ? v - 2 ** (8 * size) : v;
            at += size;
        }
        if (def[0] === "INFO" && name === "version") {
            spoken = Math.min(version, Number(fields.version));
        }
        if (def[0] === "SET" && name === "setting") {
            const value = SETTINGS[Number(fields.setting)];
            if (!value || value[1] > version) {
                return null;
            }
            list = [...def[1], value[0]];
        }
    }
    return { type: def[0], seq: frame[1]!, fields };
}

/** A frame as it goes on a byte stream: magic, length, the frame, and a CRC of the last two. */
export function wrap(frame: Uint8Array): Uint8Array {
    const out = new Uint8Array(frame.length + 6);
    out[0] = 0xf5;
    out[1] = 0x54;
    out[2] = frame.length >> 8;
    out[3] = frame.length & 0xff;
    out.set(frame, 4);
    const crc = crc16(out.subarray(2, 4 + frame.length));
    out[4 + frame.length] = crc >> 8;
    out[5 + frame.length] = crc & 0xff;
    return out;
}

export type Item = { frame: Uint8Array } | { text: Uint8Array };

/**
 * Finds frames in a byte stream, and the text between them: a node's console shares the port.
 * push() returns what the bytes so far complete, in order; what may yet be the start of a frame
 * is held (pending) until more arrives, or until stale() says nothing more is coming.
 */
export class StreamReader {
    private held: number[] = [];

    get pending(): Uint8Array {
        return Uint8Array.from(this.held);
    }

    push(data: Uint8Array): Item[] {
        this.held.push(...data);
        return this.take();
    }

    /** After GAP with nothing more: what is held is not the start of a frame after all. */
    stale(): Item[] {
        if (this.held.length === 0) {
            return [];
        }
        const first = this.held.shift()!;
        const rest = this.take();
        const head = rest[0];
        if (head && "text" in head) {
            const joined = new Uint8Array(1 + head.text.length);
            joined[0] = first;
            joined.set(head.text, 1);
            rest[0] = { text: joined };
            return rest;
        }
        return [{ text: Uint8Array.of(first) }, ...rest];
    }

    private take(): Item[] {
        const items: Item[] = [];
        let text: number[] = [];
        const flush = () => {
            if (text.length > 0) {
                items.push({ text: Uint8Array.from(text) });
                text = [];
            }
        };
        const b = this.held;
        let at = 0;
        while (at < b.length) {
            if (b[at] !== 0xf5) {
                text.push(b[at++]!);
                continue;
            }
            // What follows may be a frame: wait for as much as it takes to tell.
            if (at + 1 >= b.length) {
                break;
            }
            if (b[at + 1] !== 0x54) {
                text.push(b[at++]!);
                continue;
            }
            if (at + 4 > b.length) {
                break;
            }
            const length = (b[at + 2]! << 8) | b[at + 3]!;
            if (length < 2 || length > MAX_FRAME) {
                text.push(b[at++]!);
                continue;
            }
            if (at + 6 + length > b.length) {
                break;
            }
            const body = Uint8Array.from(b.slice(at + 2, at + 4 + length));
            const crc = (b[at + 4 + length]! << 8) | b[at + 5 + length]!;
            if (crc16(body) !== crc) {
                text.push(b[at++]!);
                continue;
            }
            flush();
            items.push({ frame: body.subarray(2) });
            at += 6 + length;
        }
        flush();
        this.held = b.slice(at);
        return items;
    }
}
