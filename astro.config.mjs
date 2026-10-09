// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// A static build: every page is HTML at build time and Cloudflare serves the files as they are.
// No adapter, because nothing here renders on request.
export default defineConfig({
    site: "https://ternmesh.org",
    // sitemap-index.xml, for search engines. The page a node's link opens is kept out of them, as
    // its noindex says, and so is the 404.
    integrations: [sitemap({ filter: (page) => !/\/(node|404)\/?$/.test(new URL(page).pathname) })],
});
