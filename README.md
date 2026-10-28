# Courtside

Live streaming, recording and highlights for a sports club — run on your own
infrastructure, by your own club.

A parent points a phone at the court and presses one button. Everyone else
watches on a web page, catches up on what they missed, and sees highlight clips
during the breaks. Afterwards the whole match is there as a replay.

This repository is the whole thing: backend, website and camera app.

```
Camera app ──RTMP──▶ Restreamer ──HLS──▶ Backend ──▶ Object storage
   (iOS)                                    │              │
                                            └── Website ◀──┘
```

## Status

Courtside grew out of a system that has been running live matches for one club
since early 2026. It is being generalised so any club can run its own. Right
now:

| | State |
|---|---|
| Backend | Configurable per installation, no built-in credentials; survives a restart mid-match |
| Website | One prebuilt bundle, themed at runtime per club |
| Camera app | Pairs with a club at runtime — no backend compiled in, so one build serves any club |
| Install | From the landing page, courtside.apps.osaas.io: sign in with OSC, pick a name |
| Versions | Clubs run a release tag, see [CHANGELOG.md](CHANGELOG.md) |

## What you need

- An [Open Source Cloud](https://app.osaas.io) account (this is where Restreamer
  and the object storage run)
- Somewhere to run the backend, which also serves the website — OSC, or any
  Node 22 host (`npm run build && npm start` from the repository root)
- For the camera app: nothing, once it is on the App Store — a phone pairs with
  your installation by scanning a code. Until then, a Mac with Xcode and an
  Apple Developer account to build it yourself.

## What it costs

Roughly 17 tokens a day for a club playing a couple of matches a week — see
[docs/cost.md](docs/cost.md). Restreamer dominates the bill and is started on
demand for exactly that reason, so the cost follows hours broadcast rather than
calendar time.

## Components

### `api/` — backend

Fastify + TypeScript. Starts Restreamer on demand, collects HLS segments into
object storage for replay and DVR, cuts highlight clips, and serves the club
manifest the website themes itself from.

```bash
cd api
npm install
cp .env.example .env     # fill it in — the server refuses to start otherwise
npm run preflight        # checks the installation and says what is wrong
npm run dev
```

`npm run preflight` is the first thing to run after deploying. It reports
whether storage is reachable and writable, whether recordings are private,
whether the OSC token works, and whether access is protected — and for anything
that failed, what to do about it. The same checks are available to an admin at
`GET /api/admin/preflight`.

Every value that identifies *your* installation comes from the environment.
There are no built-in defaults for credentials, tenants or domains, which is
what makes this deployable by someone other than its author.

### `web/` — website

Vanilla JS, built with esbuild. Live view, replays, highlight carousel during
breaks, PIN-protected access, admin view.

```bash
cd web
npm install
npm run dev              # proxies /api to localhost:8000
npm run build            # -> dist/
```

The build contains no club identity. On load the page fetches `/api/club` and
applies the club's name, accent colour and logo. That is why one prebuilt
bundle can serve any club — and why changing your colours needs no rebuild.

In production the backend serves `web/dist` from its own origin, so the website
needs no backend URL. Only if you host the website somewhere else: set
`apiUrl` in `dist/runtime-config.js`. It is never bundled, so the edit needs no
rebuild.

### `camera/` — iOS camera app

SwiftUI + HaishinKit. One button to go live, pause and resume between periods,
and a button to save a highlight.

```bash
cd camera
cp Config.xcconfig.example Config.xcconfig   # bundle id only — no backend, no key
xcodegen                                      # generates the Xcode project
```

The app has no club compiled into it. On first run it asks to be paired: open
your admin view, choose **Lägg till kamera**, and scan the code. The phone gets
its own token, which you can revoke on its own from the same screen.

`xcodegen` clears `DEVELOPMENT_TEAM` — set your team in Xcode under
Signing & Capabilities after generating.

## Configuring your club

Club identity lives in the backend's environment and is served publicly over
`GET /api/club`:

| Variable | Meaning |
|---|---|
| `CLUB_NAME` | Display name, e.g. "Hammarby Courtside" |
| `CLUB_SHORT_NAME` | Default home team on new recordings |
| `CLUB_VENUE` | Default venue |
| `CLUB_ACCENT_COLOR` | Accent colour. **Quote it** — an unquoted `#` starts a comment in `.env` |
| `CLUB_LOGO_URL` | Your logo. Empty uses the placeholder shipped with the site |
| `CLUB_TAGLINE` | One line, used for social previews |

Sport terminology (what a break is called, how many periods, how long a clip is)
is part of the same manifest, so supporting other sports is configuration rather
than a rewrite. Today only basketball is defined.

## Security

- **Generate your own secrets.** `API_KEY`, `ADMIN_PIN` and `VIEWER_PIN` have no
  defaults. `openssl rand -hex 24` for the key.
- **Set a `VIEWER_PIN`.** Without one, anyone with the link can watch. This is
  usually youth sport.
- **Recordings are private.** The storage bucket has no public-read policy, and
  every segment, MP4 and thumbnail is reached through the API, which checks who
  is asking before redirecting to a short-lived signed URL. Video bytes still
  travel straight from storage to the viewer — the backend decides, it does not
  carry the traffic.
- **A shared clip link deliberately works without the PIN**, because that is the
  point of sending a highlight to a grandparent. A clip only exposes its own
  files: knowing one clip link never opens the rest of the match. Clip ids are
  64 bits, so they cannot be guessed.

## Privacy

You run this yourself, on your own storage, so the recordings are yours and your
club is responsible for them. That is deliberate. Decide on a retention period,
tell parents what is recorded and how long it is kept, and be able to delete a
match on request — the admin view can do that.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
