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
| Backend | Configurable per installation, no built-in credentials |
| Website | One prebuilt bundle, themed at runtime per club |
| Camera app | De-branded and configuration-driven, built per installation (builds clean on Xcode 26 / Swift 6.3) |
| One-command install | Not yet — see `docs/roadmap.md` |

## What you need

- An [Open Source Cloud](https://app.osaas.io) account (this is where Restreamer
  and the object storage run)
- Somewhere to run the backend — a Node 22 host, or OSC
- Somewhere to serve static files for the website
- For the camera app: a Mac with Xcode, and an Apple Developer account

## Components

### `api/` — backend

Fastify + TypeScript. Starts Restreamer on demand, collects HLS segments into
object storage for replay and DVR, cuts highlight clips, and serves the club
manifest the website themes itself from.

```bash
cd api
npm install
cp .env.example .env     # fill it in — the server refuses to start otherwise
npm run dev
```

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

After deploying, edit `dist/runtime-config.js` to point at your backend. It is
served as-is and never bundled, so that edit survives without a rebuild.

### `camera/` — iOS camera app

SwiftUI + HaishinKit. One button to go live, pause and resume between periods,
and a button to save a highlight.

```bash
cd camera
cp Config.xcconfig.example Config.xcconfig   # fill in backend URL and API key
xcodegen                                      # generates the Xcode project
```

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
- **Recordings are currently world-readable** if someone has the segment URL.
  The PIN protects the API, not the media files. Closing that gap is the next
  security item on the roadmap — consider it before opening your installation up.

## Privacy

You run this yourself, on your own storage, so the recordings are yours and your
club is responsible for them. That is deliberate. Decide on a retention period,
tell parents what is recorded and how long it is kept, and be able to delete a
match on request — the admin view can do that.

## Licence

Not yet decided. Until it is, treat this as all rights reserved.
