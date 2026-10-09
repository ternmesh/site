// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// A static build: every page is HTML at build time and Cloudflare serves the files as they are.
// No adapter, because nothing here renders on request.
export default defineConfig({
    site: "https://ternmesh.org",
    // sitemap-index.xml, for search engines. The pages a node's link and a join code open are kept
    // out of them, as their noindex says, and so is the 404.
    integrations: [sitemap({ filter: (page) => !/\/(node|group|404)\/?$/.test(new URL(page).pathname) })],
});
