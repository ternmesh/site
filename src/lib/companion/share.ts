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

/** The 32 bytes of canonical base32, either case, or null: wrong length, a character outside the
 * alphabet, or a spare bit set, which would give one address two links. */
function unbase32(text: string): Uint8Array | null {
    if (text.length !== BASE32_LEN) {
        return null;
    }
    const out = new Uint8Array(ADDRESS_LEN);
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
