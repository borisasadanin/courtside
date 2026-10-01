# Vad kostar det att köra Courtside?

Mätt på Eyevinn Open Source Cloud 2026-10-01. OSC fakturerar i *tokens*. Planen avgör hur många du får
per dygn. Siffrorna nedan är OSC:s takpriser per tjänst.

## Rekommenderad plan: Personal

**Personal** (15 EUR/mån exkl. moms, 40 tokens/dygn) räcker för en klubb som sänder ett par matcher i
veckan. Klubben får appens genererade adress, `<hash>.apps.osaas.io`.

**Professional** (69 EUR/mån, 300 tokens/dygn) behövs bara för ett eget namn, som `minklubb.apps.osaas.io`
eller en egen domän. Det är ett tillval, inte ett krav.

## Vad som drar tokens

| Tjänst | Vad den gör | Tokens/dygn | Igång |
|---|---|---|---|
| `minio-minio` | Inspelningar och klipp | 10 | Alltid |
| `valkey-io-valkey` | Lagret under parameter storen | 10 | Alltid |
| `eyevinn-app-config-svc` | Parameter store (konfiguration och hemligheter) | 1 | Alltid |
| `eyevinn-web-runner` | Appen: backend + webb | 10 | Alltid |
| **Grundkostnad** | | **31** | |
| `datarhei-restreamer` | Tar emot RTMP och gör HLS | 160 | Bara vid sändning |

Restreamer kostar fem gånger mer än allt annat tillsammans, men den är bara igång när någon sänder.
Backend startar den vid första sändningen och stänger ner den en timme efter den sista
(`RESTREAMER_GRACE_PERIOD_MS`). **Varje timme den är igång kostar ungefär 6,7 tokens.**

## Räkneexempel

| Klubb | Restreamer-timmar/vecka | Tokens/dygn | Personal (40/dygn) |
|---|---|---|---|
| 2 matcher à 2 h | 6 (inkl. 1 h efterlöptid per match) | ≈ 37 | Räcker |
| 4 matcher à 2 h | 12 | ≈ 43 | Lite över |

Om det blir för mycket finns tre vägar: ett tokenpaket (100 tokens för 9,90 EUR, de förfaller inte), en
kortare efterlöptid, eller Professional.

## Lagring

Inspelningarna ligger kvar tills någon tar bort dem. En matchtimme i 1080p vid 3 Mbps blir ungefär 1,4 GB.
MinIO-instansen kostar lika mycket oavsett hur mycket som ligger i den, upp till instansens storlek.
Lagring är alltså en planfråga, inte en rörlig kostnad. `MINIO_STORAGE_CAPACITY_GB` styr bara mätaren i
adminvyn. Bestäm en gallringsregel: att spara allt för alltid är ett val, inte en förvald inställning.

## Kontrollera själv

`estimate-service-cost` i OSC MCP, eller osaas.io/pricing. Takpriserna ovan är vad det högst kostar.
