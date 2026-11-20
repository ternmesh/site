// Links shown, copied or sent as text are lower-case at their start, so that a phone opens them in
// the Tern app; a QR code's stay upper-case; every reader takes both. And the intent:// link the
// page a link opens offers on Android.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    JOIN_LINK,
    LINK,
    TAP_JOIN_LINK,
    TAP_LINK,
    addressLink,
    addressTapLink,
    readAddress,
    readJoinCode,
    tappable,
} from "../src/lib/companion/share.ts";
import { androidIntent, phoneOf } from "../src/lib/openapp.ts";

const sharing = JSON.parse(readFileSync(new URL("./vectors/sharing.json", import.meta.url), "utf8"));
const groups = JSON.parse(readFileSync(new URL("./vectors/groups.json", import.meta.url), "utf8"));

test("a node's link as text is lower-case up to its base32, and reads back", () => {
    for (const c of sharing.cases) {
        const tap = addressTapLink(c.address);
        assert.equal(tap, TAP_LINK + c.base32);
        assert.equal(tap.toUpperCase(), addressLink(c.address)); // the QR code's, case aside
        assert.ok(addressLink(c.address).startsWith(LINK));
        assert.equal(readAddress(tap), c.address);
        assert.equal(readAddress(addressLink(c.address)), c.address);
    }
});

test("a join code's link as text is lower-case up to its code, and reads back the same", async () => {
    for (const c of groups.join_codes) {
        const tap = tappable(c.link);
        assert.ok(tap.startsWith(TAP_JOIN_LINK), tap);
        assert.equal(tap.slice(TAP_JOIN_LINK.length), c.link.slice(JOIN_LINK.length));
        assert.deepEqual(await readJoinCode(tap), await readJoinCode(c.link));
        assert.equal(tappable(tap), tap);
    }
});

test("anything that is not a link is left as it is", () => {
    for (const s of ["", "hello", "https://example.org/a/X", "HTTPS://TERNMESH.ORG/B/X"]) {
        assert.equal(tappable(s), s);
    }
});

test("the Android intent opens the same link in the app, or the apps page", () => {
    const c = sharing.cases[0];
    assert.equal(
        androidIntent(addressLink(c.address)),
        `intent://ternmesh.org/a/${c.base32}#Intent;scheme=https;package=org.ternmesh.app;` +
            "S.browser_fallback_url=https%3A%2F%2Fternmesh.org%2Fapps;end",
    );
    const j = groups.join_codes[0];
    const intent = androidIntent(j.link);
    // Android takes the data as all before the last #: the code's own # and code survive.
    assert.equal("https:" + intent.slice("intent:".length, intent.lastIndexOf("#")), tappable(j.link));
    assert.throws(() => androidIntent("hello"));
});

test("the package is the one assetlinks.json names", () => {
    const links = JSON.parse(readFileSync(new URL("../public/.well-known/assetlinks.json", import.meta.url), "utf8"));
    assert.ok(androidIntent(addressLink(sharing.cases[0].address)).includes(`package=${links[0].target.package_name};`));
});

test("apple-app-site-association and _redirects take both cases", () => {
    const aasa = JSON.parse(readFileSync(new URL("../public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
    const paths = aasa.applinks.details[0].components.map((c: { "/": string }) => c["/"]);
    for (const p of ["/a/*", "/A/*", "/g", "/G"]) {
        assert.ok(paths.includes(p), p);
    }
    const redirects = readFileSync(new URL("../public/_redirects", import.meta.url), "utf8");
    for (const p of ["/a/*", "/A/*", "/g ", "/G "]) {
        assert.ok(redirects.includes(`\n${p}`), p);
    }
});

test("which phone a browser is on", () => {
    assert.equal(phoneOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120"), "android");
    assert.equal(phoneOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari"), "ios");
    assert.equal(phoneOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari", "MacIntel", 5), "ios");
    assert.equal(phoneOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari", "MacIntel", 0), null);
    assert.equal(phoneOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"), null);
});
