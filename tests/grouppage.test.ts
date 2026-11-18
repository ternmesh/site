// The join code's page (draft/groups.md in ternmesh/spec, "What is at the link"): served with a
// policy that lets it run only the site's own scripts, load nothing from elsewhere and connect to
// nothing, at every path it is served at; and it takes the code out of the address before it
// shows it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** public/_headers as path -> header name (lower case) -> value. */
function headers(): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    let path: string | null = null;
    for (const line of readFileSync(new URL("../public/_headers", import.meta.url), "utf8").split("\n")) {
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            continue;
        }
        if (!/^\s/.test(line)) {
            path = line.trim();
            out.set(path, new Map());
            continue;
        }
        const at = line.indexOf(":");
        assert.ok(path && at > 0, line);
        out.get(path)!.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
    }
    return out;
}

test("the join code's page is served with a policy that keeps the code in the page", () => {
    const all = headers();
    for (const path of ["/G", "/g", "/group", "/group/*"]) {
        const h = all.get(path);
        assert.ok(h, `no headers for ${path}`);
        const csp = new Map(
            h.get("content-security-policy")!.split(";").map((d) => {
                const [name, ...values] = d.trim().split(/\s+/);
                return [name, values] as const;
            }),
        );
        assert.deepEqual(csp.get("default-src"), ["'none'"], path);
        assert.deepEqual(csp.get("script-src"), ["'self'"], path);
        assert.deepEqual(csp.get("connect-src"), ["'none'"], path);
        assert.deepEqual(csp.get("img-src"), ["'self'"], path);
        assert.deepEqual(csp.get("frame-ancestors"), ["'none'"], path);
        assert.equal(h.get("referrer-policy"), "no-referrer", path);
    }
});

test("the page takes the code out of the address before it reads it, and hands it on in no link", () => {
    const page = readFileSync(new URL("../src/lib/group/page.ts", import.meta.url), "utf8");
    const strip = page.indexOf("history.replaceState");
    assert.ok(strip > 0 && strip < page.indexOf("readJoinCode(link)"));
    assert.ok(!page.includes("#join="), "the code is handed to the app in the tab's storage");
});

test("the layout has no inline script, which the page's policy would refuse", () => {
    const layout = readFileSync(new URL("../src/layouts/Base.astro", import.meta.url), "utf8");
    assert.ok(!/<script[^>]*is:inline/.test(layout));
});
