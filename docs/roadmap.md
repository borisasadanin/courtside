# Courtside — Roadmap mot en byggsats

**Mål (beslut 2026-09-28):** andra klubbar ska kunna starta hela systemet själva, i sin egen
OSC-tenant, och få helheten — live, inspelning, repriser och klipp. De driftar själva. Vi bygger
en byggsats, inte en tjänst vi säljer eller driftar.

Ordning:

1. **Prio 1 — Vem som helst kan starta plattformen och få helheten.**
2. **Steg 2 — White label:** klubben lägger in egen logo och egna färger.
3. **Steg 3 — Andra sporter än basket.**

Egna funktioner (t.ex. pausflödet i `tickets/ABL-001…005`) läggs in däremellan.

> `PLAN.md` beskriver den gamla enkelklubbs-fasplanen och är dessutom inaktuell mot koden.
> Det här dokumentet ersätter den som styrande plan. Pensionera `PLAN.md` när innehållet är flyttat.

---

## Definition av klar för prio 1

> En person som inte är Boris, med en egen OSC-tenant och en iPhone, kan på under 30 minuter få
> live + inspelning + repriser + klipp på sin egen adress — utan att fråga Boris någonting, och
> utan att öppna Xcode.

Allt i prio 1 mäts mot den meningen. Varje sak Boris tvingas göra manuellt i pilotinstallationen
(fas P3) är en bugg i P1 eller P2, inte en supportinsats.

---

## Vad som faktiskt står i vägen

Systemet är genomgående byggt för *en* klubb och *en* installation. Det är rätt design för Älta
och det enda som står mellan oss och en byggsats. Fyra axlar:

| Axel | Idag | Krav i byggsatsen |
|---|---|---|
| **Identitet** | `borispriv`, `altacourtside.se`, `prod-se`, instans- och bucketnamn och CORS-listan är hårdkodade | Allt injiceras vid installation |
| **Hemligheter** | Inbakade defaults i `config.ts`, PAT i klartext i `PLAN.md`, båda i git-historiken | Genereras per installation, inget committat |
| **Paketering** | Fyra delar som startas för hand; deploy är `remove` + `create` | Fyra delar som Terraform kan skapa |
| **Överlevnad utan support** | Driftstate i minnet, ingen preflight, ingen kostnadsbild | Checkpointat state, preflight som pekar på felet, dokumenterad kostnad |

Två säkerhetsposter gäller oavsett byggsats:

- **Läckta credentials.** OSC-PAT, MinIO root-secret, API-nyckel och admin-PIN ligger i repo och
  historik. Rotera innan något repo visas för någon.
- **Publik media.** `ensureBucket()` sätter `s3:GetObject` för alla. PIN skyddar API:et, inte videon.
  Det är barn på filmen.

### En fördel med byggsatsvalet, värd att skriva ner

Eftersom klubben driftar själv och äger sin egen lagring blir vi inte personuppgiftsbiträde för
deras matchvideo. Ansvaret ligger hos klubben. Vårt ansvar är att leverera **säkra
standardinställningar** — PIN påslagen, privat media, satt retention — och en kort text om vad
klubben ansvarar för. Det är billigare och renare än en SaaS hade varit.

---

## Leveransfordon: en OSC-solution

OSC har ett solutions-begrepp: en Terraform-modul i ett publikt GitHub-repo, registrerad i katalogen,
som komponerar flera tjänster och deployas med ett fåtal variabler. `crowdcast` (verifierad 2026-09-28)
tar tre variabler: ett namnprefix och två nycklar som *auto-genereras om de lämnas tomma*.

Det mönstret ger oss både namngivning och hemligheter gratis. Kompositionen:

| Del | Idag | I byggsatsen |
|---|---|---|
| Restreamer | En namngiven instans, skapad för hand | Katalogtjänst, namn från variabel |
| Lagring | MinIO + bucket `recordings` | Katalogtjänst, per klubb |
| Backend | Web Runner, secrets inbakade | **Egen katalogtjänst** med deklarerad konfiguration |
| Hemsida | MinIO-bucket-sökväg | My Page, en förbyggd bundle |
| Kamera | Lokalt byggd app med inbakad nyckel | En app i App Store som parar mot vilken installation som helst |

**Två konsekvenser att ta på allvar:**

1. **Backend bör bli en egen katalogtjänst.** En katalogtjänst deklarerar sin konfiguration, vilket
   tar bort hela ursäkten i `config.ts` för inbakade hemligheter. Det är den enskilda ändring som gör
   mest för prio 1.
2. **Frontendens white label-mekanik tvingas in i prio 1.** En solution deployar en *förbyggd*
   hemsida och kan inte baka in en logo vid build. Alltså måste temat läsas i runtime redan nu.
   Vad som väntar till steg 2 är självbetjäningen — adminvyn där man laddar upp logo och väljer färg.

### Kameran är den faktiska grinden

Terraform kan inte deploya en iOS-app. Kräver vi att varje klubb bygger appen själv behöver de
Apple Developer Program, Xcode, xcodegen och kodsignering — och då får de live men ingen kamera,
alltså inte helheten. Definition av klar faller.

Lösningen kräver inget kontrollplan: **vi publicerar en app** utan inbakad backend. Vid första start
skannas en QR från klubbens egen adminvy; payloaden bär backend-URL och en enhetstoken som klubbens
egen backend utfärdar. Parning utan register. Det ersätter samtidigt den delade `X-API-Key`, som är
det sämsta att skicka med i en byggsats.

`crowdcast` visar att telefonkamera via webbläsare fungerar på samma plattform. En WHIP-baserad
webbsändare skulle ta bort appberoendet helt och ge Android — inte prio 1, men rätt utväg om
App Store blir tungt.

---

## Faser

### P0 — Säkra dagens system

Först, för att allt annat bygger på roterade nycklar.

- [ ] **ABL-006** Rotera OSC-PAT, MinIO-nyckel, API-nyckel och admin-PIN. Ut ur `PLAN.md` och
      ur koden som värden. *Att ta bort defaults ur `config.ts` kräver konfigurationsinjektion och
      ligger därför i ABL-008 — men värdena roteras nu.*

### P1 — Konfigurerbart och paketerbart (kärnan i prio 1)

- [x] **ABL-007** Klubbmanifest. Bort med hårdkodad tenant, domän, region, instans- och bucketnamn.
      Inklusive **CORS-listan i `index.ts`**, som är låst till `altacourtside.se` och tyst skulle
      blockera varje annan klubb.
- [ ] **ABL-008** Backend som OSC-katalogtjänst med deklarerad konfiguration. Bort från Web Runner,
      bort med inbakade defaults, faila hårt vid avsaknad. Ger rullande deploy som bieffekt.
- [x] **ABL-009** Frontend: en bundle för alla. Klubbidentitet och tema från `/api/club`,
      färger som CSS-variabler. *Mekaniken för steg 2.*
- [x] **ABL-010** Kameraapp utan inbakad backend: QR-parning och per-enhetstokens som ersätter den
      delade API-nyckeln.
- [x] **ABL-011** Checkpointa `streamMeta` och segmenttidslinjen till klubbens egen objektlagring.
      **Ingen ny backing-tjänst** — varje extra tjänst i solutionen är en kostnad och ett felläge till.
      Syftet är smalt: en omstart mitt i match får inte förstöra matchen.
- [x] **ABL-012** Preflight. En främling har ingen att fråga. Verifiera tenant, tjänstekvot, att
      Restreamer svarar, att RTMP är påslaget, att lagringen går att skriva till — och skriv ut vad
      som är fel. `/health` är grunden.
- [x] **ABL-013** VOD-playlist serveras av API:et i stället för som statisk fil i lagringen.
      Förutsättning för ABL-014.
- [x] **ABL-014** Privat media. Stäng publik läsning; injicera kortlivade signerade segment-URL:er i
      de playlists vi redan genererar server-side (DVR, klipp, och VOD via ABL-013).

### P2 — Solutionen

- [ ] **ABL-015** Terraform-modul som komponerar Restreamer + lagring + backend + hemsida, med ett
      `club_name` och auto-genererade hemligheter.
- [~] **ABL-016** Installationsdokumentation och **kostnadsuppskattning per månad**. Kostnadsdelen klar (`docs/cost.md`). En klubb behöver
      siffran innan de börjar; `estimate-service-cost` finns för att ta fram den.
- [ ] **ABL-017** Licensval och publicering. Repo att klona, eller inskickat till OSC-katalogen.

### P3 — Pilotinstallation (validering, inte teori)

- [ ] **ABL-018** En riktig annan klubb, egen tenant, noll handpåläggning. Detta är grinden för
      prio 1 — inte en demo.

### Plan och adress (beslut 2026-10-01)

- **Baspaketet körs på OSC Personal** (15 EUR/mån, 40 tokens/dygn). Det räcker för ~2 matcher i veckan, se
  `docs/cost.md`.
- **Klubben får den adress plattformen ger:** `<hash>.apps.osaas.io`. Egna namn kräver Professional
  (HTTP 402 på Personal) och ingår inte i baspaketet.
- **Professional blir en uppgradering** med eget domännamn och fler funktioner. Innehållet är inte bestämt
  → ABL-026.

### Steg 2 — White label som självbetjäning

- [ ] **ABL-019** Adminvy: ladda upp logo, välj färger, sätt namn och texter utan ombyggnad.
      Inkl. kontrastvalidering och per-klubb favicon/OG-bild.

### Steg 3 — Andra sporter

- [ ] **ABL-020** Sportprofil: paustyper, antal perioder, klipplängd, terminologi och hallnamn
      som konfiguration.
- [ ] **ABL-021** Svensk copy ur koden — grund för andra sporter och andra språk.

---

## Hur pausflödet (ABL-001…005) passar in

Kör **ABL-001 och ABL-005 före P1.** Skäl:

- Båda skriver i pause/resume-vägen i `streams.ts`. ABL-011 (checkpointing) rör samma kod. Att göra
  dem parallellt blir onödigt smärtsamt.
- **ABL-005 och ABL-011 hänger ihop tekniskt.** ABL-005 kopplar loss memfs-namnet från partnumret och
  kräver att collectorn seedar sin "sedda"-mängd över en pausgräns; ABL-011 kräver att tidslinjen
  persisteras. Gör dem ihop eller i direkt följd.
- **Skriv ABL-001 med sportprofil-hook.** Ticketen inför `PauseType = "period" | "timeout"` och
  `periodNumber` som hårdkodade begrepp i `state.ts`. Lägg dem i ett konfigobjekt i stället. Det
  kostar nästan ingenting nu och slipper en refaktorering i steg 3 som annars rör backend, iOS och
  all copy samtidigt.

ABL-002/003/004 (iOS-knappar, pausskylt, ljudsignal) är fristående och kan ligga före eller efter
ABL-010. Låg konfliktrisk — ABL-002 rör knappar, ABL-010 rör konfigurationsvägen.

---

## Kända begränsningar att dokumentera, inte lösa

- **En rendition, ingen ABR.** Restreamer-containern har ~512 MB och klarar en FFmpeg-utgång — det är
  hela skälet till att Segment Collector finns. Kvalitetsväljaren i spelaren har inget att välja
  mellan. ABR kräver transkodning och riktig kostnad. Skriv ner det som ett medvetet val.
- **Segmentgenomströmning.** Varje segment passerar API-processen, ~3 Mbps in och ~3 Mbps ut per
  ström. Det, inte CPU, sätter taket för samtidiga kameror per installation. Mät innan vi lovar
  flerkameramatcher.

## Öppna frågor

1. ~~Kan en OSC-solution komponera en tjänst som är vårt eget repo?~~ **Ja.** Provider
   `EyevinnOSC/osc` har `my_app` och `my_page`, och `my_app` tar `git_token` direkt, så ett
   privat repo fungerar utan webbläsarceremoni. ABL-008 är alltså inte ett beroende för
   ABL-015 — katalogtjänsten är en distributionsfråga, inte en teknisk.

   **Men:** `sub_path` (monorepo) stänger av parameter store-injektionen. Backend måste
   ligga i roten av sitt repo, eller själv hämta konfigurationen från `APP_CONFIG_URL`.
   Det är ett designval som behöver tas: separata repon per komponent, eller monorepo med
   egen konfigurationshämtning. Just nu finns ett avknoppat privat repo
   `borisasadanin/courtside-api` för deploy.
2. **Licens** — och om byggsatsen ska ligga i OSC:s publika katalog. Katalogvägen är mycket mer
   "vem som helst", men innebär att Eyevinn-plattformen distribuerar den. Internt samtal.
3. **Håller App Store-vägen** för en app vars enda syfte är att para mot en självhostad backend?
   Värt att kolla riktlinjerna innan ABL-010 byggs klart.
