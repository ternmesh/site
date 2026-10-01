# ternmesh.org

The project website for **Tern**, a LoRa mesh protocol that treats airtime
as a shared, metered resource. A static [Astro](https://astro.build) site
served by Cloudflare as a Worker with static assets only: no code runs on a
request, and every page is an HTML file written at build time.

The site describes the protocol; it does not define it. The definition is
the specification in [ternmesh/spec](https://github.com/ternmesh/spec).

```bash
npm ci
npm run dev       # http://localhost:4321, reloads on save
npm run build     # astro check (types) + the static build into dist/
npm run preview   # build, then serve dist/ the way Cloudflare will (wrangler dev)
```

Node 22.12 or later.

* [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off
* [Governance](https://github.com/ternmesh/spec/blob/main/GOVERNANCE.md)

## Where the pages are

`src/pages/` holds the landing page and the 404, in `src/layouts/Base.astro`.
When the specification has a first draft, it will be rendered here from
`ternmesh/spec` at build time rather than copied into this repository, so
there is only ever one text of the protocol.

## Deploying

Cloudflare builds and deploys on every push, from its Git integration
(Workers Builds). One-time setup in the dashboard:

1. **Workers & Pages → Create → Import a repository**, pick `ternmesh/site`.
2. **Build command** `npm run build`, **deploy command** `npx wrangler deploy`.
   The Worker's name must match `name` in `wrangler.jsonc` (`ternmesh-site`).
3. Turn on non-production branch builds for a preview URL per pull request.

`wrangler.jsonc` attaches `ternmesh.org` and `www.ternmesh.org` as custom
domains on deploy, which creates their DNS records and certificates. The
zone has to be active on the same Cloudflare account first.

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
