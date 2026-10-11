import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "../src/lib/companion/client.ts";
import { openDemo } from "../src/lib/companion/demo.ts";

test("the demo node takes every region a node has, and TH920 raises its power as a node does", async () => {
    const c = new Client(openDemo());
    await c.start();
    for (const r of ["CL915", "MY919", "RU868", "KZ863", "AU915", "NZ915"]) {
        await c.set("region", r);
        await new Promise((ok) => setTimeout(ok, 20));
        assert.equal(c.self?.region, r);
    }
    assert.equal(c.self?.power, 2);
    await c.set("region", "TH920");
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(c.self?.region, "TH920");
    assert.equal(c.self?.power, 14);
    await assert.rejects(c.set("region", "XX999"));
    c.close?.();
});
