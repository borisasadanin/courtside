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
