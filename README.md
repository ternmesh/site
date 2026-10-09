# ternmesh.org

The project website for **Tern**, a LoRa mesh protocol that treats airtime
as a shared, metered resource. A static [Astro](https://astro.build) site
served by Cloudflare as a Worker with static assets only: no code runs on a
request, and every page is an HTML file written at build time.

The site describes the protocol; it does not define it. The definition is
the specification in [ternmesh/spec](https://github.com/ternmesh/spec).

```bash
npm ci
npm run dev       # fetch the firmware release, then http://localhost:4321, reloads on save
npm run build     # fetch the firmware release, astro check (types), the static build into dist/
npm run preview   # build, then serve dist/ the way Cloudflare will (wrangler dev)
npm test          # the companion client against the specification's vectors
```

Node 22.18 or later: the build's own tools and the tests are TypeScript, run as it is.

* [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off
* [Governance](https://github.com/ternmesh/spec/blob/main/GOVERNANCE.md)

## Where the pages are

`src/pages/` holds the landing page, the app, the flash page, the page a node's link opens, and the 404, in `src/layouts/Base.astro`.
When the specification has a first draft, it will be rendered here from
`ternmesh/spec` at build time rather than copied into this repository, so
there is only ever one text of the protocol.

## The app

`/app` is a client for a Tern node, in the browser: plug a board in over USB, or reach one over
Bluetooth, and write to other nodes through it. It speaks the
[companion protocol](https://github.com/ternmesh/spec/blob/main/draft/companion.md) over Web
Serial, which Chrome and Edge on a computer have, and over Web Bluetooth, which they have on a
computer and on an Android phone. Nothing is sent anywhere but to the board, and nothing runs on
a server.

It speaks version 2 of the protocol, which has groups: making one, inviting a contact to it over
their session, joining one from an invite, and writing to it. A node whose firmware is from
before groups is asked for none. A group's secret never reaches the page: the node draws it and
keeps it, and the page knows a group by an id.

| | |
|---|---|
| `src/lib/companion/protocol.ts` | The protocol's frames: built, read, wrapped for a byte stream and found in one. |
| `src/lib/companion/client.ts` | One connection: requests one at a time, the node's news, syncing again when some is missed, and keeping the node from taking the client for gone. |
| `src/lib/companion/serial.ts` | A node on a USB serial port, through Web Serial. |
| `src/lib/companion/bluetooth.ts` | A node over Bluetooth LE, through Web Bluetooth: pairing, and finding a node again after it restarts. |
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

## The flash page

`/flash` puts the firmware on a Heltec V3 from the browser, over Web Serial: it asks where the
board will be used and whether it runs Tern already, fetches the image, checks it against the
release's SHA-256 checksums, and writes it with Espressif's
[esptool-js](https://github.com/espressif/esptool-js).

A page cannot read a GitHub release's files itself, so the site carries a copy.
`src/data/firmware.json` names the [firmware release](https://github.com/ternmesh/firmware/releases)
the site offers, and `tools/firmware.ts`, which `npm run build` and `npm run dev` run first, fetches its images
into `public/firmware/` (not kept in git) and refuses any that the release's `SHA256SUMS` does
not match. **To offer a new release, change the version there**; the build fails if no such
release exists.

| | |
|---|---|
| `src/lib/flash/images.ts` | The images a release has, by name, and the check against its checksums. |
| `src/lib/flash/flash.ts` | Writing one to the board, checking it, and restarting the board. |
| `src/lib/flash/md5.ts` | MD5, which is how the board's bootloader says what it holds. |
| `src/lib/flash/page.ts` | The page. |

To try images that are not released, point the build at the directory
`ports/heltec-v3/release.sh` leaves in the firmware repository:

```bash
TERN_FIRMWARE_DIR=../firmware/ports/heltec-v3/release npm run build
```

## A node's link

A node's QR code holds its link, `HTTPS://TERNMESH.ORG/A/` and its address in base32
([draft/sharing.md](https://github.com/ternmesh/spec/blob/main/draft/sharing.md)), so that a
phone's camera, with no Tern app, opens a page here. `public/_redirects` serves every `/A/…` and
`/a/…` with the one page, `src/pages/node.astro`, and keeps the URL as it was;
`src/lib/node/page.ts` reads the address out of it in the browser and shows it, with its short
code, a button to copy it and one to add it in the app (`/app?add=<address>`). Nothing is fetched,
and the page is kept out of search engines.

The address is in the URL's path, so the request for the page tells the site which address was
looked at: the specification says why it is not after a `#`. `observability` stays off in
`wrangler.jsonc` for that reason too: there are no request logs to keep.

`public/.well-known/assetlinks.json` names the Android app (`org.ternmesh.app`, by the
fingerprint of the key in its repository that signs its builds), so a phone with the app opens a
link in it and never asks the site for the page. The iOS app's `apple-app-site-association` waits
on it having a team to sign with.

| | |
|---|---|
| `src/lib/companion/share.ts` | The text form, the link and base32, reading either back, and the short code. `parseAddress()` in `ids.ts` goes through it, so the app's box takes a link as well as digits. |

`tests/vectors/sharing.json` is a copy of the specification's
[`vectors/sharing.json`](https://github.com/ternmesh/spec/blob/main/vectors/sharing.json), as of
[ternmesh/spec#21](https://github.com/ternmesh/spec/pull/21), and `npm test` holds `share.ts` to it.

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
