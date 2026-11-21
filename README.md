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

`src/pages/` holds the landing page, the app, the flash page, the apps, why Tern, news, the pages a
node's link and a group's join code open, privacy, and the 404, in `src/layouts/Base.astro`; and the docs
under `src/pages/docs/`, in `src/layouts/Docs.astro`: start here, using Tern, hardware,
troubleshooting and the FAQ. The hardware page's boards are `src/data/boards.ts`, which follows the
firmware's `docs/boards.md`, and which of them the pinned release has an image for it reads from the
release's `SHA256SUMS` (`src/lib/boards.ts`). News is `src/data/news.ts`, newest first: a release
worth a word gets an entry by hand, since the site offers each release by itself (below).

The screenshots of the app (`public/screenshots/`) are of its demo, rendered by
`tools/screenshots.mjs` against a build, and the link preview (`public/og.png`) by
`tools/og/render.mjs`. Neither runs in the build: run one by hand after changing what it shows,
and commit the PNGs.
`@astrojs/sitemap` writes `sitemap-index.xml`, which `robots.txt` names, of every page but those
two and the 404.
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

Once a node is connected the page has the phone apps' layout: **Chats**, **People** and **Node**
tabs, down the side on a computer and along the foot on a phone, with the node's name and battery at
the head of each. Before then, it is where a node is connected from: USB, Bluetooth or the demo.

It speaks version 20 of the protocol, and any earlier version a node speaks:
it reads each frame by the version both ends speak, and asks a node for nothing its version does
not define, saying on the node's card what an update would bring.

* **Groups:** making one, inviting a contact to it over their session, joining one from an
  invite or a join code, showing a group's join code, and writing to it. The node draws a group's
  secret and keeps it, and the page knows a group by an id. The secret reaches the page only in a
  join code the user asked to see or joins from, which the page passes through and does not keep.
* **Who is about:** the presence cards the node holds, each name in quotes as its sender's claim,
  beside the address's short code; Add puts the address and the name in the add form, for the user
  to keep or change. The node's own card is turned on and named only under **Your presence card**,
  which asks first and says what that puts on the air. **Ask who's about** (version 20's `LOOK`)
  has the node ask the nodes in earshot for their cards, which come within half a minute as any
  card does; it is sent only when chosen, and `ERROR` 16, asked again within ten minutes, is said
  as such. A node of version 19 is not asked: the button is not shown.
* **Names in first contact** (version 19's `ASKED` `name` and `CONTACT` `says`): the name a node
  gave itself in its handshake, shown as its claim. Someone refused first contact is shown by the
  address's short code and the name it gave; **Let it in** offers that name for the user to keep or
  change. A contact the user gave no name is shown by its address with "says “…”" beside it, and
  Rename offers that name; the name the user gave is never replaced by it. Your presence card's name
  is the one the node gives, and the card's form says so for a node of version 19 or later.
* **Positions:** the positions the node holds, each with a link that opens it on OpenStreetMap
  (followed only if clicked), and sharing the user's own with a contact or group from its
  conversation, at the precisions the specification lists. While the node shares with anyone, the
  page gives it the browser's location from `navigator.geolocation`, at most every 15 seconds, and
  only while the page is open.
* **The node itself:** where it takes itself to be (version 8's `FIX`): the fix it shares from,
  its GPS's or the last an app gave it, on the node's card with a Map link like a position's, and
  what its GPS is doing. A node with a GPS has it turned on and off under **Settings** (`SET` 7).
  While the node's GPS has a fix, the page does not give it the browser's location.
* **Turning it off:** **Turn off**, beside Disconnect, for a node of version 9 (`OFF`). It asks
  first, saying that only the node itself turns it on again; once the node says OK the page closes
  the link, says so, and does not try to reach it again until the user connects.
* **Routing ids:** a neighbour, a group message's writer and a group member's position are known
  by routing id, which the page matches to the addresses it knows. A node of version 14 makes
  routing ids from the key blinded from each address (draft/routing.md, "Routing ids"): the page
  works out `B = [h]A` with [@noble/curves](https://github.com/paulmillr/noble-curves) and keeps each
  id it works out (`src/lib/companion/ids.ts`); for an earlier node it uses the address's own.
* **How each message went** (version 18's `ROUTE`): a line under each message. Received, "Direct ·
  SNR 6.5 dB" or "2 hops · SNR 4.8 dB", and a group message "≤2 hops", since its writer hides how
  far off it is. Sent, "Sent via Hilltop · try 2", then "Delivered via Hilltop · reply 2 hops ·
  19.6 s" or "Delivered direct · 1.2 s": the hops and signal are the acknowledgement's, on its way
  back. Choosing the line shows every field in words. The page keeps each message's last route with
  what it keeps of the message, and lets it go when the conversation is deleted.
* **Traces** (version 18's `TRACE` and `TRACED`): **Trace route** in a contact's details, and
  **Trace** beside each node heard nearby. The trace says where it is, then who answered or how far
  it got, and each node out and back with how well it heard the one before, and that a trace shows
  how frames went just then and that relays can misreport it. A leaf answers traces only from a
  node it has a session with, and the page says so. A routing id no contact has can be named, in
  this browser alone (`localStorage`, never sent). A node of version 17 is not asked: the button is
  disabled, with "Update the node's firmware to trace".
* **Range test**, on the Node tab or from a contact's details: "range #1", "range #2" and on to a
  contact every 30 to 60 s (30 by default), each logged with the browser's position (if allowed),
  delivered or not, hops, SNR, RSSI, round trip and the first neighbour, and downloaded as CSV. It
  holds a screen wake lock while it runs, where the browser has one. From a node of version 17 it
  logs only delivery.
* **Erasing it:** **Erase this node**, beside Turn off, for a node of version 13 (`WIPE`). It asks
  twice, saying that the node's address, contacts, groups and messages go for good and that it must
  be paired again. Once the node says OK the page forgets what it kept for the node and the
  browser's permission for it (`BluetoothDevice.forget()`), and says to remove it from the system's
  Bluetooth settings too.
* **Pairing:** when pairing fails the page says what the specification's pairing window asks: a
  node with no screen showing a passkey pairs only within three minutes of a press of its button or
  of being turned on (or RESET); one with a screen pairs with the passkey it shows.
* **Maximum transmit power:** **Use the most it may send at**, for a node of version 10. The node
  works out the highest permitted power for its board, antenna and region, and tells the page when
  that is the power it is using.
* **Updates:** a node with a board and a release is offered the release in `/firmware/latest.json`
  for its board and region when it is later, by Semantic Versioning, the way the node is updated:
  as its `INFO`'s `update` says from version 12, and over the link before then. The image is
  checked against the manifest's size and SHA-256 before anything is sent, and its signature
  (`signature`, below) against the [release keys](#the-release-keys), before it is downloaded and
  again after. An image signed by a release key is offered as it is. One with no signature, as every
  release up to 0.6.0-alpha.1, or one whose signature does not verify, is offered only behind a
  warning and **Install anyway**, except that one with no signature is not offered at all to a node
  of version 13 or later updated over the link: such a node takes only signed images, and the page
  says to update it over USB instead. From version 13 `UPDATE_BEGIN` carries the signature, and the
  page reads `ERROR` 11 to it as an image not signed by a key the node trusts.
  * **Over the link** (ESP32): the app image is sent over the same link, going on from where the
    node says after a dropped link.
  * **By the bootloader** (nRF52840, from firmware 0.6.0): the page asks the node to restart into
    its bootloader (`UPDATE_BOOTLOADER`), and the user chooses the bootloader in the browser's
    list (**Choose the node's bootloader**: Web Bluetooth lets a page reach a new device only from
    a click). The package's signature is checked before the node is asked, since the bootloader
    checks none, and the page says that until the update finishes anyone in Bluetooth range can
    install an image on the node. The page gives it the release's DFU package by Nordic's legacy DFU, as
    `tools/ble_dfu.py` in the firmware does, with the erase and the transfer shown as they go, about
    five minutes in all; then it connects to the node again over Bluetooth and checks the release it
    runs. A transfer that fails leaves the bootloader waiting, and **Try again** starts it over.
    An nRF52840 node whose bootloader takes nothing over Bluetooth (`update` 0) is pointed to the
    flash page.

| | |
|---|---|
| `src/lib/companion/protocol.ts` | The protocol's frames: built, read, wrapped for a byte stream and found in one. |
| `src/lib/companion/client.ts` | One connection: requests one at a time, the node's news, syncing again when some is missed, and keeping the node from taking the client for gone. |
| `src/lib/companion/serial.ts` | A node on a USB serial port, through Web Serial. |
| `src/lib/companion/bluetooth.ts` | A node over Bluetooth LE, through Web Bluetooth: pairing, and finding a node again after it restarts; and a node's bootloader, for an update. |
| `src/lib/companion/updater.ts` | How a node is updated, and one firmware image given to a node over the link: `UPDATE_BEGIN`, the image a chunk at a time from the offset the node gives, `UPDATE_END`, and going on after the link drops; or `UPDATE_BOOTLOADER`. |
| `src/lib/companion/dfu.ts` | A DFU package read from its zip, and given to an nRF52840 node's bootloader: Nordic's legacy DFU, with a receipt every ten packets. |
| `src/lib/companion/release.ts` | `latest.json` as the page reads it: the image for a node's board and region and the way it is updated, whether it is signed and may be offered, and Semantic Versioning's order. |
| `src/lib/companion/signing.ts` | Signed images: the message a release key signs, and checking a signature against the release keys, with [@noble/curves](https://github.com/paulmillr/noble-curves) in RFC 8032's strict mode. |
| `src/lib/companion/release-keys.ts` | The release keys: [below](#the-release-keys). |
| `src/lib/companion/demo.ts` | A made-up node in the page, for "Try it without a board" and `/app?demo`. |
| `src/lib/companion/ids.ts` | Addresses as typed, and the routing id of one: the address's own, or from version 14 the one from the key blinded from it. |
| `src/lib/app/` | The page: what is drawn, and the conversations it keeps in the browser. |

`tests/vectors/companion.json` is a copy of the specification's
[`vectors/companion.json`](https://github.com/ternmesh/spec/blob/main/vectors/companion.json), as of
[ternmesh/spec#60](https://github.com/ternmesh/spec/pull/60) (version 14), and `npm test` holds the client to it: every frame, every stream, and the specification's exchange
byte for byte, the older clients' frames read by their versions, the update as its client, signed,
the node that its bootloader updates, every case of `signatures`, and `wipe`.
`tests/vectors/routing.json` is a copy of the specification's
[`vectors/routing.json`](https://github.com/ternmesh/spec/blob/main/vectors/routing.json): each of
its `ids` gives the blinding, routing key and id the page works out, and none of its `no_ids` gives one. `tests/dfu.test.ts` holds the DFU client to a bootloader the test
plays.
When the specification's vectors change, copy the new file here in the pull
request that changes the code to match.

To check the client against a real board from a terminal, on macOS or Linux:

```bash
node tools/board.ts /dev/cu.usbserial-0001                    # what the node holds
node tools/board.ts /dev/cu.usbserial-0001 <address> "hello"  # and send a message
```

## The flash page

`/flash` offers every board in `src/data/boards.ts` that the pinned release has images for, each
saying whether it has been checked on a board. For an ESP32 or ESP32-S3 board it asks where the
board will be used and whether it runs Tern already, fetches the images, checks them against the
release's SHA-256 checksums, checks the chip is the board's, and writes them over Web Serial with
Espressif's [esptool-js](https://github.com/espressif/esptool-js). For an nRF52840 board it gives
the region's `.uf2` to copy onto the drive the board's bootloader shows (and, from 0.6.0, the board
takes later releases over Bluetooth from the phone apps or `/app`). `/flash?board=<name>`
opens on a board; the hardware page links each one that way.

For each ESP32 board `<b>`, a release has four images for each region `<r>` it carries (`us915`,
`eu868`, and from 0.4.0-alpha.1 `au915`, `nz915`, `cl915`, `my919`, `th920`, `ru868` and `kz863`)
and version `<v>`; for each nRF52840 board, one `tern-<b>-<r>-<v>.uf2` and, from 0.6.0, the same
firmware as a DFU package, `tern-<b>-<r>-<v>.zip`, for its bootloader to take over Bluetooth; and
one `SHA256SUMS` over all of them. A release from before 0.6.0 has no `.zip`, and its `SHA256SUMS`
says so; one that names a board's package for one region and not another fails the build. The site offers each board the regions that names for it. Every ESP32 board's flash
is laid out alike (the firmware's `ports/esp32/partitions*.csv`): NVS at 0x9000 to 0xF000 (its
address, contacts, sessions and bonds), otadata at 0xF000, and two app slots from 0x20000.

| | Written | |
|---|---|---|
| `tern-<b>-<r>-<v>.bin` | at 0x0 | The whole flash, NVS blank. **New**: the board gets a new address. |
| `tern-<b>-<r>-<v>-boot.bin` | at 0x0 | The bootloader and partition table, 0x9000 bytes: it stops where NVS starts. |
| `tern-<b>-<r>-<v>-update.bin` | at 0xF000 | otadata blank, then the app in the first slot. |
| `tern-<b>-<r>-<v>-app.bin` | over Bluetooth | The app alone, which the phone apps send. Not written over USB. |

**Update** writes `-boot.bin` and `-update.bin` in one session, both checked first, and refuses
either if it would reach NVS. It works on a board with the old one-app layout as well as the new
one, and keeps the board's NVS: after it, a node is in the two-slot layout and the phone apps can
update it. Releases up to 0.1.0-alpha.4 have neither file; for one of those, which
`tools/firmware.ts` and the page tell by its `SHA256SUMS`, an update writes `-app.bin` at 0x10000
as it used to, and the page does not mention the phone apps.

A page cannot read a GitHub release's files itself, so the site carries a copy.
`src/data/firmware.json` names the [firmware release](https://github.com/ternmesh/firmware/releases)
the site offers, and `tools/firmware.ts`, which `npm run build` and `npm run dev` run first, fetches its images
into `public/firmware/` (not kept in git, and about 300 MB for sixteen boards) and refuses any
that the release's `SHA256SUMS` does not match; the build fails if no such release exists, or if it names some of
the update's images and not all. **A new release is offered by itself:** every hour,
`.github/workflows/firmware.yml` looks for a firmware release later than the one named there, by Semantic
Versioning's order, and if there is one names it, runs the tests and the build, and commits it to `main`, which
Cloudflare deploys. *Run workflow* on its Actions page does it now. To offer another release by hand, change the
version there.

| | |
|---|---|
| `src/lib/flash/images.ts` | The images a release has, by name, what each choice writes where, the check against its checksums, and `latest.json`. |
| `src/lib/flash/flash.ts` | Writing them to the board, checking it, and restarting the board. |
| `src/lib/flash/md5.ts` | MD5, which is how the board's bootloader says what it holds. |
| `src/lib/flash/signatures.ts` | A release's `.sig` files, as `tools/firmware.ts` checks them. |
| `src/lib/flash/page.ts` | The page. |

**Signatures.** From the first signed release, each file a release carries has its signature beside
it, `<file>.sig`: 64 bytes, Ed25519 by a release key over `"TERN-FIRMWARE-V1"` and the file's
SHA-256 (the firmware's [`docs/signing.md`](https://github.com/ternmesh/firmware/blob/main/docs/signing.md)).
`tools/firmware.ts` takes a release as signed if it has `SHA256SUMS.sig`, or the first image's
`.sig`. For a signed release it fetches each image's `.sig` and `SHA256SUMS.sig`, checks each against
the release keys, keeps them beside the images, and gives each image's in `latest.json`; a `.sig`
that is missing, not 64 bytes, or does not verify fails the build, and the hourly workflow goes on
offering the release it offered before. A release from before signing (0.6.0-alpha.1 and earlier)
has no `.sig` at all, and builds exactly as it did, with no `signature` in `latest.json`. The flash
page checks each image's `.sig` before writing it, since a board takes anything over USB, and asks
before writing one that does not verify; for a release from before signing it says it cannot check
that the images are Tern's.

### The release keys

`src/lib/companion/release-keys.ts` lists the release keys, the Ed25519 public keys a release is
signed by: the same list as the firmware's
[`ports/node/release_keys.h`](https://github.com/ternmesh/firmware/blob/main/ports/node/release_keys.h),
which the nodes are built with. The app, the flash page and the feed all read it. Today it holds
release key 1, added 2026-11-18 ([ternmesh/firmware#120](https://github.com/ternmesh/firmware/pull/120)).
Adding a key is one line there, its 64 hex digits with a comment saying when it was added, in the
same pull request as, or before, the firmware release first signed with it; dropping one follows the
firmware dropping it. The specification's test key never goes there: the tests hand it in.

### latest.json: what the phone apps read

For a release in the two-slot layout, or with DFU packages, `tools/firmware.ts` also writes
`https://ternmesh.org/firmware/latest.json`, with every ESP32 board's app image for each region,
which a node takes over the companion link, and every nRF52840 board's DFU package for each region,
which its bootloader takes; the Tern phone apps and `/app` read it to update a node over Bluetooth.
It is a contract with the apps: change it only with them.

```json
{
    "release": "0.1.0",
    "images": [
        {
            "board": "heltec-v3",
            "region": "EU868",
            "file": "tern-heltec-v3-eu868-0.1.0-app.bin",
            "size": 1234567,
            "sha256": "<64 hex digits>",
            "signature": "<128 hex digits>"
        },
        {
            "board": "heltec-t114",
            "region": "US915",
            "file": "tern-heltec-t114-us915-0.1.0.zip",
            "size": 234567,
            "sha256": "<64 hex digits>",
            "update": "bootloader",
            "signature": "<128 hex digits>"
        }
    ]
}
```

* `release` is the version `src/data/firmware.json` pins, without the `v`.
* One entry per board and region. `region` is as the node reports it (`US915`, `EU868`, `AU915`, `NZ915` and the rest): an app
  sends a node only the image for its own board and region. The order means nothing.
* `file` is relative to `/firmware/`: the app image alone, or the DFU package. `size` is its length
  in bytes and `sha256` its SHA-256 in lowercase hex, both of the file this site serves, which is
  the release's (checked against its `SHA256SUMS`).
* `update` is `"bootloader"` for a DFU package, which the node's bootloader takes once the node has
  restarted into it (`UPDATE_BOOTLOADER`); an entry without it is an app image, sent over the
  companion link, which is every entry an app from before version 12 knows. An app picks the entry
  whose board and region match the node's `INFO`, and whose `update` (absent: the link) matches the
  node's `INFO` `update` (1: the link, 2: the bootloader). An entry with an `update` the app does
  not know is not one it can send. Before version 12 a node names its board only if it is updated
  over the link, so an older app is never offered a package.
* `signature`, from the first signed release, is the file's `.sig` as 128 lowercase hex digits:
  Ed25519 by a release key over `"TERN-FIRMWARE-V1"` and the 32 bytes of `sha256`, so an app can
  check it before downloading anything. A release from before signing has none.
* A release from before the two-slot layout, with no DFU package, has no `latest.json`: its app is
  not one a phone may send. An app takes a missing file to mean there is nothing to update to.
* Fields may be added; none will be removed or change meaning without the apps.

To try images that are not released, point the build at the directory
`ports/esp32/release.sh` or `ports/nrf52/release.sh` leaves in the firmware repository, named
for the version `src/data/firmware.json` pins:

```bash
TERN_FIRMWARE_DIR=../firmware/ports/esp32/release npm run build
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
summary), so a phone with the app opens a link in it, an address's or a join code's, and never asks the site
for the page. The
debug build is a different package and is not named. `public/apple-app-site-association`, and its
copy in `public/.well-known/`, name the Apple app (`75ULBHU3YJ.org.ternmesh.tern`) for the same
paths and for a join code's `/G` and `/g`, for its universal links; `public/_headers` serves both as JSON, which Apple asks for and a
file with no extension would not be.

| | |
|---|---|
| `src/lib/companion/share.ts` | The text form, the link and base32, reading either back, and the short code. `parseAddress()` in `ids.ts` goes through it, so the app's box takes a link as well as digits. |

`tests/vectors/sharing.json` is a copy of the specification's
[`vectors/sharing.json`](https://github.com/ternmesh/spec/blob/main/vectors/sharing.json), as of
[ternmesh/spec#21](https://github.com/ternmesh/spec/pull/21), and `npm test` holds `share.ts` to it.

## A group's join code

A group's join code hands the group over off the air
([draft/groups.md](https://github.com/ternmesh/spec/blob/main/draft/groups.md#join-codes)): a link,
`HTTPS://TERNMESH.ORG/G#` and the group's secret, a check and its name in base32, which a node
makes (`GROUP_LINK`) and takes a group from (`JOIN_LINK`, companion protocol version 7). Here the
code is after the `#`, which a browser sends to no site, so `public/_redirects` serves `/G` and
`/g` with the one page, `src/pages/group.astro`, whose `src/lib/group/page.ts` reads the code in
the browser, shows the group's name and what a code is, and hands it to the app after a `#` again
(`/app#join=<link>`). The app puts it in its "Join from a code" box and takes it out of the address
bar; the node joins only when the user presses Join and says yes to the group's name.

In the app, a group's page has a "Join code" button for a node of version 7: after a warning, the
node's link and a QR code of it, which the page holds only while it is shown. Neither phone app
claims `/G` yet, so neither file of app links names it.

| | |
|---|---|
| `src/lib/companion/share.ts` | `readJoinCode()`: the group's id and name from a code, every spelling the specification allows, and nothing else. |
| `src/lib/qr.ts` | QR codes, versions 1 to 5 at level L, from ISO/IEC 18004, with a join code's link in three segments so the `#` costs one byte. |

`tests/vectors/groups.json` is a copy of the specification's
[`vectors/groups.json`](https://github.com/ternmesh/spec/blob/main/vectors/groups.json), as of
[ternmesh/spec#32](https://github.com/ternmesh/spec/pull/32), and `npm test` holds `readJoinCode()`
to its join codes. `tests/vectors/qr.json` holds codes made with
[segno](https://github.com/heuer/segno) 1.6.6, its padding corrected (on a stream that already
ends on a byte it adds a zero byte the standard does not), and `npm test` holds `qr.ts` to them
module for module.

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
