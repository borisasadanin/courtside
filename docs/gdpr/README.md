# GDPR

Det är oftast barn på filmen. Föreningen är personuppgiftsansvarig för det som sänds och spelas in, och
Courtside ska göra det lätt att göra rätt.

- **Mallar till föräldrar och motståndarlag, och en skylt att skriva ut:**
  [courtside.apps.osaas.io/gdpr](https://courtside.apps.osaas.io/gdpr/) (källa: `landing/public/gdpr/`).
- **Open Source Cloud som personuppgiftsbiträde:** [osc.md](osc.md).
- **Gästytor, när motståndarlaget får sina klipp:** [gastytor.md](gastytor.md). Registerförteckning,
  intresseavvägning och rutiner för den behandlingen.
- **Vad som finns i plattformen:**
  - *Om inspelningarna* i adminvyn: ansvarig förening och kontakt, som tittarna ser i sidfoten, vid tittarkoden
    och på delade klipp.
  - Tittarkod som förval. Att titta utan kod är ett aktivt val vid uppsättningen.
  - Ett delat klipp kan ses och förhandsvisas av den som får länken, men MP4:n laddas bara ner inifrån
    plattformen, bakom tittarkoden.
  - Att ta bort en match tar bort dess klipp. Enskilda klipp går att ta bort, och länken slutar fungera direkt.
  - En raderingslogg, där admin kan markera att något togs bort på begäran.
  - Gästytor: motståndarlagets highlights i en egen yta per match, bakom en slumpad kod som bara går till
    motståndarlagets ledare. Admin kan byta koden och ta bort klipp. Hela gästytan raderas 14 dagar efter
    matchen, även om matchen tas bort tidigare. Systemet skickar inga mail.
  - Sponsorrapporten räknar tittare utan att spara vem de är, se nedan.

## Tittare och sponsorer

Spelaren skapar ett slumpat tittar-id per flik och håller det i fliken (sessionStorage) tills den stängs.
Det säger inget om personen och följer inte med till andra webbplatser. Courtside använder det till två saker: att räkna hur många som tittar just nu, och
att räkna hur många som såg en sponsor under en match.

- **Tittar-id finns bara i minnet.** Servern sparar det aldrig i lagringen, och det står inte i några svar.
  Tittarantalet släpper ett id efter en minut utan hjärtslag. Sponsorräkningen släpper matchens id:n när
  antalen är sparade och matchen har varit tyst i tre timmar. En omstart tömmer allt.
- **Bara antal sparas**, i `stats/sponsors/` (se [data.md](../data.md)): olika tittare, starter, sedda
  klart och med ljud, per match, sponsor och plats. Ingen IP-adress, inget id, ingen tid per tittare.
- **Sponsorhändelserna** skickar id:t i anropets innehåll, aldrig i adressen, och det skrivs inte i loggarna.
  Hjärtslaget för tittarantalet har id:t i adressen, så request-loggarna kan visa det tills #8 är åtgärdat.
- **Rapporten** visar antal per match. Den visar aldrig vem som tittade, och kan inte göra det.
- Antalen sparas tills Courtside tas bort. De är inte personuppgifter, men tänk på det om en match med få
  tittare kan peka ut någon.
