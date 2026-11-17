// Renders the screenshots the site shows of its own app, from the demo (/app?demo), into
// public/screenshots/. Not part of the build: run it by hand after the app changes, against a
// build, and commit the PNGs.
//   npm run build
//   npx playwright install chromium   (once, if no Chromium is installed)
//   node tools/screenshots.mjs
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const out = join(root, "public", "screenshots");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

// dist/ as Cloudflare serves it: a directory is its index.html.
const server = createServer((req, res) => {
    let path = normalize(join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!path.startsWith(dist) || !existsSync(path)) {
        res.writeHead(404).end();
        return;
    }
    if (statSync(path).isDirectory()) {
        path = join(path, "index.html");
    }
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

/** The demo, connected, with a conversation open: what the app is for. */
async function chat(scheme) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2 });
    await page.goto(`${base}/app?demo`);
    await page.locator(".talk-item", { hasText: "Robin" }).click();
    await page.locator("#messages").getByText("Kettle is on.").waitFor();
    // The app itself, tabs to conversation, without the site's header and footer: 1100 by 640.
    const live = await page.locator("#live").boundingBox();
    await page.screenshot({
        path: join(out, `chat-${scheme}.png`),
        clip: { x: live.x, y: live.y, width: live.width, height: 640 },
    });
    await page.close();
}

for (const scheme of ["light", "dark"]) {
    await chat(scheme);
}
await browser.close();
server.close();
console.log(`screenshots in ${out}`);
