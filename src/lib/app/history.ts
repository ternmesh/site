// What the page keeps of a node's messages, in this browser, so that a conversation outlives the
// node's memory: a node holds only its latest messages and, today, loses them when it restarts.
// Kept under the node's own address, so two boards used from one browser do not mix.

import { STATE } from "../companion/protocol.ts";
import type { Message, Route } from "../companion/client.ts";

export interface Kept {
    /** The node's id for it. With the time, it tells apart two messages that say the same thing
     * in the same second; alone it does not name one, since a node that restarts counts again. */
    id: number;
    /** Whom it is with: an address, or a group's id. */
    contact: string;
    time: number;
    incoming: boolean;
    state: number;
    text: string;
    /** A group message's writer, as its frame gave it; an invite, and the group it is to. */
    from?: number;
    invite?: boolean;
    group?: string;
    /** How it went, as the node's last ROUTE for it said (version 18), when it said. */
    route?: Route;
}

const LIMIT = 2000;

function sameMessage(a: Kept, b: Kept): boolean {
    return a.id === b.id && a.contact === b.contact && a.time === b.time && a.incoming === b.incoming && a.text === b.text;
}

function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
    return a === b || (!!a && !!b && a.hops === b.hops && a.snr === b.snr && a.rssi === b.rssi && a.via === b.via && a.goes === b.goes && a.took === b.took);
}

/** A ROUTE as storage gave it back, or undefined for none or one that is not one. */
function routeOf(r: unknown): Route | undefined {
    if (typeof r !== "object" || r === null) {
        return undefined;
    }
    const o = r as Record<string, unknown>;
    const keys = ["hops", "snr", "rssi", "via", "goes", "took"] as const;
    if (!keys.every((k) => typeof o[k] === "number")) {
        return undefined;
    }
    return { hops: o.hops as number, snr: o.snr as number, rssi: o.rssi as number, via: o.via as number, goes: o.goes as number, took: o.took as number };
}

export function keptFrom(m: Message, route?: Route): Kept {
    return {
        id: m.id,
        contact: m.contact,
        time: m.time,
        incoming: m.state === STATE.received,
        state: m.state,
        text: m.text,
        ...(m.from ? { from: m.from } : {}),
        ...(m.invite ? { invite: true, group: m.group } : {}),
        ...(route ? { route: { ...route } } : {}),
    };
}

/** Whether a message is where it will stay. A group message is, once sent: nothing answers it. */
function atRest(m: Message): boolean {
    return settled(m.state) || (m.state === STATE.sent && m.group !== "" && !m.invite);
}

/** Whether a message has come to rest: delivered, given up, or received. */
export function settled(state: number): boolean {
    return state >= STATE.delivered;
}

export class History {
    /**
     * Forgets what the page keeps of a node's messages: for a node that was erased (WIPE), which
     * comes back with a new address, and whose old one names no node.
     */
    static forget(node: string, storage: Pick<Storage, "removeItem"> | null): void {
        try {
            storage?.removeItem(`tern.history.${node}`);
        } catch {
            // Storage is off: there is nothing kept to forget.
        }
    }

    readonly kept: Kept[];
    private readonly key: string;
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;

    constructor(node: string, storage: Pick<Storage, "getItem" | "setItem"> | null) {
        this.key = `tern.history.${node}`;
        this.storage = storage;
        this.kept = [];
        try {
            const saved: unknown = JSON.parse(storage?.getItem(this.key) ?? "[]");
            if (Array.isArray(saved)) {
                for (const k of saved as Partial<Kept>[]) {
                    if (
                        typeof k.id === "number" &&
                        typeof k.contact === "string" &&
                        typeof k.time === "number" &&
                        typeof k.incoming === "boolean" &&
                        typeof k.state === "number" &&
                        typeof k.text === "string"
                    ) {
                        this.kept.push({
                            id: k.id,
                            contact: k.contact,
                            time: k.time,
                            incoming: k.incoming,
                            state: k.state,
                            text: k.text,
                            ...(typeof k.from === "number" ? { from: k.from } : {}),
                            ...(k.invite === true && typeof k.group === "string"
                                ? { invite: true, group: k.group }
                                : {}),
                            ...(routeOf(k.route) ? { route: routeOf(k.route)! } : {}),
                        });
                    }
                }
            }
        } catch {
            // Unreadable, or storage is off: the page works from what the node holds.
        }
    }

    /**
     * Takes in the node's messages that have come to rest, each with how it went from `routes`
     * (version 18) when the node said: a route kept stays until the node says another. A message
     * with no time cannot be told from another with the same words, so it is not kept: the node
     * shows it while it has it.
     */
    absorb(messages: Iterable<Message>, routes: ReadonlyMap<number, Route> = new Map()): void {
        let changed = false;
        for (const m of messages) {
            if (!atRest(m) || m.time === 0) {
                continue;
            }
            const k = keptFrom(m, routes.get(m.id));
            const had = this.kept.find((x) => sameMessage(x, k));
            if (!had) {
                this.kept.push(k);
                changed = true;
                continue;
            }
            if (had.state !== k.state) {
                had.state = k.state;
                changed = true;
            }
            if (k.route && !sameRoute(had.route, k.route)) {
                had.route = k.route;
                changed = true;
            }
        }
        if (!changed) {
            return;
        }
        this.kept.sort((a, b) => a.time - b.time || a.id - b.id);
        this.kept.splice(0, Math.max(0, this.kept.length - LIMIT));
        try {
            this.storage?.setItem(this.key, JSON.stringify(this.kept));
        } catch {
            // Full, or off: nothing is lost that the node still holds.
        }
    }

    /**
     * Lets go of what the user forgot (FORGOTTEN or GROUP_FORGOTTEN, version 16): every kept
     * message and invite with `contact`, an address or a group's id, whose id is `through` or less.
     * A group's invites are kept under the address they are with, so a group's record takes none.
     */
    forgotten(contact: string, through: number): void {
        this.drop((k) => k.contact === contact && k.id <= through);
    }

    /**
     * Lets go of these kept messages: those of a conversation the user deleted that were shown from
     * here alone, which a node that has counted again since may give ids its record does not cover.
     */
    discard(gone: readonly Kept[]): void {
        this.drop((k) => gone.some((g) => sameMessage(g, k)));
    }

    private drop(gone: (k: Kept) => boolean): void {
        const before = this.kept.length;
        for (let i = this.kept.length - 1; i >= 0; i--) {
            if (gone(this.kept[i]!)) {
                this.kept.splice(i, 1);
            }
        }
        if (this.kept.length === before) {
            return;
        }
        try {
            this.storage?.setItem(this.key, JSON.stringify(this.kept));
        } catch {
            // Off: nothing was kept to begin with.
        }
    }

    /**
     * How a message the node holds went, as this browser kept it: for a node that has said nothing
     * of it since, which a node that keeps no routes across a restart does not.
     */
    routeOf(m: Message): Route | undefined {
        const k = keptFrom(m);
        return this.kept.find((x) => sameMessage(x, k))?.route;
    }

    /** The kept messages of one conversation that the node no longer holds. */
    earlier(contact: string, live: Message[]): Kept[] {
        const now = live.map((m) => keptFrom(m));
        return this.kept.filter((k) => k.contact === contact && !now.some((n) => sameMessage(n, k)));
    }

    contacts(): Set<string> {
        return new Set(this.kept.map((k) => k.contact));
    }
}
