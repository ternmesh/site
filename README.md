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
npm test          # the companion client against the specification's vectors
```

Node 22.12 or later to build; the tests run TypeScript as it is, which needs Node 22.18 or later.

* [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off
* [Governance](https://github.com/ternmesh/spec/blob/main/GOVERNANCE.md)

## Where the pages are

`src/pages/` holds the landing page, the app and the 404, in `src/layouts/Base.astro`.
When the specification has a first draft, it will be rendered here from
`ternmesh/spec` at build time rather than copied into this repository, so
there is only ever one text of the protocol.

## The app

`/app` is a client for a Tern node, in the browser: plug a board in over USB and write to other
nodes through it. It speaks the [companion protocol](https://github.com/ternmesh/spec/blob/main/draft/companion.md)
over Web Serial, which Chrome and Edge on a computer have. Nothing is sent anywhere but to the
board, and nothing runs on a server.

| | |
|---|---|
| `src/lib/companion/protocol.ts` | The protocol's frames: built, read, wrapped for a byte stream and found in one. |
| `src/lib/companion/client.ts` | One connection: requests one at a time, the node's news, syncing again when some is missed, and keeping the node from taking the client for gone. |
| `src/lib/companion/serial.ts` | A node on a USB serial port, through Web Serial. |
| `src/lib/companion/demo.ts` | A made-up node in the page, for "Try it without a board" and `/app?demo`. |
| `src/lib/companion/ids.ts` | Addresses as typed, and the routing id of one. |
| `src/lib/app/` | The page: what is drawn, and the conversations it keeps in the browser. |

`tests/vectors/companion.json` is a copy of the specification's
[`vectors/companion.json`](https://github.com/ternmesh/spec/blob/main/vectors/companion.json), and
`npm test` holds the client to it: every frame, every stream, and the specification's exchange
byte for byte. When the specification's vectors change, copy the new file here in the pull
request that changes the code to match.

To check the client against a real board from a terminal, on macOS or Linux:

```bash
node tools/board.ts /dev/cu.usbserial-0001                    # what the node holds
node tools/board.ts /dev/cu.usbserial-0001 <address> "hello"  # and send a message
```

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
