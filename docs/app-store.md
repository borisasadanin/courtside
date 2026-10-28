# Kameraappen i App Store

Allt som går att förbereda utan Eyevinns konto. När kontot finns: fyll i det som står under
*Saknas*, bygg och ladda upp. Ticket: ABL-028.

## Saknas (kräver Eyevinns Apple-konto)

- Inbjudan till App Store Connect (App Manager eller Admin), eller en API-nyckel (`.p8`, Key ID, Issuer ID)
- Eyevinns Team ID → `DEVELOPMENT_TEAM` i Xcode
- Godkänt bundle ID, förslag `se.eyevinn.courtside.camera` → `COURTSIDE_BUNDLE_PREFIX = se.eyevinn.courtside`
  och `PRODUCT_BUNDLE_IDENTIFIER` i `camera/project.yml`
- Kontrollera att appnamnet är ledigt

## Redan klart i bygget

- Ingen klubb inbakad: appen paras med QR-kod (ABL-010) och kan kopplas bort i inställningarna (ABL-029)
- Kamera- och mikrofontexter i `project.yml`
- `ITSAppUsesNonExemptEncryption = false` (bara standard-HTTPS)
- Parningsskärmen förklarar vad appen hör till och länkar till courtside.apps.osaas.io

## Butikstext

**Namn:** Courtside Camera
**Undertitel:** Sänd lagets matcher live

**Beskrivning:**

> Courtside Camera gör en telefon till kameran för er klubbs livesändningar. Rikta telefonen mot planen och
> tryck på en knapp — familj och supportrar ser matchen live på klubbens egen sida, kan spola tillbaka och se
> klipp från matchen under pauserna.
>
> - En knapp för att gå live
> - Pausknappar för periodpaus och timeout — tittarna får se höjdpunkter under tiden
> - Spara ett klipp med ett tryck när något händer
> - Hela matchen sparas som repris
>
> Appen kräver en Courtside-plattform. En klubb startar sin egen på courtside.apps.osaas.io och kopplar appen
> genom att skanna en kod från sin adminvy. Videon går direkt till klubbens egen plattform — inte till oss.

**Nyckelord:** livesändning, basket, match, idrott, förening, stream, lag, inspelning
**Kategori:** Sport (sekundär: Foto och video)
**Pris:** Gratis
**Åldersgräns:** 4+

**Integritetspolicy:** https://courtside.apps.osaas.io/integritet
**Support:** https://courtside.apps.osaas.io/support

**App Privacy (formuläret):** "Data Not Collected". Appen skickar video och matchinformation till den
plattform användaren själv parat med; varken appen eller Eyevinn samlar in eller tar emot något.

## Anteckning till granskaren (App Review Notes)

> Courtside Camera is the camera for a sports club's self-hosted live streaming platform. It only works after
> pairing with a club's platform by scanning a QR code from that club's admin page.
>
> Demo platform for review: <URL till demoinstallation>
> Admin code: <admin-kod>
> 1. Open the demo URL on a computer, enter the admin code, choose "Lägg till kamera".
> 2. Scan the QR code with the app. 3. Press "Starta sändning". The stream appears on the demo page.

Håll en testplattform skapad från landningssidan igång under granskningen, på sin egna adress (kortnamn.apps.osaas.io), och byt admin-koden efteråt.

## TestFlight först

Publik testlänk, upp till 10 000 testare, Beta App Review (oftast inom ett dygn). Samma bygge går sedan
till App Store.

## Skärmdumpar

6,9" (iPhone 16 Pro Max) krävs: parningsskärm, startskärm med grön systemstatus, sändning i liggande läge,
pausmeny. Tas på en riktig sändning mot demoinstallationen.
