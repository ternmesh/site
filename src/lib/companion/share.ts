// Sharing an address off the air: draft/sharing.md in ternmesh/spec. The text form, the link a
// node's QR code holds, reading either back, and the short code two people compare. Nothing here
// touches the network: everything in an address is in its link.

import { ADDRESS_LEN, unhex } from "./protocol.ts";

/** The link's start: the address follows it in base32. */
export const LINK = "HTTPS://TERNMESH.ORG/A/";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, section 6
const BASE32_LEN = 52;

/** RFC 4648 base32, upper-case and unpadded: five bits a character, most significant first. */
export function base32(bytes: Uint8Array): string {
    let n = 0;
    let bits = 0;
    let out = "";
    for (const byte of bytes) {
        n = ((n << 8) | byte) & 0xfff;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += BASE32[(n >> bits) & 31];
        }
    }
    if (bits > 0) {
        out += BASE32[(n << (5 - bits)) & 31];
    }
    return out;
}

/** The bytes of canonical base32 of any length, either case, or null: a character outside the
 * alphabet, a length no number of bytes has, or a spare bit set, which would give the same bytes
 * two spellings. */
function unbase32Any(text: string): Uint8Array | null {
    if ((text.length * 5) % 8 >= 5) {
        return null; // a last character that would carry no bit of any byte
    }
    const out = new Uint8Array(Math.floor((text.length * 5) / 8));
    let n = 0;
    let bits = 0;
    let k = 0;
    for (const ch of text.toUpperCase()) {
        const v = BASE32.indexOf(ch);
        if (v < 0) {
            return null;
        }
        n = ((n << 5) | v) & 0xfff;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out[k++] = (n >> bits) & 0xff;
        }
    }
    return (n & ((1 << bits) - 1)) === 0 ? out : null;
}

/** The 32 bytes of an address's canonical base32, either case, or null. */
function unbase32(text: string): Uint8Array | null {
    return text.length === BASE32_LEN ? unbase32Any(text) : null;
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The text form: sixty-four upper-case hex digits. `address` is hex, in either case. */
export function addressText(address: string): string {
    return address.toUpperCase();
}

/** The link a QR code holds. `address` is hex, in either case. */
export function addressLink(address: string): string {
    const a = unhex(address.toLowerCase());
    if (!a || a.length !== ADDRESS_LEN) {
        throw new Error("not an address");
    }
    return LINK + base32(a);
}

/**
 * An address as a person gives one, as 64 lower-case hex digits, or null: the link, its scheme,
 * host, path and base32 each in either case, or the text form, its digits in either case with
 * spaces anywhere among them. Whether the address is valid is not checked here: that is for
 * whatever keeps it as a contact.
 */
export function readAddress(text: string): string | null {
    // ASCII only: toUpperCase() makes ASCII of some other letters (a dotless i becomes I, a long
    // s becomes S), and those are neither base32 nor the link.
    if (!/^[\x00-\x7f]*$/.test(text)) {
        return null;
    }
    if (text.slice(0, LINK.length).toUpperCase() === LINK) {
        const a = unbase32(text.slice(LINK.length));
        return a ? hex(a) : null;
    }
    const digits = text.replaceAll(" ", "");
    return /^[0-9a-fA-F]{64}$/.test(digits) ? digits.toLowerCase() : null;
}

/** The short code: SHA-256("tern short code" || A), its first eight bytes big-endian, mod 10^12,
 * as three groups of four digits. */
export async function shortCode(address: string): Promise<string> {
    const a = unhex(address.toLowerCase());
    if (!a || a.length !== ADDRESS_LEN) {
        throw new Error("not an address");
    }
    const label = new TextEncoder().encode("tern short code");
    const input = new Uint8Array(label.length + a.length);
    input.set(label);
    input.set(a, label.length);
    const h = new DataView(await crypto.subtle.digest("SHA-256", input));
    return shortCodeText(h.getBigUint64(0) % 1_000_000_000_000n);
}

/** A short code's value as it is shown: twelve digits, leading zeros kept, in groups of four. */
export function shortCodeText(value: bigint): string {
    const d = value.toString().padStart(12, "0");
    return `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}`;
}

// --- Join codes: a group handed over off the air (draft/groups.md in ternmesh/spec) -------------

/** A join code's link starts so: the code follows the `#`, which a browser never sends. */
export const JOIN_LINK = "HTTPS://TERNMESH.ORG/G#";
const SECRET_LEN = 16;
const CODE_MIN = SECRET_LEN + 2;
const CODE_MAX = CODE_MIN + 31;

export interface JoinCode {
    /** The group's id, as the node and this client know it: 16 hex digits. */
    group: string;
    /** What whoever made the code calls the group: a suggestion. */
    name: string;
}

async function joinCheck(secret: Uint8Array, name: Uint8Array): Promise<Uint8Array> {
    const label = new TextEncoder().encode("tern group code");
    const input = new Uint8Array(label.length + secret.length + name.length);
    input.set(label);
    input.set(secret, label.length);
    input.set(name, label.length + secret.length);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input)).subarray(0, 2);
}

/** A group's id from its secret: Expand(G, "tern v0 group id", 8), HKDF-Expand with SHA-256. */
async function groupId(secret: Uint8Array): Promise<string> {
    const key = await crypto.subtle.importKey("raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
    ]);
    const info = new TextEncoder().encode("tern v0 group id");
    const t = new Uint8Array(info.length + 1);
    t.set(info);
    t[info.length] = 1;
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, t)).subarray(0, 8));
}

/**
 * The group a join code is for, and its name, or null: its scheme, host and `G` each in either
 * case, and its base32 in either case, and nothing else, a check that fails or a name that is not
 * UTF-8 included. The secret itself is not returned: a page shows the name and hands the node the
 * link, which is what the node reads, and keeps neither.
 */
export async function readJoinCode(text: string): Promise<JoinCode | null> {
    // ASCII only, as for an address's link.
    if (!/^[\x00-\x7f]*$/.test(text) || text.slice(0, JOIN_LINK.length).toUpperCase() !== JOIN_LINK) {
        return null;
    }
    const code = unbase32Any(text.slice(JOIN_LINK.length));
    if (!code || code.length < CODE_MIN || code.length > CODE_MAX) {
        return null;
    }
    const secret = code.subarray(0, SECRET_LEN);
    const raw = code.subarray(CODE_MIN);
    const check = await joinCheck(secret, raw);
    if (check[0] !== code[SECRET_LEN] || check[1] !== code[SECRET_LEN + 1]) {
        return null;
    }
    let name: string;
    try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
        return null;
    }
    const group = await groupId(secret);
    code.fill(0);
    return { group, name };
}
