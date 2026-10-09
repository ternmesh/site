// One firmware image given to a node, as "Updating the firmware" in draft/companion.md has it:
// UPDATE_BEGIN, the image's bytes from wherever the node says to go on from, and UPDATE_END.
//
// It makes its requests through whatever connection it is handed, and keeps no link of its own. A
// connection that goes leaves it waiting: on the next one, UPDATE_BEGIN says how much of the image
// the node holds, and it goes on from there. A chunk whose answer was lost goes again if the node
// does not hold it, which is safe, since a node takes the same bytes twice without holding them
// twice. UPDATE_END is never sent again: the node may be restarting into the image.

import { Refused } from "./client.ts";
import { UPDATE_CHUNK, hex } from "./protocol.ts";
import type { Fields, Frame } from "./protocol.ts";

export type UpdateState =
    /** Not begun, or the link went: run() on a connection goes on. */
    | "waiting"
    | "beginning"
    | "sending"
    | "ending"
    /** The node took the image and is restarting into it: its next INFO's release says whether it runs it. */
    | "restarting"
    /** UPDATE_END went unanswered: the node may be restarting into the image, or never had it. */
    | "unknown"
    /** The node refused it: `code` says why. */
    | "refused"
    | "cancelled";

/** How many ERROR 10s in a row, with no bytes taken between them, before an update is given up. */
const SENT_BACK = 3;
/** ERROR 6: the node took this client for gone, and acted on nothing until it says HELLO again. */
const HELLO_FIRST = 6;

/** Whether a failure leaves the update to go on on the next connection: no answer, a link gone, or a HELLO wanted. */
function goesOn(e: unknown): boolean {
    return !(e instanceof Refused) || e.code === 0 || e.code === HELLO_FIRST;
}

export type Ask = (type: string, fields?: Fields) => Promise<Frame>;

export class Updater {
    readonly size: number;
    state: UpdateState = "waiting";
    /** The node's code for a refusal. */
    code = 0;
    /** How many bytes of the image the node holds, as far as this client knows. */
    acknowledged = 0;
    onChange: (u: Updater) => void = () => {};

    private readonly image: Uint8Array;
    private readonly digest: string;
    /** Counts the runs, and cancelling: what an earlier one hears after is ignored. */
    private attempt = 0;

    private constructor(image: Uint8Array, digest: string) {
        this.image = image;
        this.digest = digest;
        this.size = image.length;
    }

    /** An updater for an image, with its SHA-256 worked out, which the node checks it against. */
    static async of(image: Uint8Array): Promise<Updater> {
        if (image.length < 1 || image.length > 0xffffffff) {
            throw new Error(`an image is 1 to 4294967295 bytes, not ${image.length}`);
        }
        const copy = image.slice();
        const digest = await crypto.subtle.digest("SHA-256", copy as Uint8Array<ArrayBuffer>);
        return new Updater(copy, hex(new Uint8Array(digest)));
    }

    /** Nothing more will be sent: it ended, one way or another. */
    get finished(): boolean {
        return !["waiting", "beginning", "sending", "ending"].includes(this.state);
    }

    /**
     * Begins the update on a connection whose node has answered HELLO, or goes on with it after the
     * link was lost, and resolves when it has finished or this connection can take it no further.
     */
    async run(ask: Ask): Promise<void> {
        if (this.finished) {
            return;
        }
        const mine = ++this.attempt;
        if (this.state === "ending") {
            // An UPDATE_END given up on is not sent again.
            this.set("unknown");
            return;
        }
        let sentBack = 0;
        try {
            for (;;) {
                this.set("beginning");
                const offset = Number((await ask("UPDATE_BEGIN", { size: this.size, digest: this.digest })).fields.offset);
                if (mine !== this.attempt) {
                    return;
                }
                if (!(offset <= this.size)) {
                    // Not an offset this image has: the node is not updating to it.
                    this.refuse(10);
                    return;
                }
                this.acknowledged = offset;
                try {
                    while (this.acknowledged < this.size) {
                        this.set("sending");
                        const from = this.acknowledged;
                        const until = Math.min(this.size, from + UPDATE_CHUNK);
                        await ask("UPDATE_DATA", { offset: from, data: hex(this.image.subarray(from, until)) });
                        if (mine !== this.attempt) {
                            return;
                        }
                        this.acknowledged = until;
                        sentBack = 0;
                    }
                } catch (e) {
                    // Sent back: the node is somewhere else in it. Asked again where, a few times.
                    if (e instanceof Refused && e.code === 10 && ++sentBack <= SENT_BACK) {
                        continue;
                    }
                    throw e;
                }
                this.set("ending");
                try {
                    await ask("UPDATE_END");
                } catch (e) {
                    if (mine === this.attempt) {
                        if (e instanceof Refused && e.code === HELLO_FIRST) {
                            // Not acted on: the next connection asks where it is and ends it then.
                            this.set("waiting");
                        } else if (e instanceof Refused && e.code !== 0) {
                            this.refuse(e.code);
                        } else {
                            this.set("unknown");
                        }
                    }
                    return;
                }
                if (mine === this.attempt) {
                    this.set("restarting");
                }
                return;
            }
        } catch (e) {
            if (mine !== this.attempt) {
                return;
            }
            if (goesOn(e)) {
                this.set("waiting"); // the next connection, or this one greeted again, goes on
            } else {
                this.refuse((e as Refused).code);
            }
        }
    }

    /** Stops sending. The node keeps what it was sent until it restarts or another update begins. */
    cancel(): void {
        if (this.finished || this.state === "ending") {
            return;
        }
        this.attempt++;
        this.set("cancelled");
    }

    private refuse(code: number): void {
        this.code = code;
        this.set("refused");
    }

    private set(s: UpdateState): void {
        this.state = s;
        this.onChange(this);
    }
}
