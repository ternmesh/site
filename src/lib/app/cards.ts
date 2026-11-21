// The node's own presence card, and the nodes near it that showed none (draft/cards.md), in the
// user's words. Nothing here touches the page: the caller says what the node holds and what the
// form says, and is told what to send and what to call it.

/** What the card form asks for, against what the node holds. */
export interface CardForm {
    /** Whether the node's cards are on now. */
    on: boolean;
    /** The name the node's cards carry now. */
    saved: string;
    /** Whether the form's switch is on. */
    wantOn: boolean;
    /** The name in the form, trimmed. */
    typed: string;
}

/**
 * What applying the form sends, in order: the name, if it changed, and then cards on or off, if
 * that changed. The name goes first, so that a card turned on never goes out with the old one.
 */
export function cardChanges(f: CardForm): ("name" | "cards")[] {
    const out: ("name" | "cards")[] = [];
    if (f.typed !== f.saved) {
        out.push("name");
    }
    if (f.wantOn !== f.on) {
        out.push("cards");
    }
    return out;
}

/** What the form's button says it will do: turning the card on or off is named, not hidden in "Apply". */
export function cardButtonText(f: CardForm): string {
    if (f.wantOn && !f.on) {
        return f.typed !== f.saved ? "Save and turn on" : "Turn on";
    }
    if (!f.wantOn && f.on) {
        return "Turn off";
    }
    return "Save";
}

/**
 * Why a node heard with no card can be neither messaged nor added: all this node knows of it is a
 * routing id, not its address. `one` for the node chosen, rather than those listed; `cards` whether
 * the node speaks cards, without which waiting for one is no way to meet it; `look` whether it can
 * ask for them (LOOK, version 20), which brings them sooner.
 */
export function heardOnlyText(cards: boolean, one: boolean, look = false): string {
    const when = look
        ? "nodes showing a card send one about every two hours, or within half a minute if you ask who's about."
        : "nodes showing a card send one about every two hours.";
    if (one) {
        return cards
            ? "This node hears it, but it hasn't shared a card, so all this node knows is its short id, not whose it is. " +
                  "You can't message or add it from here. To talk to it, ask its owner for their link or QR code, or wait " +
                  `for its card: ${when}`
            : "This node hears it, but all it knows is its short id, not whose it is. You can't message or add it from " +
                  "here. To talk to it, ask its owner for their link or QR code.";
    }
    return cards
        ? "Those shown only by a short id haven't shared a card, so this node doesn't know who they are, and you " +
              "can't message or add them. To talk to one, ask its owner for their link or QR code, or wait for their " +
              `card: ${when}`
        : "Those shown only by a short id are all this node knows of them, not who they are, and you can't message or " +
              "add them. To talk to one, ask its owner for their link or QR code.";
}

/** Said once the node has asked the nodes in earshot for their cards (LOOK, version 20). */
export const LOOKED = "Asked the nodes in earshot for their cards. Those showing one answer within half a minute.";

/** ERROR 16 to LOOK, in the user's words: a node asks at most once in ASK_GAP, ten minutes. */
export const LOOK_TOO_SOON = "This node asked who's about less than ten minutes ago. Their cards are on their way, or try again in a few minutes.";
