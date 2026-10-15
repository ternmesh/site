// Renders tools/og/card.html into public/og.png, the image a shared link shows.
// Not part of the build: run it by hand after changing the card, and commit the PNG.
//   npx -y playwright@1.56.1 install chromium   (once, if no Chromium is installed)
//   node tools/og/render.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const card = new URL("card.html", import.meta.url);
const out = fileURLToPath(new URL("../../public/og.png", import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(card.href);
await page.screenshot({ path: out });
await browser.close();
