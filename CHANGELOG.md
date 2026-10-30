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

## v0.3.4 — 2026-10-30

- Delade höjdpunkter går att öppna. Länken från Dela-knappen (till exempel i WhatsApp) gav tidigare
  "Route GET:/c/… not found"; nu visar den förhandsvisning i chatten och spelar klippet när man klickar

## v0.3.3 — 2026-10-30

- Parningskoden kan skannas med telefonens vanliga kamera: den öppnar Courtside-appen och kopplar kameran
  direkt. Tidigare öppnade den plattformens webbsida i Safari
- En kamera som redan är kopplad till en klubb byter inte klubb av en skanning, utan säger att den först
  ska kopplas bort under inställningar
- Kameraappen behöver vara byggd från den här versionen för att läsa den nya koden, även i appens egen skanner

## v0.3.2 — 2026-10-30

- Admin kan logga in även när matcherna är öppna för alla utan tittarkod. Tidigare ledde admin-koden
  till tittarsidan och Admin-fliken kom aldrig fram
- En felskriven kod ger "Fel kod" i stället för att släppa in en som tittare
- Utan tittarkod säger kodrutan att den är för admin, med en knapp för att titta utan kod

## v0.3.1 — 2026-10-30

- Inloggningen överlever en omstart eller uppdatering. Tidigare loggades admin och tittare ut i det tysta,
  och i adminvyn misslyckades sedan allt som sparades, till exempel byte av logotyp
- Byte av logotyp visar resultatet, eller felet, direkt bredvid knappen
- Har admin-inloggningen gått ut säger sidan det och ber om koden igen
- Adminvyn visar vilken Courtside-version plattformen kör

## v0.3.0 — 2026-10-29

- En parad kamera får starta och stänga sändningsmotorn och meddela tittare. Tidigare krävde de anropen
  API-nyckeln, så kameraappen kunde aldrig starta en sändning
- Kameran ser antalet tittare utan tittar-PIN
- Kameraappen kräver den här versionen: den säger till om plattformen är äldre och behöver uppdateras

## v0.2.0 — 2026-10-29

- New platforms get their own address, `shortname.apps.osaas.io`
- The admin can remove the whole platform: recordings, instances, settings, app and tokens
- Logo, name and colour in the admin view; the owner can always get back in with the OSC account
- The camera can be disconnected from its club in settings
- Installer: faster, retries passing OSC errors, explains the wait and what to do when it fails
- `/health` reports which version is running

## v0.1.0 — 2026-10-25

First public release: the kit, the pause flow and the landing-page installer.
