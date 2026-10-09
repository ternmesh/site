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

`src/pages/` holds the landing page, the app, the flash page, the apps, why Tern, the page a node's
link opens, privacy, and the 404, in `src/layouts/Base.astro`. `@astrojs/sitemap` writes
`sitemap-index.xml`, which `robots.txt` names, of every page but the node's and the 404.
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

It speaks version 6 of the protocol, as the phone apps do, and any earlier version a node speaks:
it reads each frame by the version both ends speak, and asks a node for nothing its version does
not define, saying on the node's card what an update would bring.

* **Groups:** making one, inviting a contact to it over their session, joining one from an
  invite, and writing to it. A group's secret never reaches the page: the node draws it and keeps
  it, and the page knows a group by an id.
* **Who is about:** the presence cards the node holds, each name in quotes as its sender's claim,
  beside the address's short code; Add puts the address and the name in the add form, for the user
  to keep or change. The node's own card is turned on and named only under **Your presence card**,
  which asks first and says what that puts on the air.
* **Positions:** the positions the node holds, each with a link that opens it on OpenStreetMap
  (followed only if clicked), and sharing the user's own with a contact or group from its
  conversation, at the precisions the specification lists. While the node shares with anyone, the
  page gives it the browser's location from `navigator.geolocation`, at most every 15 seconds, and
  only while the page is open.
* **Updates:** a node with a board and a release is offered the release in `/firmware/latest.json`
  for its board and region when it is later, by Semantic Versioning. The image is checked against
  the manifest's size and SHA-256 and sent over the same link, going on from where the node says
  after a dropped link.

| | |
|---|---|
| `src/lib/companion/protocol.ts` | The protocol's frames: built, read, wrapped for a byte stream and found in one. |
| `src/lib/companion/client.ts` | One connection: requests one at a time, the node's news, syncing again when some is missed, and keeping the node from taking the client for gone. |
| `src/lib/companion/serial.ts` | A node on a USB serial port, through Web Serial. |
| `src/lib/companion/bluetooth.ts` | A node over Bluetooth LE, through Web Bluetooth: pairing, and finding a node again after it restarts. |
| `src/lib/companion/updater.ts` | One firmware image given to a node: `UPDATE_BEGIN`, the image a chunk at a time from the offset the node gives, `UPDATE_END`, and going on after the link drops. |
| `src/lib/companion/release.ts` | `latest.json` as the page reads it: the image for a node's board and region, and Semantic Versioning's order. |
| `src/lib/companion/demo.ts` | A made-up node in the page, for "Try it without a board" and `/app?demo`. |
| `src/lib/companion/ids.ts` | Addresses as typed, and the routing id of one. |
| `src/lib/app/` | The page: what is drawn, and the conversations it keeps in the browser. |

`tests/vectors/companion.json` is a copy of the specification's
[`vectors/companion.json`](https://github.com/ternmesh/spec/blob/main/vectors/companion.json), and
`npm test` holds the client to it: every frame, every stream, and the specification's exchange
byte for byte, the older clients' frames read by their versions, and the update as its client.
When the specification's vectors change, copy the new file here in the pull
request that changes the code to match.

To check the client against a real board from a terminal, on macOS or Linux:

```bash
node tools/board.ts /dev/cu.usbserial-0001                    # what the node holds
node tools/board.ts /dev/cu.usbserial-0001 <address> "hello"  # and send a message
```

## The flash page

`/flash` puts the firmware on a Heltec V3 from the browser, over Web Serial: it asks where the
board will be used and whether it runs Tern already, fetches the images, checks them against the
release's SHA-256 checksums, and writes them with Espressif's
[esptool-js](https://github.com/espressif/esptool-js).

A release has four images for each region `<r>` (`us915`, `eu868`) and version `<v>`, and one
`SHA256SUMS` over all of them. The board's flash is NVS at 0x9000 to 0xF000 (its address,
contacts, sessions and bonds), otadata at 0xF000, and two 2 MB app slots at 0x20000 and 0x220000.

| | Written | |
|---|---|---|
| `tern-heltec-v3-<r>-<v>.bin` | at 0x0 | The whole flash, NVS blank. **New**: the board gets a new address. |
| `tern-heltec-v3-<r>-<v>-boot.bin` | at 0x0 | The bootloader and partition table, 0x9000 bytes: it stops where NVS starts. |
| `tern-heltec-v3-<r>-<v>-update.bin` | at 0xF000 | otadata blank, then the app in the first slot. |
| `tern-heltec-v3-<r>-<v>-app.bin` | over Bluetooth | The app alone, which the phone apps send. Not written over USB. |

**Update** writes `-boot.bin` and `-update.bin` in one session, both checked first, and refuses
either if it would reach NVS. It works on a board with the old one-app layout as well as the new
one, and keeps the board's NVS: after it, a node is in the two-slot layout and the phone apps can
update it. Releases up to 0.1.0-alpha.4 have neither file; for one of those, which
`tools/firmware.ts` and the page tell by its `SHA256SUMS`, an update writes `-app.bin` at 0x10000
as it used to, and the page does not mention the phone apps.

A page cannot read a GitHub release's files itself, so the site carries a copy.
`src/data/firmware.json` names the [firmware release](https://github.com/ternmesh/firmware/releases)
the site offers, and `tools/firmware.ts`, which `npm run build` and `npm run dev` run first, fetches its images
into `public/firmware/` (not kept in git) and refuses any that the release's `SHA256SUMS` does
not match. **To offer a new release, change the version there**; the build fails if no such
release exists, or if it names some of the update's images and not all.

| | |
|---|---|
| `src/lib/flash/images.ts` | The images a release has, by name, what each choice writes where, the check against its checksums, and `latest.json`. |
| `src/lib/flash/flash.ts` | Writing them to the board, checking it, and restarting the board. |
| `src/lib/flash/md5.ts` | MD5, which is how the board's bootloader says what it holds. |
| `src/lib/flash/page.ts` | The page. |

### latest.json: what the phone apps read

For a release in the two-slot layout, `tools/firmware.ts` also writes
`https://ternmesh.org/firmware/latest.json`, and the Tern phone apps read it to update a node
over Bluetooth. It is a contract with them: change it only with them.

```json
{
    "release": "0.1.0",
    "images": [
        {
            "board": "heltec-v3",
            "region": "EU868",
            "file": "tern-heltec-v3-eu868-0.1.0-app.bin",
            "size": 1234567,
            "sha256": "<64 hex digits>"
        }
    ]
}
```

* `release` is the version `src/data/firmware.json` pins, without the `v`.
* One entry per board and region. `region` is as the node reports it (`US915`, `EU868`): an app
  sends a node only the image for its own board and region. The order means nothing.
* `file` is relative to `/firmware/`, the app image alone. `size` is its length in bytes and
  `sha256` its SHA-256 in lowercase hex, both of the file this site serves, which is the
  release's (checked against its `SHA256SUMS`).
* A release from before the two-slot layout has no `latest.json`: its app is not one a phone may
  send. An app takes a missing file to mean there is nothing to update to.
* Fields may be added; none will be removed or change meaning without the apps.

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
fingerprint of its release key, which only the maintainers hold; CI on main prints it in its
summary), so a phone with the app opens a link in it and never asks the site for the page. The
debug build is a different package and is not named. `public/apple-app-site-association`, and its
copy in `public/.well-known/`, name the Apple app (`75ULBHU3YJ.org.ternmesh.tern`) for the same
paths, for its universal links; `public/_headers` serves both as JSON, which Apple asks for and a
file with no extension would not be.

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
