// @ts-check
import { defineConfig } from "astro/config";

// A static build: every page is HTML at build time and Cloudflare serves the files as they are.
// No adapter, because nothing here renders on request.
export default defineConfig({
    site: "https://ternmesh.org",
});
