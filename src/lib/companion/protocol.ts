// The companion protocol's frames: version 2 of draft/companion.md in ternmesh/spec.
//
// Nothing here touches a port or the page. It builds frames, reads them, wraps them for a byte
// stream and finds them in one, and tests/protocol.test.ts holds it to the specification's
// vectors.

export const VERSION = 2;
export const MAX_FRAME = 180;
export const ANSWER_WAIT_MS = 5000;
export const IDLE_MS = 20000;
export const GAP_MS = 500;
export const ADDRESS_LEN = 32;
export const GROUP_LEN = 8;
export const TEXT_MAX = 128;
export const NAME_MAX = 31;

type Kind = "u8" | "i8" | "u16" | "u32" | "addr" | "gid" | "str";
/** How many bytes a field of bytes is: an address, or a group's id. */
const BYTES: Readonly<Partial<Record<Kind, number>>> = { addr: ADDRESS_LEN, gid: GROUP_LEN };
type Field = readonly [name: string, kind: Kind, longest?: number];

// Every frame of version 2, by type: its name and its fields in order. END_SESSION and ASKED are
// what version 1 added; the requests from 0x20, MADE, and the news from 0x8a are version 2's, for
// groups.
const FRAMES: Readonly<Record<number, readonly [string, readonly Field[]]>> = {
    0x01: ["HELLO", [["version", "u8"]]],
    0x02: ["SYNC", [["after", "u32"]]],
    0x03: ["PING", []],
    0x04: ["SET_TIME", [["time", "u32"]]],
    0x05: ["SET", [["setting", "u8"]]],
    0x10: ["SEND", [["ref", "u32"], ["to", "addr"], ["text", "str", TEXT_MAX]]],
    0x11: ["READ", [["through", "u32"]]],
    0x18: ["SAVE_CONTACT", [["address", "addr"], ["name", "str", NAME_MAX]]],
    0x19: ["REMOVE_CONTACT", [["address", "addr"]]],
    0x1a: ["END_SESSION", [["address", "addr"]]],
    0x20: ["MAKE_GROUP", [["name", "str", NAME_MAX]]],
    0x21: ["LEAVE_GROUP", [["group", "gid"]]],
    0x22: ["NAME_GROUP", [["group", "gid"], ["name", "str", NAME_MAX]]],
    0x23: ["SEND_GROUP", [["ref", "u32"], ["group", "gid"], ["text", "str", TEXT_MAX]]],
    0x24: ["SEND_INVITE", [["group", "gid"], ["to", "addr"]]],
    0x25: ["JOIN", [["id", "u32"]]],
    0x40: ["OK", []],
    0x41: ["ERROR", [["code", "u8"]]],
    0x42: ["INFO", [["version", "u8"], ["firmware", "str", 31]]],
    0x43: ["SYNCED", []],
    0x44: ["QUEUED", [["id", "u32"]]],
    0x45: ["MADE", [["group", "gid"]]],
    0x80: ["SELF", [["address", "addr"], ["role", "u8"], ["region", "str", 15], ["power", "i8"], ["time", "u32"]]],
    0x81: ["CONTACT", [["address", "addr"], ["session", "u8"], ["name", "str", NAME_MAX]]],
    0x82: ["CONTACT_GONE", [["address", "addr"]]],
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
    ],
    0x84: ["STATE", [["id", "u32"], ["state", "u8"], ["reason", "u8"], ["wait", "u16"]]],
    0x85: ["NEIGHBOUR", [["routing_id", "u32"], ["role", "u8"], ["snr_quarter_db", "i8"], ["heard", "u16"]]],
    0x86: ["NEIGHBOUR_GONE", [["routing_id", "u32"]]],
    0x87: ["AIRTIME", [["period", "u32"], ["allowed", "u32"], ["used", "u32"], ["wait", "u32"]]],
    0x88: ["POWER", [["millivolts", "u16"], ["percent", "u8"], ["flags", "u8"]]],
    0x89: ["ASKED", [["address", "addr"], ["why", "u8"]]],
    0x8a: ["GROUP", [["group", "gid"], ["name", "str", NAME_MAX]]],
    0x8b: ["GROUP_GONE", [["group", "gid"]]],
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
    ],
};

const TYPES: Readonly<Record<string, number>> = Object.fromEntries(
    Object.entries(FRAMES).map(([type, [name]]) => [name, Number(type)]),
);

// SET's value follows its setting, and its kind depends on which.
const SETTINGS: Readonly<Record<number, Field>> = {
    1: ["value", "str", 15],
    2: ["value", "u8"],
    3: ["value", "i8"],
    4: ["value", "u32"],
};

export const SETTING = { region: 1, role: 2, power: 3, passkey: 4 } as const;
/** Why a node refused first contact: ASKED's `why`. */
export const ASKED = { notContact: 1, noRoom: 2 } as const;

export const STATE = { waiting: 0, sent: 1, delivered: 2, notDelivered: 3, received: 4 } as const;

/** A field's value: a number, text, or an address or a group's id as lower-case hex. */
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

function fieldsOf(type: number, fields: Fields): readonly Field[] | null {
    const frame = FRAMES[type];
    if (!frame) {
        return null;
    }
    if (frame[0] !== "SET") {
        return frame[1];
    }
    const value = SETTINGS[Number(fields.setting)];
    return value ? [...frame[1], value] : null;
}

/**
 * Builds a frame. Throws if the type is not one of this version's, a field is missing or of the
 * wrong kind, text is longer than its field allows, or the frame is longer than MAX_FRAME: these
 * are the caller's mistakes, not the wire's.
 */
export function encode(type: string, seq: number, fields: Fields = {}): Uint8Array {
    const t = TYPES[type];
    const list = t === undefined ? null : fieldsOf(t, fields);
    if (t === undefined || !list) {
        throw new Error(`not a frame of this version: ${type}`);
    }
    const out: number[] = [t, seq & 0xff];
    for (const [name, kind, longest] of list) {
        const v = fields[name];
        const width = BYTES[kind];
        if (width !== undefined) {
            const bytes = typeof v === "string" ? unhex(v) : null;
            if (!bytes || bytes.length !== width) {
                throw new Error(`${type}.${name} is not ${kind === "addr" ? "an address" : "a group's id"}`);
            }
            out.push(...bytes);
        } else if (kind === "str") {
            if (typeof v !== "string") {
                throw new Error(`${type}.${name} is not text`);
            }
            const bytes = new TextEncoder().encode(v);
            if (bytes.length > (longest ?? 255)) {
                throw new Error(`${type}.${name} is longer than ${longest} bytes`);
            }
            out.push(bytes.length, ...bytes);
        } else {
            if (typeof v !== "number" || !Number.isInteger(v)) {
                throw new Error(`${type}.${name} is not a whole number`);
            }
            const size = kind === "u32" ? 4 : kind === "u16" ? 2 : 1;
            for (let i = size - 1; i >= 0; i--) {
                out.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
            }
        }
    }
    if (out.length > MAX_FRAME) {
        throw new Error(`${type} is ${out.length} bytes, more than a frame holds`);
    }
    return Uint8Array.from(out);
}

/**
 * Reads a frame, or returns null for one that is malformed or of a type this version does not
 * define. Bytes after the fields this version defines are ignored, as the specification requires:
 * that is how a later version adds a field.
 */
export function decode(frame: Uint8Array): Frame | null {
    if (frame.length < 2 || frame.length > MAX_FRAME) {
        return null;
    }
    const def = FRAMES[frame[0]!];
    if (!def) {
        return null;
    }
    const fields: Fields = {};
    let at = 2;
    let list: readonly Field[] = def[1];
    for (let i = 0; i < list.length; i++) {
        const [name, kind, longest] = list[i]!;
        const width = BYTES[kind];
        if (width !== undefined) {
            if (at + width > frame.length) {
                return null;
            }
            fields[name] = hex(frame.subarray(at, at + width));
            at += width;
        } else if (kind === "str") {
            const n = frame[at];
            if (n === undefined || n > (longest ?? 255) || at + 1 + n > frame.length) {
                return null;
            }
            try {
                fields[name] = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(at + 1, at + 1 + n));
            } catch {
                return null;
            }
            at += 1 + n;
        } else {
            const size = kind === "u32" ? 4 : kind === "u16" ? 2 : 1;
            if (at + size > frame.length) {
                return null;
            }
            let v = 0;
            for (let k = 0; k < size; k++) {
                v = v * 256 + frame[at + k]!;
            }
            fields[name] = kind === "i8" && v > 127 ? v - 256 : v;
            at += size;
        }
        if (def[0] === "SET" && name === "setting") {
            const value = SETTINGS[Number(fields.setting)];
            if (!value) {
                return null;
            }
            list = [...def[1], value];
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
