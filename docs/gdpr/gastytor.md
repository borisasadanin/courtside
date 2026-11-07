# Gästytor: klipp till motståndarlaget

Den som filmar kan spara highlights även för motståndarlaget. De klippen hamnar i en **gästyta** för matchen,
som motståndarlagets ledare öppnar med en kod. Där kan de spela, ladda ner och dela klippen. Det här är en egen
behandling, skild från sändning och repris: föreningen lämnar ut film på en annan förenings spelare, ofta barn,
till den föreningen.

Texterna till föreningarna finns på [courtside.apps.osaas.io/gdpr](https://courtside.apps.osaas.io/gdpr/)
(källa: `landing/public/gdpr/`). Integritetspolicyn på landningssidan (`landing/public/integritet/`) säger vem
den registrerade vänder sig till.

## Så fungerar det

- En gästyta per match. Den skapas med en slumpad kod när matchens första motståndarklipp sparas. Matcher utan
  motståndarklipp får ingen gästyta.
- Gästen ser bara den matchens motståndarklipp: lagen, slutresultat, plats om den finns, datum och när klippen
  raderas. Inga andra matcher, ingen live, inte föreningens egna highlights.
- Motståndarklipp syns aldrig i föreningens egna highlights eller i pauskarusellen.
- Hela gästytan raderas automatiskt 14 dagar efter matchen, även om matchen eller inspelningen tas bort
  tidigare. Raderingen noteras i raderingsloggen.
- Ett delat gästklipp visas på en neutral sida tills gästytan raderas.
- Admin ser alla gästytor med kod och länk, kan ta bort enskilda klipp eller alla, och kan skapa en ny kod.
- Koden står aldrig i länken. Admin skickar den själv, med mail eller sms. Systemet skickar inga mail och
  hanterar inga mailadresser i den här omgången (#56).

## Registerförteckning (art. 30)

Lägg in som en egen rad i föreningens registerförteckning.

| | |
|---|---|
| **Behandling** | Utlämnande av highlights till motståndarlaget |
| **Ändamål** | Ge motståndarlaget klippen från matchen, så att de inte behöver filma själva eller be om filerna |
| **Personuppgiftsansvarig** | Föreningen som filmar, fram till att klippen laddas ner. Därefter ansvarar motståndarklubben för sina exemplar |
| **Registrerade** | Motståndarlagets spelare, ofta barn. Ibland domare, ledare och publik i bild |
| **Personuppgifter** | Videoklipp med bild och ljud. Matchinfo: lag, resultat, plats, datum |
| **Mottagare** | Motståndarlagets ledare, via koden. Den som får en delad länk till ett klipp. Open Source Cloud (Eyevinn) som personuppgiftsbiträde |
| **Rättslig grund** | Berättigat intresse (art. 6.1 f), se intresseavvägningen nedan |
| **Lagringstid** | 14 dagar efter matchen, sedan raderas hela gästytan automatiskt |
| **Överföring till tredje land** | Nej. Lagras hos Elastx i Stockholm, se [osc.md](osc.md) |
| **Säkerhet** | Slumpad kod, begränsat antal inloggningsförsök, kort livslängd, koden kan bytas. Koden står aldrig i länken |

## Intresseavvägning

**Intresset.** Motståndarlaget vill ha sina höjdpunkter, och spelarna och föräldrarna vill se dem. Utan gästytan
filmar föräldrarna själva och sprider klippen i öppna kanaler. Gästytan ger dem samma klipp med en kod, en
ansvarig och en bestämd raderingsdag.

**Nödvändigt?** Ja, för att ge just motståndarlaget klippen. Bara motståndarklipp lämnas ut, bara för den
matchen, och bara i 14 dagar.

**De registrerades intressen.** Det är ofta barn, och de har inte valt att filmas av en annan förening. De och
föräldrarna ska kunna räkna med att klippen inte sprids till fler än det egna laget, och att de kan få bort ett
klipp.

**Avvägning.** Behandlingen väger över om:

- motståndarlaget får information före matchen (mallen *Till motståndarlaget* nämner gästytan),
- koden bara går till motståndarlagets ledare,
- klippen raderas efter 14 dagar och kan tas bort tidigare på begäran,
- det står i informationen att det som laddas ner är motståndarklubbens ansvar.

**Risken som återstår.** Efter nedladdning har föreningen ingen kontroll. En delad länk fungerar utan kod tills
gästytan raderas. Det står i informationen, och motståndarklubben ansvarar för det de laddar ner och delar.

Om berättigat intresse håller för barn- och ungdomsmatcher är en öppen fråga i juristgranskningen (#17).

## Rutiner

### Lämna ut koden

1. Öppna gästytan i adminvyn och välj **Kopiera inbjudan**. Texten innehåller länk, kod och raderingsdatum.
2. Skicka den själv, med mail eller sms, till **motståndarlagets ledare**. Inte till föräldrar, inte i öppna
   grupper.
3. Skicka koden och länken gärna i samma meddelande till en person, inte till en hel lista.

### Koden har hamnat fel

1. Skapa en ny kod för gästytan i adminvyn. Den gamla slutar fungera direkt.
2. Skicka den nya koden till rätt ledare.
3. Bedöm om någon hunnit se eller ladda ner klipp. Har klipp spridits till fel personer: ta bort dem, och följ
   incidentrutinen (#16), som kan innebära en anmälan till IMY inom 72 timmar.

### Begäran om att ta bort ett gästklipp

1. Ta bort klippet i gästytan i adminvyn och kryssa i att det är på begäran, så noteras det i raderingsloggen.
   Länken slutar fungera direkt.
2. Har klippet redan laddats ner: be motståndarklubben ta bort sitt exemplar. Föreningen kan inte göra det åt dem.
3. Svara den som frågade inom en månad. Skriv inte namnet på den som frågade i raderingsloggen.

### Invändning före matchen

Vill någon i motståndarlaget inte vara med: spara inga motståndarklipp den matchen, eller ta bort de klipp där
hen syns efteråt.

## Loggar

Koden ska skickas i anropets innehåll, aldrig i adressen, och får inte skrivas i loggarna. Request-loggarna
innehåller idag IP-adresser och adresser till delade klipp tills #8 är åtgärdat. Gästytorna ska omfattas av samma åtgärd.

## Det som inte ingår nu

- **Mailutskick.** Systemet skickar inga mail och hanterar inga mailadresser. Automatiskt utskick till
  motståndarlaget väntar (#56), och frågan om reklam för produkten i ett sådant mail ligger kvar i
  juristgranskningen (#17).
- **Gamla matcher.** Bara klipp från nya matcher hamnar i en gästyta. Befintliga klipp flyttas inte.
