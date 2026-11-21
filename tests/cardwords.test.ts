// The node's own card and the nodes near that showed none, in the page's words
// (src/lib/app/cards.ts, as the apps' card settings and Nearby list say them).
import assert from "node:assert/strict";
import { test } from "node:test";

import { cardButtonText, cardChanges, heardOnlyText } from "../src/lib/app/cards.ts";

test("a name saved while the card is off goes before turning it on, and the button says so", () => {
    // What was reported: a name set, the card still off. The switch on, the name goes first.
    const f = { on: false, saved: "", wantOn: true, typed: "Hilltop" };
    assert.deepEqual(cardChanges(f), ["name", "cards"]);
    assert.equal(cardButtonText(f), "Save and turn on");
    assert.equal(cardButtonText({ ...f, typed: "" }), "Turn on");
    // Left off, the name alone is saved, and the button doesn't say on.
    assert.deepEqual(cardChanges({ ...f, wantOn: false }), ["name"]);
    assert.equal(cardButtonText({ ...f, wantOn: false }), "Save");
});

test("on already: only the name, or turning it off", () => {
    const f = { on: true, saved: "Hilltop", wantOn: true, typed: "Ridge" };
    assert.deepEqual(cardChanges(f), ["name"]);
    assert.equal(cardButtonText(f), "Save");
    assert.deepEqual(cardChanges({ ...f, typed: "Hilltop" }), []);
    assert.deepEqual(cardChanges({ ...f, typed: "Hilltop", wantOn: false }), ["cards"]);
    assert.equal(cardButtonText({ ...f, wantOn: false }), "Turn off");
});

test("a node heard with no card says why nothing can be done, and how to reach it", () => {
    assert.match(heardOnlyText(true, false), /haven't shared a card/);
    assert.match(heardOnlyText(true, false), /link or QR code/);
    assert.match(heardOnlyText(true, true), /You can't message or add it from here\./);
    assert.match(heardOnlyText(true, true), /about every two hours/);
    // A node too old for cards: waiting for one is no way to meet anyone.
    assert.doesNotMatch(heardOnlyText(false, false), /card/);
    assert.doesNotMatch(heardOnlyText(false, true), /card/);
});
