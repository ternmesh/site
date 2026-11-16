import assert from "node:assert/strict";
import { test } from "node:test";

import { newerRelease } from "../src/lib/flash/offer.ts";

test("the latest release is offered over an earlier one", () => {
    assert.equal(newerRelease("0.5.0-alpha.2", ["v0.5.0-alpha.2", "v0.5.0-alpha.3", "v0.4.0-alpha.1"]), "0.5.0-alpha.3");
    assert.equal(newerRelease("0.5.0-alpha.3", ["v0.5.0"]), "0.5.0");
    assert.equal(newerRelease("0.5.0-alpha.9", ["v0.5.0-alpha.10"]), "0.5.0-alpha.10");
});

test("nothing, when the one offered is the latest", () => {
    assert.equal(newerRelease("0.5.0-alpha.2", ["v0.5.0-alpha.2", "v0.5.0-alpha.1", "v0.4.0-alpha.1"]), null);
    assert.equal(newerRelease("0.5.0-alpha.2", []), null);
});

test("by version, not by when it was published: a fix to an older line is not offered over a newer", () => {
    assert.equal(newerRelease("0.5.0", ["v0.4.1", "v0.5.0"]), null);
});

test("tags that are not a release's version are passed over", () => {
    assert.equal(newerRelease("0.5.0-alpha.2", ["latest", "v0.6", "0.6.0", "v0.6.0-", " v0.5.0-alpha.3\r"]), "0.5.0-alpha.3");
});
