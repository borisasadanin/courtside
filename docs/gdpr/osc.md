# Open Source Cloud som personuppgiftsbiträde

Kontrollerat 2026-10-30 mot osaas.io. Läs källorna själv innan ni hänvisar till dem: villkoren ändras.

## Roller

- **Föreningen** är personuppgiftsansvarig för det som spelas in: matcher, klipp och kameranamn.
- **Eyevinn Technology AB** driver Open Source Cloud (OSC), som lagrar videon och kör plattformen. Eyevinn är
  därmed **personuppgiftsbiträde** åt föreningen. Villkoren säger att Eyevinn behandlar kundens data "as your
  processor" enligt OSC:s biträdesavtal, som är en del av avtalet.
- **Courtside** är mjukvaran. Den har ingen egen roll för videon: den körs i föreningens konto, och ingen utanför
  föreningen tittar på eller använder filmerna.

## Biträdesavtalet

- Publicerat på [osaas.io/dpa](https://www.osaas.io/dpa), version 3.1 av 23 oktober 2026, också som PDF.
- Det gäller enligt villkoren oavsett om föreningen har skrivit under det separat. Godkänn det ändå för ert konto
  i OSC-konsolen, så att ni kan visa det vid en granskning.
- Frågor om dataskydd hos OSC: privacy@eyevinn.se.

## Var datan ligger

- Plattformen körs sedan 25 augusti 2026 hos **Elastx AB i Stockholm**. Biträdesavtalet säger att Elastx inte får
  föra över datan utanför EU/EES.
- Underbiträdena står på [osaas.io/subprocessors](https://www.osaas.io/subprocessors). De som rör en Courtside är
  Elastx (drift och lagring). Övriga på listan gäller inloggning, betalning, CDN och OSC:s AI-assistent, som
  Courtside inte använder för videon.
- Regionnamnen `prod` och `prod-se` förklaras inte i villkoren. `prod-se` är Elastx-klustret i Sverige. Courtside
  installeras i den region som OSC-kontot använder.

## Loggar

OSC anger ingen fast lagringstid för loggar från My Apps. Courtsides egna request-loggar innehåller IP-adresser
tills det är åtgärdat (issue #8).

## Det som återstår

- Bekräfta med Eyevinn vilken region `prod` är och hur länge My App-loggar sparas.
- Låt den juridiska granskningen (issue #17) läsa biträdesavtalet.
