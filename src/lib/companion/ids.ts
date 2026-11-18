// What a client works out from an address: draft/routing.md and draft/first-contact.md in
// ternmesh/spec.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";

import { ADDRESS_LEN, unhex } from "./protocol.ts";
import { readAddress } from "./share.ts";

/**
 * The first companion version whose node makes routing ids from the key blinded from an address,
 * not from the address itself (draft/routing.md, "Routing ids"; draft/companion.md, "Starting").
 */
export const BLINDED_SINCE = 14;
/** The epoch blinding uses: 0, so that a node's routing id never changes. */
const EPOCH = 0;
const BLIND_LABEL = new TextEncoder().encode("tern v0 blind");
const L = ed25519.Point.CURVE().n;

/**
 * An address typed or pasted, as 64 lower-case hex digits, or null if it is not one: its digits,
 * or its link (draft/sharing.md), with what a paste brings round it trimmed and line breaks and
 * tabs among the digits taken as spaces. Digits with colons between them, as some tools print a
 * key, are taken too; the link is read first, since it has colons of its own.
 */
export function parseAddress(text: string): string | null {
    const t = text.trim().replace(/\s/g, " ");
    return readAddress(t) ?? readAddress(t.replaceAll(":", " "));
}

/**
 * The blinding factor and routing key of an address: h = SHA-512("tern v0 blind" || A || u32be(e)),
 * read little-endian, mod L, and B = [h]A. Null for an address that has no routing key: one that is
 * not a point, is not encoded as RFC 8032 encodes one, is of small order or has a part of small order
 * (draft/routing.md: a node derives a routing id only from a valid address), or whose h is 0. The
 * address and h are public, so nothing here needs to run in constant time.
 */
export function blind(address: Uint8Array): { h: bigint; key: Uint8Array } | null {
    if (address.length !== ADDRESS_LEN) {
        return null;
    }
    let a;
    try {
        a = ed25519.Point.fromBytes(address, false);
    } catch {
        return null;
    }
    if (a.isSmallOrder() || !a.isTorsionFree()) {
        return null;
    }
    const input = new Uint8Array(BLIND_LABEL.length + ADDRESS_LEN + 4);
    input.set(BLIND_LABEL);
    input.set(address, BLIND_LABEL.length);
    new DataView(input.buffer).setUint32(BLIND_LABEL.length + ADDRESS_LEN, EPOCH);
    const digest = sha512(input);
    let h = 0n;
    for (let i = digest.length - 1; i >= 0; i--) {
        h = (h << 8n) | BigInt(digest[i]!);
    }
    h %= L;
    if (h === 0n) {
        return null;
    }
    return { h, key: a.multiply(h).toBytes() };
}

/** The first of the eight u32s of SHA-256("tern routing id" || key) that is neither 0 nor 0xFFFFFFFF. */
async function idOf(key: Uint8Array): Promise<number> {
    const label = new TextEncoder().encode("tern routing id");
    const input = new Uint8Array(label.length + key.length);
    input.set(label);
    input.set(key, label.length);
    const h = new DataView(await crypto.subtle.digest("SHA-256", input));
    for (let i = 0; i < 32; i += 4) {
        const id = h.getUint32(i);
        if (id !== 0 && id !== 0xffffffff) {
            return id;
        }
    }
    return 1;
}

/**
 * The routing id of an address as a node of version 13 or earlier makes it, from the address
 * itself: SHA-256("tern routing id" || A). It is how a neighbour, which a node knows only by
 * routing id, is matched to a contact on such a node.
 */
export async function routingId(address: string): Promise<number> {
    const a = unhex(address);
    if (!a || a.length !== ADDRESS_LEN) {
        throw new Error("not an address");
    }
    return idOf(a);
}

/**
 * The routing id of an address as a node of version 14 or later makes it, from its routing key
 * (blind): SHA-256("tern routing id" || B). 0, which is no node's, for an address with no routing key.
 */
export async function blindedRoutingId(address: string): Promise<number> {
    const a = unhex(address);
    if (!a || a.length !== ADDRESS_LEN) {
        throw new Error("not an address");
    }
    const b = blind(a);
    return b ? idOf(b.key) : 0;
}

/** Ids worked out, by derivation and address: blinding takes a scalar multiplication. */
const known = new Map<string, number>();

/**
 * The routing id a node of companion version `version` gives for an address in NEIGHBOUR,
 * GROUP_MESSAGE and GROUP_POSITION: the blinded one from version 14, the address's own before.
 * Each is worked out once and kept.
 */
export async function routingIdFor(address: string, version: number): Promise<number> {
    const blinded = version >= BLINDED_SINCE;
    const key = `${blinded ? "b" : "a"}${address}`;
    const held = known.get(key);
    if (held !== undefined) {
        return held;
    }
    const id = await (blinded ? blindedRoutingId(address) : routingId(address));
    known.set(key, id);
    return id;
}

export function routingIdText(id: number): string {
    return id.toString(16).padStart(8, "0");
}
