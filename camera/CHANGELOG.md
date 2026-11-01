# Kameraappen — versioner

Appens version säger vilka funktioner en kamera har. Den syns i appen under
kugghjulet, och klubbens admin ser varje kameras version under Hantera → Kameror.
Därför får varje version som når en telefon, oavsett om det sker via TestFlight,
App Store eller Xcode, ett nytt nummer och ett avsnitt här.

Kameraappen har egna versionsnummer, skilda från plattformens (`CHANGELOG.md` i
roten). En funktion som kräver både en ny app och en ny plattform står i båda.

## Så släpps en ny version

1. Lägg till ett avsnitt nedan, `## X.Y.Z — datum`, med vad som är nytt i några
   rader som en lagledare förstår.
2. Kör `camera/release.sh X.Y.Z`. Skriptet sätter versionen och räknar upp
   byggnumret i `project.yml` och i Xcode-projektet. Allt annat i projektet,
   som signeringen, lämnas orört.
3. Bygg och installera, eller ladda upp till TestFlight.
4. Checka in och tagga: `git tag camera-vX.Y.Z`.

Rättas något i en version som inte nått någon telefon än, räcker det att köra
`release.sh` med samma version igen. Då räknas bara byggnumret upp.

Ändra versionen så här: 1.1.0 → 1.1.1 för rättningar, 1.1.0 → 1.2.0 för nya
funktioner.

## 1.3.0 — 2026-11-01

- När du stoppar en sändning frågar appen hur matchen slutade: först ditt lags poäng, sedan motståndarens.
  Resultatet syns på matchkortet bland repriserna. Tryck **Hoppa över** om ni inte räknar resultat
- Frågan kommer bara när plattformen kör v0.5.0 eller senare, och inte efter inspelningar kortare än 10 sekunder

## 1.2.0 — 2026-11-01

- Sändningsmotorn startar inte längre av sig själv när appen öppnas. Starta den
  med **Starta sändningsmotor** när det är dags. Det tar 1–3 minuter
- Systemstatus uppdateras av sig själv. Motorn visas som Avstängd, Startar…
  eller Redo, och när ingen sänder står det hur länge det är kvar innan den
  stängs av automatiskt (efter 15 minuter, kräver plattform v0.4.2)
- **Stäng av sändningsmotor** frågar först. Med plattform v0.4.2 vägrar den om
  någon sänder eller en match är pausad. Appen väntar upp till en minut på att motorn stängs av
  och visar sedan dess verkliga läge
- **Meddela tittare** om en kommande match fungerar utan att sändningsmotorn är
  igång. Det räcker att servern svarar
- Appens version syns under kugghjulet och skickas till klubben. Admin ser den
  under Hantera → Kameror (kräver plattform v0.4.2)

## 1.1.0 och 1.1.1 — 2026-10-31

Testbyggen som bara installerades på utvecklarens telefon. Ersatta av 1.2.0.

## 1.0 — till och med 2026-10-30

Versionen innan versionerna började räknas. Alla kameror som inte rapporterar
någon version kör den. Den har parning med QR-kod eller kod, sändning med paus
för periodvila och timeout, höjdpunkter, klubbens färg och logga, kameranamn och
integritetsmanifest. Sändningsmotorn startar automatiskt när appen öppnas.
