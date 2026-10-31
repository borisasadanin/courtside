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

## 1.1.0 — 2026-10-31

- Sändningsmotorn startar inte längre av sig själv när appen öppnas. Starta den
  med knappen **Starta sändningsmotor** när det är dags. Den tar 1–3 minuter att
  starta. Stäng av den med **Stäng av sändningsmotor**
- En avstängd sändningsmotor visas som grå "Avstängd", inte som ett fel
- **Meddela tittare** om en kommande match fungerar utan att sändningsmotorn är
  igång. Det räcker att servern svarar
- Appens version syns under kugghjulet och skickas till klubben. Admin ser den
  under Hantera → Kameror (kräver plattform v0.4.2)

## 1.0 — till och med 2026-10-30

Versionen innan versionerna började räknas. Alla kameror som inte rapporterar
någon version kör den. Den har parning med QR-kod eller kod, sändning med paus
för periodvila och timeout, höjdpunkter, klubbens färg och logga, kameranamn och
integritetsmanifest. Sändningsmotorn startar automatiskt när appen öppnas.
