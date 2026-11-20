// What the page knows of managing other nodes over the mesh (draft/managing.md), so that it offers to
// manage only the nodes the connected node owns, and says what a request is waiting for.
//
// Which nodes the connected node owns comes from the nodes themselves: an OWNER_CHANGED notice whose
// `contact` is the connected node's own address, an answer over the mesh (only owners are answered),
// or ERROR 15 (not an owner). Kept in this browser under the connected node's address, so two boards
// used from one browser do not mix; with how long each was last seen to sleep, to say how long a
// request to it may take.

import { Refused } from "../companion/client.ts";
import type { OwnerChange } from "../companion/client.ts";
import type { Progress } from "../companion/remote.ts";
import { MESH_ANSWER_WAIT_MS, SLEEP, STATE } from "../companion/protocol.ts";

/** What the page knows of one node it may manage. */
export interface Known {
    /** True: the connected node is one of its owners; false: it is not; absent: not known. */
    owner?: boolean;
    /** How long it sleeps between wakes, and listens after each, in seconds, as its last sync said: 0 if it does not sleep. */
    wake?: number;
    listen?: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;

export class Owned {
    /** The connected node's own address. */
    readonly node: string;
    private readonly key: string;
    private readonly storage: Store | null;
    private readonly known = new Map<string, Known>();
    /** The notices already taken, so that one the page still shows is not taken again over a later change. */
    private readonly taken = new WeakSet<OwnerChange>();

    /** Forgets what the page knows for a node that was erased (WIPE): its address names no node now. */
    static forget(node: string, storage: Pick<Storage, "removeItem"> | null): void {
        try {
            storage?.removeItem(`tern.owned.${node}`);
        } catch {
            // Not allowed: nothing to forget.
        }
    }

    /** `node` is the connected node's own address. */
    constructor(node: string, storage: Store | null) {
        this.node = node;
        this.key = `tern.owned.${node}`;
        this.storage = storage;
        try {
            const raw = storage?.getItem(this.key);
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === "object") {
                for (const [address, k] of Object.entries(parsed as Record<string, Known>)) {
                    if (k && typeof k === "object") {
                        this.known.set(address, {
                            ...(typeof k.owner === "boolean" ? { owner: k.owner } : {}),
                            ...(typeof k.wake === "number" ? { wake: k.wake } : {}),
                            ...(typeof k.listen === "number" ? { listen: k.listen } : {}),
                        });
                    }
                }
            }
        } catch {
            // Nothing kept, or nothing readable: nothing known.
        }
    }

    /** True if the connected node owns `address`, false if it does not, null if that is not known. */
    owner(address: string): boolean | null {
        return this.known.get(address)?.owner ?? null;
    }

    get(address: string): Known | undefined {
        return this.known.get(address);
    }

    /** Records whether the connected node owns `address`. */
    setOwner(address: string, owner: boolean): void {
        this.known.set(address, { ...this.known.get(address), owner });
        this.save();
    }

    /**
     * Learns from what came of a request over the mesh to `address`: an answer (`error` null) means
     * the connected node is an owner, ERROR 15 that it is not. Anything else, no answer among it,
     * says nothing: the node may be asleep or out of reach, or keep silent to a non-owner.
     */
    learn(address: string, error: unknown): void {
        if (error === null) {
            this.setOwner(address, true);
        } else if (error instanceof Refused && error.code === 15) {
            this.setOwner(address, false);
        }
    }

    /** Records how long `address` sleeps, from its sync: wake 0 if it does not. */
    setSleep(address: string, wake: number, listen: number): void {
        this.known.set(address, { ...this.known.get(address), wake, listen });
        this.save();
    }

    /**
     * Takes the notices that are about the connected node (`self`): it became an owner of `from`, or
     * stopped being one. Each is taken once. True if anything changed.
     */
    take(changes: readonly OwnerChange[], self: string): boolean {
        let changed = false;
        for (const c of changes) {
            if (this.taken.has(c)) {
                continue;
            }
            this.taken.add(c);
            if (c.contact === self && this.owner(c.from) !== c.owner) {
                this.known.set(c.from, { ...this.known.get(c.from), owner: c.owner });
                changed = true;
            }
        }
        if (changed) {
            this.save();
        }
        return changed;
    }

    private save(): void {
        try {
            this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.known)));
        } catch {
            // Full, or not allowed: known for this page only.
        }
    }
}

/**
 * How long a node sleeps between wakes, and listens after each, in seconds, as far as the page knows:
 * its last sync's SLEEP, if it was asleep, else the wake it said in the session (a contact's
 * `wake`). Null if nothing says it sleeps: then the page says nothing of sleep rather than guess.
 */
export function sleepOf(
    known: Known | undefined,
    contactWake: number,
    sync: { role: number; sleep: { wake: number; listen: number; state: number } | null } | null = null,
): { wake: number; listen: number } | null {
    if (sync && sync.sleep) {
        const asleep = sync.role === 0 && sync.sleep.state === SLEEP.asleep && sync.sleep.wake > 0;
        return asleep ? { wake: sync.sleep.wake, listen: sync.sleep.listen } : null;
    }
    if (known?.wake !== undefined) {
        return known.wake > 0 ? { wake: known.wake, listen: known.listen ?? 0 } : null;
    }
    return contactWake > 0 ? { wake: contactWake, listen: 0 } : null;
}

/** How long to wait for an answer once a request is delivered: MESH_ANSWER_WAIT, and a wake more for a node known to sleep. */
export function answerWaitMs(sleep: { wake: number; listen: number } | null): number {
    return sleep ? (sleep.wake + sleep.listen) * 1000 + MESH_ANSWER_WAIT_MS : MESH_ANSWER_WAIT_MS;
}

/** How long a request may take to be delivered: ten minutes, or a wake and an answer's wait for a node that sleeps longer. */
export function deliverWaitMs(sleep: { wake: number; listen: number } | null): number {
    return Math.max(600_000, answerWaitMs(sleep));
}

/** A wake in words: "5 min", "1 h". */
export function wakeWords(seconds: number): string {
    return seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

const WAITING_FOR = ["", "Finding a route", "", "Waiting for the region's limit", "Waiting for its share of the air", "Waiting for the radio"];

/**
 * What a request to `name` is waiting for, in a sentence, from its STATE news and what the page
 * knows of the node's sleep; with which try it is, after the first, of `tries`.
 */
export function stepText(p: Progress, name: string, sleep: { wake: number } | null, tries = 3): string {
    const asleep = sleep ? `${name} is asleep: it wakes every ${wakeWords(sleep.wake)}, so this can take up to ${wakeWords(sleep.wake)}.` : "";
    let step: string;
    switch (p.state) {
        case null:
            step = "Handing it to your node…";
            break;
        case STATE.waiting:
            if (p.reason === 2) {
                step = `Making first contact with ${name}…`;
            } else if (WAITING_FOR[p.reason]) {
                step = `${WAITING_FOR[p.reason]}${p.wait > 0 ? `, about ${p.wait} s` : ""}…`;
            } else {
                step = asleep || "Waiting…";
            }
            break;
        case STATE.sent:
            step = asleep || "On its way…";
            break;
        case STATE.delivered:
            step = `Delivered — waiting for ${name}'s answer…`;
            break;
        default:
            step = "Not delivered: trying again shortly…";
    }
    return p.attempt > 1 ? `${step} Try ${p.attempt} of ${tries}.` : step;
}
