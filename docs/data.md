# Era videor och klipp — så tappar ni dem aldrig

Courtside körs på ert eget konto hos Open Source Cloud (OSC). Matcherna och klippen ligger i er egen lagring,
i ert konto. Det betyder att ni äger dem och att bara den ni ger en kod kan se dem. Det betyder också att ingen
annan kan ta fram dem om de försvinner. Den här sidan säger vad som krävs för att det inte ska hända.

## Var ligger videon?

I en lagringstjänst i ert OSC-konto, som heter `<klubbnamn>storage`. Den skapades när ni startade Courtside.
Där finns hela matcher, klipp, miniatyrbilder och er logotyp, och varje matchs lag, datum och resultat.
Varje match får en omslagsbild: miniatyren från matchens första klipp, eller annars en bild ur inspelningen som
tas när den stoppas. Medan en match sänds sparas en bild ur sändningen ungefär varje minut, så att livekortet
visar vad som händer. Den bilden tas bort när sändningen slutar. Bilderna ur inspelningen syns bara med
tittarkoden, precis som videon.
Till varje match sparas också om varje paus var en periodvila eller en timeout, och till varje klipp var i
matchen det börjar, så att reprisen kan hoppa dit.
Tas en match bort försvinner resultatet och bilderna med den. Inställningar och koder ligger i `<klubbnamn>config`.

Lagen under *Hantera → Lag* ligger i samma lagring: listan i `config/teams.json` och varje lags logga i
`config/teams/<id>`. Ett lag har namn, kortnamn, färg och eventuellt en logga. Matcherna sparar lagens namn
som text och hittar sitt lag via namnet. Tar ni bort ett lag finns matcherna kvar. Loggorna visar
inga personer och kan ses utan kod, som klubbens logotyp. Tas Courtside bort följer lagen och loggorna med.
Lagen från matcher som spelades in innan registret fanns läggs in i registret en gång, när plattformen
uppdateras. Att det är gjort noteras i `config/backfill.json`, så att ett lag ni tar bort inte kommer tillbaka.

Matcherna under *Hantera → Matcher* ligger i `config/matches.json`: datum, tid, plats och de två lagen (lagets
id i registret och dess namn). Varje inspelning vet vilken match den hör till. En match som filmats utan att
väljas i schemat läggs in där av sig själv. Resultatet ligger kvar på inspelningen, och matchen visar det från
sin senaste inspelning som har ett. En match utan inspelningar kan tas bort under Matcher. Har den inspelningar
tar ni bort dem under *Inspelningar*, så att raderingsloggen gäller. Schemat syns bara med tittarkoden. Tas
Courtside bort följer schemat med.

## Vad får videon att försvinna?

| Det här | Händer med videon |
|---|---|
| Ni raderar en match i adminvyn | Matchen är borta för gott |
| Ni tar bort Courtside på courtside.apps.osaas.io | **Allt** är borta: matcher, klipp, inställningar |
| Någon tar bort lagringstjänsten i OSC | **Allt** är borta |
| OSC-kontot sägs upp eller slutar betalas | Tjänsterna stängs av, och videon riskerar att försvinna med dem |
| Ni glömmer admin-koden | Ingenting. Videon finns kvar, och ni kommer in igen (se nedan) |
| Courtside startas om eller uppdateras | Ingenting |

## Så skyddar ni er

1. **Håll OSC-kontot betalt och i en förenings händer.** Lägg kontot på en adress som föreningen äger,
   inte på en enskild förälder som kan sluta. Se till att minst två personer kan logga in.
2. **Spara det ni vill behålla.** OSC:s inbyggda backup gäller databaser, inte videolagringen. Det finns
   alltså ingen automatisk kopia av matcherna. Klipp kan laddas ner direkt från sidan. Ladda ner de klipp
   ni vill spara för alltid.
3. **Ta bara bort med flit.** Borttagning av Courtside kräver att ni skriver in klubbnamnet. Det går inte
   att ångra, inte heller för Eyevinn.

## Glömt admin-koden?

Ni blir aldrig utelåsta. Logga in på courtside.apps.osaas.io med det OSC-konto som startade Courtside och
välj **Glömt admin-koden?**. Ni får en ny uppsättningskod och väljer en ny admin-kod. Tittarkoden och alla
inspelningar finns kvar. Har ni glömt lösenordet till OSC-kontot återställer ni det hos OSC.

## Vad Eyevinn kan och inte kan göra

Eyevinn tittar inte på, använder eller delar era filmer. Open Source Cloud, som Eyevinn driver, lagrar dem åt er.
Eyevinn är då personuppgiftsbiträde åt föreningen enligt [OSC:s biträdesavtal](https://www.osaas.io/dpa), se
[gdpr/osc.md](gdpr/osc.md). Courtside agerar bara på ert konto när ni själva är inloggade på
courtside.apps.osaas.io och ber om det: vid installation, uppdatering, reparation eller *Glömt admin-koden?*.

Vi kan inte återställa något som raderats. Det finns ingen kopia hos oss.

## Ert ansvar för det som spelas in

Det är oftast barn och ungdomar på filmen. Föreningen bestämmer och ansvarar för

- att föräldrar vet att matcherna sänds och spelas in, och var de kan se dem
- att det finns en tittarkod, så att bara de som fått den kan titta
- hur länge inspelningar sparas, och att ni tar bort dem efter det
- att ni kan ta bort en match om någon ber om det. Det gör ni i adminvyn
