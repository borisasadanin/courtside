# Vad kostar det att köra Courtside?

Mätt på Eyevinn Open Source Cloud 2026-10-01. OSC fakturerar i *tokens*; hur många
tokens du får per månad och vad de kostar beror på din plan — se app.osaas.io.
Siffrorna nedan är tokens, inte kronor.

## Takpris per tjänst

Om allt kördes dygnet runt:

| Tjänst | Vad den gör | Tokens/dygn |
|---|---|---|
| `datarhei-restreamer` | Tar emot RTMP och gör HLS | **160** |
| `minio-minio` | Lagrar inspelningar och klipp | 10 |
| `eyevinn-app-config-svc` | Parameter store för konfiguration | 1 |
| Backend (My App) | API:et | ingår i plattformen |
| Hemsida (My Page) | Statiska filer | ingår i plattformen |
| **Summa, dygnet runt** | | **171** |

## Vad det faktiskt blir

Restreamer är tio gånger dyrare än allt annat tillsammans, och den är den enda
tjänsten som inte behöver vara igång hela tiden. Därför startar backend den när
någon börjar sända och stänger ner den en timme efter sista sändningen
(`RESTREAMER_GRACE_PERIOD_MS`).

Det är inte en teknisk detalj utan det som avgör kostnaden:

| | Dygnet runt | On-demand |
|---|---|---|
| Restreamer | 160 | ~6 |
| Lagring + konfiguration | 11 | 11 |
| **Totalt per dygn** | **171** | **~17** |

On-demand-kolumnen utgår från två matcher i veckan à två timmar, plus en timmes
nedstängningstimer per match — alltså ungefär sex timmar Restreamer i veckan.
En klubb som sänder mer skalar linjärt: varje timme sändning är ungefär
6,7 tokens.

**Slutsats:** lagringen är i praktiken golvet. Sändningstiden är det du styr.

## Lagring

Inspelningarna ligger kvar tills någon tar bort dem. En matchtimme i 1080p vid
3 Mbps blir ungefär 1,4 GB.

MinIO-instansen kostar lika mycket oavsett hur mycket som ligger i den upp till
instansens storlek, så lagring är en planfråga snarare än en rörlig kostnad.
`MINIO_STORAGE_CAPACITY_GB` styr bara mätaren i adminvyn — sätt den till vad din
instans faktiskt rymmer, och bestäm en gallringsregel. Att spara allt för alltid
är ett val, inte en förvald inställning.

## Innan du börjar

Kör `estimate-service-cost` i OSC MCP eller titta i app.osaas.io för att se vad
din egen plan ger. Siffrorna ovan är ceiling-värden från en verklig mätning, men
din plan avgör vad de betyder i pengar.
