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

## v0.4.1 — 2026-10-30

Nytt utseende. Allt fungerar som förut, men det är lättare att hitta.

- På mobilen ligger menyn längst ner: Live, Repriser och Hantera, nåbara med tummen. På datorn sitter den
  i sidhuvudet
- Adminvyn heter nu Hantera. Överst finns adressen att dela, med en knapp som kopierar den. Varje del
  (Utseende, Koder, Om inspelningarna, Kameror, Inspelningar, Version) har en egen sida ett tryck bort.
  Kryssrutan "på begäran" och raderingsloggen ligger under Inspelningar
- Livesändningar visas som stora kort med en tydlig Titta-knapp, och det röda LIVE syns i sidhuvudet bara
  när någon sänder
- Ny typografi, större knappar och kort för repriser och höjdpunkter. Höjdpunktsspelaren lägger sig ovanför
  menyn på mobilen
- Text i klubbfärgen ljusas upp automatiskt om färgen är för mörk för att synas mot bakgrunden

## v0.4.0 — 2026-10-30

Dataskydd. Det är oftast barn på filmen, och föreningen ansvarar för det som spelas in.

- Tar ni bort en match försvinner nu också dess klipp. Tidigare låg klippen kvar och gick att se via delade
  länkar. Klipp från matcher som togs bort före den här versionen syns i adminvyn under "Klipp från
  borttagna matcher" och kan tas bort där
- Enskilda klipp går att ta bort i adminvyn. En delad länk till klippet slutar fungera direkt
- Adminvyn har en raderingslogg. Kryssa i att det ni tar bort görs på begäran, så noteras det. Loggen säger
  vad som togs bort och när, aldrig vem som bad om det
- Ett delat klipp kan fortfarande ses av den som får länken, med förhandsbild i till exempel WhatsApp. Det går
  däremot bara att ladda ner inifrån er Courtside, med tittarkoden
- Fyll i "Om inspelningarna" i adminvyn: ansvarig förening och en e-postadress för frågor. Tittarna ser det
  längst ner på sidan, vid tittarkoden och på delade klipp
- En ny plattform kräver en tittarkod. Att låta alla med adressen titta är ett val man kryssar i
- Kameraappen frågar efter ett kameranamn, som "Läktaren", i stället för den som filmar. Gäller nästa
  version av appen
- Texter till föräldrar och motståndarlag, och en skylt till hallen, finns på courtside.apps.osaas.io/gdpr

## v0.3.5 — 2026-10-30

- Plattformen kan uppdateras direkt från adminvyn: under Version syns vilken version ni kör, och finns en
  nyare kommer en knapp för att uppdatera. Det går inte medan en match sänds. Plattformar på v0.3.4 eller
  äldre behöver uppdateras från courtside.apps.osaas.io en sista gång för att få knappen
- Admin kan se tittarkoden och sätta nya koder under Koder i adminvyn. En ny admin-kod kräver den nuvarande.
  De gamla koderna slutar gälla direkt, och alla tittare behöver ange den nya
- Har man glömt admin-koden och inte kommer in alls gäller fortfarande "Glömt admin-koden?" på
  courtside.apps.osaas.io

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
