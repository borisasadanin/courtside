# Kapacitetstest: flera matcher samtidigt

Klarar en installation att flera lag sänder var sin match samtidigt (ABL-051)? Skriptet
`api/scripts/load-test.ts` spelar flera kameror mot en installation: det skapar strömmarna som appen gör,
skickar syntetisk bild och ljud till var och en med ffmpeg och mäter vad tittarna får.

## Innan du kör

- **Bara mot en installation gjord för test**, skapad från courtside.apps.osaas.io. Aldrig mot Älta.
  Skriptet vägrar adresser med `altabasket` i namnet.
- **Det kostar.** Skriptet startar sändningsmotorn om den är avstängd. Motorn kostar ungefär 6,7 tokens
  per timme (se [cost.md](cost.md)) och stängs av sig själv 15 minuter efter testet.
- **Det blir riktiga inspelningar.** Varje ström blir en repris som heter *Lasttest vs Lag N*, med några
  klipp. Ta bort dem efteråt under *Hantera → Inspelningar*.
- **Din dator kodar videon.** Tre strömmar i 1080p tar ungefär tre processorkärnor. Gå ner till
  `LOAD_TEST_SIZE=1280x720` eller `LOAD_TEST_PRESET=ultrafast` om datorn inte hinner med; det syns som
  `ffmpeg reconnects` och lucka i inspelningen.
- **Uppkopplingen** behöver klara antal strömmar × ungefär 3,2 Mbit/s uppströms.

## Så kör du

1. Para skriptet som en egen kamera. Välj *Hantera → Kameror → Lägg till kamera* och lös in koden som
   visas (token visas bara en gång):

```sh
curl -s -X POST https://minklubb-test.apps.osaas.io/api/devices/pair \
  -H 'Content-Type: application/json' -d '{"code":"<koden>","name":"Lasttest"}'
```

   Skriptet sänder sedan med samma behörighet som appen, `X-Device-Token`. Ta bort kameran *Lasttest*
   efter testet.
2. Kör från `api/`:

```sh
COURTSIDE_URL=https://minklubb-test.apps.osaas.io \
COURTSIDE_DEVICE_TOKEN=<kamerans token> \
COURTSIDE_VIEWER_PIN=<tittarkoden, om det finns en> \
LOAD_TEST_STREAMS=2 LOAD_TEST_MINUTES=30 \
LOAD_TEST_OUT=resultat-2-strommar.json \
npx tsx scripts/load-test.ts
```

Kör sedan med `LOAD_TEST_STREAMS=3`. Ctrl-C avbryter snyggt: strömmarna stoppas och sammanfattningen skrivs.

| Variabel | Standard | Vad |
|---|---|---|
| `COURTSIDE_URL` | – | Installationens adress |
| `COURTSIDE_DEVICE_TOKEN` | – | En parad kameras token |
| `COURTSIDE_VIEWER_PIN` | – | Tittarkoden. Utan den mäts inte DVR-fördröjning och inspelningarna kontrolleras inte |
| `COURTSIDE_API_KEY` | – | Installationens `API_KEY` ur dess parameter store, i stället för tittarkoden |
| `LOAD_TEST_STREAMS` | 2 | Antal kameror |
| `LOAD_TEST_MINUTES` | 30 | Hur länge de sänder |
| `LOAD_TEST_SIZE` | 1920x1080 | Upplösning, som appens Medel och Hög |
| `LOAD_TEST_BITRATE_KBPS` | 3000 | Videobithastighet, som appens Medel. Ljud 128 kbit/s kommer till |
| `LOAD_TEST_PRESET` | veryfast | x264-preset på din dator |
| `LOAD_TEST_SAMPLE_SECONDS` | 15 | Hur ofta status och fördröjning läses |
| `LOAD_TEST_CLIP_SECONDS` | 120 | Hur ofta varje ström får ett klipp |
| `LOAD_TEST_PAUSE_SECONDS` | 60 | Hur länge ström 1 pausas mitt i testet |
| `LOAD_TEST_OUT` | – | Fil för alla mätvärden som JSON |

## Vad skriptet gör

1. Startar sändningsmotorn om den är av och väntar tills den kör.
2. Skapar strömmarna med `POST /api/streams` och börjar sända till var och en: rörlig testbild och en ton,
   H.264 Main med nyckelbild varannan sekund och AAC, som appen. Tappar ffmpeg anslutningen kopplar det
   upp igen efter 3 sekunder, som appen.
3. Var `LOAD_TEST_SAMPLE_SECONDS`: läser varje ströms status, sidans status (`/api/broadcast`), API:ts
   minne och aktiva strömmar (`/health`) och, med tittarkod, hur gammalt nyaste segmentet i DVR-listan är.
4. Gör ett klipp i taget på strömmarna i tur och ordning, och vid tre fjärdedelar ett klipp på alla
   samtidigt.
5. Mitt i testet pausar ström 1 (periodpaus), väntar, återupptar och mäter tiden tills den är live igen.
   Under pausen ska sidan fortsätta säga live, eftersom de andra matcherna sänder.
6. Stoppar alla strömmar, väntar 20 sekunder och läser varje repris spellista.

## Vad du tittar på i OSC under tiden

- **Restreamer-instansen** (`datarhei-restreamer`): minne och CPU. Roadmapen antar omkring 512 MB. Med
  `-c copy` ska CPU vara låg och växa ungefär linjärt med antalet strömmar; minnet växer med segmenten i
  minnet (sex segment per ström). Visar OSC inga grafer har Restreamers API `cpu_usage` och `memory_bytes`
  per process (`GET /api/v3/process/<id>/state`).
- **Appen** (`eyevinn-web-runner`): att den inte startar om under testet, och loggarna. Rader med
  `Media playlist fetch failed` eller `Waiting for pipeline` i mängd betyder att segmenthämtningen inte hinner
  med. API:ts minne skrivs också i skriptets utskrift (`api=…MB`).
- **MinIO**: att lagringen växer med ungefär 1,4 GB per ström och timme vid 3 Mbit/s.

## Så läser du resultatet

Sammanfattningen kommer en gång per ström och sedan för hela installationen:

- **status**: andel mätningar som `live`, `paused`, `waiting`. Utanför pausen ska det vara nästan bara
  `live`. `waiting` mitt i testet betyder att bilden inte kom fram.
- **DVR lag**: hur långt efter verkligheten reprisen ligger. Segmenten är 2 sekunder och hämtas varannan
  sekund, så 3–8 sekunder är normalt. Växer den under testet hinner API:t inte med.
- **clips**: tiden från knapptryck till färdigt klipp. Klippet väntar på segmentet efter knapptrycket, så
  4–8 sekunder är normalt; tjänsten ger upp efter 15 sekunder. Jämför vanliga klipp med `Burst clips`.
- **ffmpeg reconnects** över 0 betyder att anslutningen bröts, i din dator, nätet eller motorn.
- **recording**: reprisens längd. Den ska vara ungefär `pushed` för strömmen, plus några sekunder
  pausmarkering för ström 1. Mycket kortare betyder förlorade segment.
- **Page status**: hur ofta sidan sa något annat än live medan en ström var live. Ska vara 0.
- **Pause**: tiden för paus och återupptagning, och tills bilden var tillbaka. Budgeten är 5 sekunder (ABL-005).
- **API memory**: ska plana ut. Ökar det hela testet läcker något.

## Rekommenderat tak

Skriv in resultatet i ABL-051 med ett tak per installation: det högsta antal strömmar där allt ovan höll
sig inom det normala och Restreamer hade marginal kvar i minne och CPU. Behöver instansen bli större,
uppdatera [cost.md](cost.md).
