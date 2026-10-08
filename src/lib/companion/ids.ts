// What a client works out from an address: draft/routing.md and draft/first-contact.md in
// ternmesh/spec.

import { ADDRESS_LEN, unhex } from "./protocol.ts";

/** An address typed or pasted, as 64 lower-case hex digits, or null if it is not that. */
export function parseAddress(text: string): string | null {
    const digits = text.replace(/[\s:]/g, "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(digits) ? digits : null;
}

/**
 * The routing id of an address: the first of the eight u32s of SHA-256("tern routing id" || A)
 * that is neither 0 nor 0xFFFFFFFF. It is how a neighbour, which a node knows only by routing id,
 * is matched to a contact.
 */
export async function routingId(address: string): Promise<number> {
    const a = unhex(address);
    if (!a || a.length !== ADDRESS_LEN) {
        throw new Error("not an address");
    }
    const label = new TextEncoder().encode("tern routing id");
    const input = new Uint8Array(label.length + a.length);
    input.set(label);
    input.set(a, label.length);
    const h = new DataView(await crypto.subtle.digest("SHA-256", input));
    for (let i = 0; i < 32; i += 4) {
        const id = h.getUint32(i);
        if (id !== 0 && id !== 0xffffffff) {
            return id;
        }
    }
    return 1;
}

export function routingIdText(id: number): string {
    return id.toString(16).padStart(8, "0");
}
