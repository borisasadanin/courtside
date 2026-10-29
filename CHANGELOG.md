# Changelog

Clubs run a released version, never the latest push. New platforms created on
courtside.apps.osaas.io get the newest release tag; an existing platform keeps
its version until its owner updates it: signed in on courtside.apps.osaas.io, a
platform with a newer release gets an **Uppdatera** button. It is refused while a
match is being broadcast, since the site is down for a few minutes during the rebuild.

**If a release goes wrong:** point the club's app back to the previous tag
(`api_git_ref` with Terraform, or the app's source ref in OSC) and it is rebuilt
from that. Recordings and settings stay in the club's storage and are not touched.

## Making a release

1. Set `version` in the root `package.json` to the new number. `/health` reports it.
2. Add a section below: what changed, in a few lines a team manager understands.
3. Commit, then tag that commit `vX.Y.Z` and push both: `git push origin master vX.Y.Z`.

From the moment the tag is pushed, new platforms get it (within five minutes).

## v0.2.0 — 2026-10-29

- New platforms get their own address, `shortname.apps.osaas.io`
- The admin can remove the whole platform: recordings, instances, settings, app and tokens
- Logo, name and colour in the admin view; the owner can always get back in with the OSC account
- The camera can be disconnected from its club in settings
- Installer: faster, retries passing OSC errors, explains the wait and what to do when it fails
- `/health` reports which version is running

## v0.1.0 — 2026-10-25

First public release: the kit, the pause flow and the landing-page installer.
