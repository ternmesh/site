import assert from "node:assert/strict";
import { test } from "node:test";

import { ADDRESS, check, imageName, imageNames, parseSums, sha256 } from "../src/lib/flash/images.ts";

const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("an image's name is the release's", () => {
    assert.equal(imageName("0.1.0-alpha.1", "us915", "new"), "tern-heltec-v3-us915-0.1.0-alpha.1.bin");
    assert.equal(imageName("0.1.0-alpha.1", "eu868", "update"), "tern-heltec-v3-eu868-0.1.0-alpha.1-app.bin");
    assert.equal(imageNames("1.0.0").length, 4);
    assert.equal(ADDRESS.new, 0);
    assert.equal(ADDRESS.update, 0x10000);
});

test("checksums are read as sha256sum and shasum write them", () => {
    const sums = parseSums(`${abc}  a.bin\n${abc} *b.bin\n\n`);
    assert.equal(sums.get("a.bin"), abc);
    assert.equal(sums.get("b.bin"), abc);
    assert.throws(() => parseSums("<html>Not Found</html>\n"));
    assert.throws(() => parseSums(`${abc.slice(1)}  a.bin\n`));
});

test("an image that is not the release's is refused", async () => {
    const data = new TextEncoder().encode("abc");
    assert.equal(await sha256(data), abc);
    const sums = parseSums(`${abc}  a.bin\n`);
    await check("a.bin", data, sums);
    await assert.rejects(check("a.bin", new TextEncoder().encode("abd"), sums), /not the release's/);
    await assert.rejects(check("c.bin", data, sums), /does not name/);
});
