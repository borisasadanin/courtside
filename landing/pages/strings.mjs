// Every word on the landing page, in Swedish and English. page.mjs lays them
// out; build.mjs writes public/index.html (sv) and public/en/index.html (en).
//
// Numbers here follow docs/cost.md: 31 tokens/day base, ≈7 tokens per
// broadcast hour plus an hour of standby, Personal 40 tokens/day ≈ 10 games a
// month. Change them there first.

export const sv = {
  lang: "sv", path: "/", other: { path: "/en/", label: "English", flag: "🇬🇧", code: "EN" },
  title: "Courtside – sänd lagets matcher live från mobilen",
  description: "En förälder, en iPhone och ett stativ. Matchen live i webbläsaren, highlights direkt och hela matchen sparad. Från 15 € i månaden för hela föreningen, i ert eget konto.",
  nav: { top: "Courtside, till toppen", menu: "Huvudmeny", how: "Så funkar det", features: "Funktioner", price: "Pris", faq: "Frågor", start: "Kom igång", lang: "Byt språk till engelska" },

  inst: {
    h: "Er Courtside", signout: "Logga ut", listH: "Installationer i ert konto", empty: "Ni har ingen Courtside ännu.",
    createH: "Starta en ny Courtside", display: "Föreningens namn", displayPh: "Älta IF Basket",
    expired: "Inloggningen hos Open Source Cloud har gått ut, så inget har skapats. Logga in igen, så finns det du skrev kvar.", expiredBtn: "Logga in igen",
    club: "Kortnamn", clubPh: "altaif", clubHint: "Små bokstäver och siffror. Blir er adress, kortnamn.apps.osaas.io, och namnet på tjänsterna i ert konto.",
    create: "Skapa", takes: "Tar runt tio minuter. Allt skapas i ert eget OSC-konto och drar tokens därifrån.",
    creating: "Skapar", steps: ["Kontrollerar namnet", "Lagring för inspelningar", "Åtkomst för sändningsmotorn", "Inställningar", "Webbplats och backend", "Bygger (flera minuter)", "Startar"],
    codeNote: "Er setupkod. Den visas bara nu, så skriv upp den.", address: "Adress:", openPins: "Öppna och välj PIN-koder", back: "Tillbaka",
  },

  hero: {
    eyebrow: "Livesändning för idrottsföreningar",
    h1: "Hela laget på läktaren. Även de som inte kan komma.",
    lead: "Ställ en iPhone på stativet och tryck på en knapp. Matchen går live i webbläsaren, highlights finns att se direkt och hela matchen sparas. Utan app för tittarna och utan reklam.",
    priceBig: "Från 15 € i månaden", priceSmall: "för hela föreningen. Inga avgifter per lag eller per tittare.",
    cta: "Kom igång", cta2: "Se hur enkelt det är",
    chips: ["Ingen app för tittarna", "Ingen reklam", "Filmerna är föreningens"],
  },

  proof: {
    strong: "Byggt på läktaren, inte i ett konferensrum.",
    text: "Courtside började som en förälders lösning för ett basketlag i Stockholm och har sänt lagets matcher varje helg sedan början av 2026. Nu kan fler föreningar göra samma sak.",
    facts: [["1 knapp", "för att gå live"], ["0 appar", "för tittarna"], ["≈ 1,50 €", "per match på Personal-planen"]],
  },

  how: {
    eyebrow: "Så funkar det", h2: "Från idé till livesändning på en kväll",
    sub: "Ingen kameraman, ingen fast kamera i hallen och ingen som behöver kunna IT. En iPhone, ett stativ och Wi-Fi eller 4G räcker.",
    steps: [
      ["Skapa er Courtside", "Logga in med ett Open Source Cloud-konto, välj ett namn och klicka på Skapa. Några minuter senare har föreningen en egen webbadress. Alla nycklar ställs in automatiskt.", "En gång per förening"],
      ["Koppla mobilen", "Installera den kostnadsfria kameraappen och skanna QR-koden i adminvyn. Sedan vet mobilen vart den ska sända. Dela länken i lagets chatt.", "Två minuter före match"],
      ["Tryck på Sänd", "Matchen är live. Tryck på stjärnan när något bra händer. När slutsignalen går sparas hela matchen automatiskt.", "En knapp under matchen"],
    ],
    cta: "Kom igång", small: "Kameraappen är gratis för iPhone och på väg in i App Store.",
  },

  who: {
    eyebrow: "För alla runt laget", h2: "En sändning, fyra vinnare", sub: "Ungdomsidrott har alltid haft fler supportrar än platser på läktaren.",
    cards: [
      ["Familj och släkt", "Mormor i Luleå, pappan som jobbar och syskonet på en annan match ser allt live, var de än är. Den som kommer in sent spolar tillbaka.", "”Farmor har inte missat en match sedan i våras.”"],
      ["Tränaren", "Hela matchen finns som repris. Gå igenom försvaret på nästa träning och visa vad som funkade."],
      ["Spelarna", "Highlights som går att se direkt, laddas ner och delas i gruppchatten samma kväll."],
      ["Föreningen", "En egen kanal i klubbens färger och med klubbens logga, på er egen adress. Fler som följer laget, mer att visa sponsorerna."],
    ],
  },

  feat: {
    eyebrow: "Funktioner", h2: "Allt en förening behöver. Inget den inte behöver.",
    sub: "Byggt för hur en ungdomsmatch faktiskt går till, med uppvärmning, periodvilor och en förälder som filmar.",
    liveH: "Live i webbläsaren, med spola tillbaka",
    liveP: "Tittarna öppnar en länk, i vilken webbläsare som helst. Ingen app att ladda ner, inget konto att skapa. Den som missade en sekvens spolar tillbaka under pågående match och hoppar sedan tillbaka till live.",
    liveTicks: ["Fungerar i mobil, surfplatta och dator, även Android", "Spola tillbaka under matchen", "Hela matchen sparas automatiskt som repris"],
    liveStart: "Start", liveHere: "Du är här", liveNow: "Live ●",
    clipH: "Highlights som går att se direkt",
    clipP: "Den som filmar trycker på stjärnan. Klippet skärs ut på en gång och <strong>finns att se direkt efter att det hänt</strong>, medan matchen fortsätter. I periodvilor och timeouts byts sändningen mot ett karusellflöde med matchens highlights. En pausskylt visar att matchen står still, och en ljudsignal hörs när spelet börjar igen.",
    clipTicks: ["En knapptryckning, ingen redigering", "Klippet finns att se några sekunder efter att det hänt", "Karusell med highlights i varje paus", "Ladda ner och dela klippen. En delad länk fungerar utan PIN-kod"],
    cards: [
      ["En knapp i mobilen", "Kameraappen är gjord för en förälder med kaffe i andra handen. Sänd, pausa, klipp. Mer är det inte."],
      ["PIN-kod för tittare", "Det är ofta barn på bild. Lås sändningen med en kod som bara lagets familjer får. Vi rekommenderar det alltid."],
      ["Er logga, era färger", "Välj namn, ladda upp loggan och välj klubbfärg i adminvyn. Ändringen syns direkt för alla tittare."],
      ["Matcharkiv", "Alla matcher samlade och sparade. Perfekt inför returmatchen eller säsongsavslutningen."],
      ["Adminvy", "Byt namn på matcher, ta bort det som inte ska ligga kvar och koppla nya kameror genom att skanna en QR-kod."],
      ["Fler sporter på väg", "Idag anpassat för basket. Perioder, pauser och klipplängd är inställningar, så fler sporter står på tur."],
    ],
  },

  own: {
    eyebrow: "Er film, era regler", h2: "Föreningen äger sina matcher",
    sub: "Courtside körs i föreningens eget konto på Open Source Cloud. Ingen annan plattform sitter på era filmer, visar reklam runt era barn eller bestämmer vad som händer med materialet. Inte heller vi: Eyevinn har ingen åtkomst.",
    cards: [
      ["Er lagring, ert beslut", "Inspelningarna ligger i föreningens egen lagring. Ni bestämmer hur länge de sparas och raderar en match när en förälder ber om det."],
      ["Ingen reklam, ingen algoritm", "Sidan visar er match och era highlights. Inget annat."],
      ["Aldrig utelåst", "Glömt admin-koden? Ägaren loggar in med sitt OSC-konto här på sidan och kommer in igen. Filmer och tittarkod finns kvar."],
      ["Öppen källkod", "Courtside bygger på öppen källkod (Apache-2.0). Ingen inlåsning i en sluten sportplattform."],
    ],
  },

  cmp: {
    eyebrow: "Jämför", h2: "Varför inte bara sända i sociala medier?", sub: "Det går, och många gör det. Så här skiljer det sig.",
    head: ["", "Courtside", "Sociala medier", "Kommersiell sportkanal"],
    rows: [
      ["Vem äger filmen", "Föreningen", "Plattformen, på deras villkor", "Leverantören"],
      ["Reklam runt sändningen", "Nej", "Ja", "Ofta"],
      ["Vem kan titta", "Bara lagets familjer, med PIN-kod", "Svårt att begränsa", "Betalvägg"],
      ["Highlights", "Direkt, med en knapptryckning", "Nej", "Ibland, mot tillägg"],
      ["Spola tillbaka under match", "Ja", "Varierar", "Ja"],
      ["Utrustning", "En iPhone och ett stativ", "En mobil", "Ofta fast kamera i hallen"],
      ["Kostnad", "Från 15 € i månaden för hela föreningen", "Gratis", "Abonnemang per lag eller hall"],
    ],
    cta: "Se vad som ingår för 15 €",
  },

  price: {
    eyebrow: "Pris", h2: "15 € i månaden. För hela föreningen.",
    sub: "Det räcker till ungefär 10 matcher i månaden, 2–3 i veckan. Det blir runt 1,50 € per match. Inga avgifter per lag, inga avgifter per tittare. Ni betalar för de timmar ni sänder.",
    incH: "Det här ingår för 15 € i månaden", incIntro: "Allt. Det finns inga tillägg att låsa upp.",
    included: [
      ["En egen webbadress för föreningen", "med er logga, ert namn och er klubbfärg"],
      ["Livesändning i webbläsaren", "utan app och utan konto för tittarna"],
      ["Spola tillbaka under matchen", "och hoppa tillbaka till live"],
      ["Highlights direkt", "en tryckning på stjärnan, klippet finns att se på en gång"],
      ["Highlightkarusell i pauserna", "med pausskylt och ljudsignal när spelet börjar igen"],
      ["Ladda ner och dela klipp", "delade länkar fungerar utan PIN-kod"],
      ["Hela matchen sparad som repris", "automatiskt, i ett matcharkiv"],
      ["PIN-kod för tittare", "så att bara lagets familjer ser"],
      ["Adminvy", "byt namn på och ta bort matcher, koppla kameror med QR-kod"],
      ["Kameraappen för iPhone", "kostnadsfri, på väg in i App Store"],
      ["Lagring för inspelningarna", "i föreningens eget konto"],
      ["Automatisk installation", "alla nycklar och kopplingar ställs in åt er"],
      ["Aldrig utelåst", "glömd admin-kod återställs med ert OSC-konto"],
      ["Ingen reklam", "och ingen annan, inte heller Eyevinn, har åtkomst till era filmer"],
    ],
    incFoot: "Priset är Open Source Clouds Personal-plan, 15 € i månaden exkl. moms. Courtside körs i ert eget OSC-konto.",
    plans: {
      personal: { flag: "Passar de flesta", name: "Personal", price: "15", per: "€ / månad", vat: "exkl. moms", for: "Laget eller den mindre föreningen som sänder sina hemmamatcher.",
        rows: [["Matcher", "Ungefär 10 i månaden (2–3 i veckan)"], ["Pris per match", "≈ 1,50 €"], ["Allt i listan ovan", "✓"], ["Egen domän", "–"], ["E-post på föreningens domän", "–"], ["Tokens per dygn", "40"]],
        cta: "Kom igång med Personal" },
      pro: { flag: "För stora föreningar", name: "Professional", price: "69", per: "€ / månad", vat: "exkl. moms", for: "Föreningen med många lag som sänder både hemma och borta.",
        rows: [["Matcher", "Plats för hundratals i månaden"], ["Pris per match", "Sjunker ju mer ni sänder"], ["Allt i listan ovan", "✓"], ["Egen domän, t.ex. live.dinforening.se", "✓"], ["E-post på föreningens domän", "✓"], ["Tokens per dygn", "300"]],
        cta: "Kom igång med Professional" },
    },
    tryH: "Vill ni prova först?", tryP: "OSC:s gratisnivå ger 100 tokens. Det räcker för att sätta upp Courtside och sända en träningsmatch innan ni bestämmer er.", tryCta: "Prova gratis",
    calcExplain: "Open Source Cloud räknar i tokens: Courtside använder 31 om dygnet för webbplats och lagring och ungefär 7 per sändningstimme, och Personal-planen ger 40 om dygnet.",
    calc: {
      h: "Hur mycket räcker planen till?", hint: "Dra i reglagen eller välj ett exempel.", presetsLabel: "Exempel",
      presets: ["Ett lag, hemmamatcher", "Några lag", "Hela föreningen"],
      matches: "Matcher per vecka", matchesHint: "Alla lag tillsammans, under säsong.",
      hours: "Sändningstid per match", hoursHint: "Med uppvärmning och periodvilor. Sändningsmotorn står redo en timme efter matchen, det räknas in.",
      lead: "Ni behöver ungefär", unit: "tokens / månad", base: "Grund (alltid på)", live: "Sändning", ofPlan: ["av", "i planen"],
      reco: "Rekommenderad OSC-plan", recoDefault: "Personal <em>15 €/mån</em>",
    },
    extras: [
      ["Cup-helg? Fyll på.", "Tokenpaket kostar 9,90 € för 100 tokens och går aldrig ut. Ett paket räcker till ungefär 5 matcher till, perfekt för en turnering från morgon till kväll."],
      ["Lugn vecka betalar för en intensiv helg.", "Tokens ni inte använder sparas och rullar vidare."],
    ],
    note: "Uppskattningen bygger på Open Source Clouds listpriser och räknar med att sändningsmotorn bara körs under matcher, plus en timme efteråt. Alla priser i euro exkl. moms.",
  },

  worry: {
    h2: "Det brukar folk undra",
    items: [
      ["”Vi har ingen som kan IT.”", "Ni behöver ingen. Logga in, välj ett namn, klicka på Skapa. Resten ordnas automatiskt."],
      ["”Det är barn på bild.”", "Slå på PIN-kod så ser bara lagets familjer. Filmerna ligger i ert eget konto, och ni raderar en match när någon ber om det."],
      ["”Tänk om vi glömmer koden.”", "Ägaren loggar in med sitt OSC-konto och kommer in igen. Ni blir aldrig utelåsta."],
      ["”Det blir säkert dyrt.”", "15 € i månaden för hela föreningen, runt 1,50 € per match. Inga avgifter per lag eller tittare."],
    ],
    cta: "Kom igång",
  },

  faq: {
    h2: "Vanliga frågor",
    items: [
      ["Vad behöver vi för utrustning?", "En iPhone, ett stativ och uppkoppling via hallens Wi-Fi eller mobilnätet. En bra mobilhållare och en powerbank gör skillnad under en lång matchdag, men mer behövs inte."],
      ["Var hittar vi kameraappen?", "Kameraappen är gratis för iPhone och på väg in i App Store. Vill ni prova innan dess, hör av er. Ni kopplar appen till er Courtside genom att skanna QR-koden i adminvyn."],
      ["Fungerar det med Android?", "För tittarna, ja: sändningen visas i vilken webbläsare som helst. Kameraappen finns idag bara för iPhone."],
      ["Hur snabbt kan man se en highlight?", "Direkt. När den som filmar trycker på stjärnan klipps sekvensen ut och finns att se några sekunder senare, medan matchen pågår. I pauserna visas alla highlights i en karusell."],
      ["Kan vi dela klippen?", "Ja. Klippen går att ladda ner och dela. En delad klipplänk fungerar utan PIN-kod, så tänk efter vad ni delar och med vem."],
      ["Vad kostar det egentligen?", "Courtside körs på Open Source Cloud. Med Personal-planen, 15 € i månaden exkl. moms, får ni ungefär 10 matcher i månaden. Professional, 69 € i månaden, ger plats för hundratals matcher, egen domän och e-post på föreningens domän. Inga avgifter per lag eller per tittare."],
      ["Vad är tokens?", "Tokens är valutan på Open Source Cloud. Planen fyller på med ett fast antal varje dag. Courtside använder lite hela tiden och mer bara när ni sänder. Räknaren ovan visar vad ert upplägg kräver."],
      ["Vad händer om tokens tar slut mitt i en match?", "Planens tokens fylls på varje dag och det ni inte använder sparas. Ligger ni nära gränsen inför en cup kan ni köpa ett tokenpaket i förväg. Det går aldrig ut."],
      ["Kan vem som helst se våra matcher?", "Bara de som har länken, och med PIN-kod påslagen bara de som också har koden. Vi rekommenderar alltid PIN-kod när barn och ungdomar spelar."],
      ["Hur hanterar vi GDPR och samtycke?", "Courtside körs i föreningens eget konto, så det är föreningen som bestämmer över filmerna. Eyevinn har ingen åtkomst. Berätta för föräldrarna att matcherna sänds och spelas in, bestäm hur länge de sparas och radera en match i adminvyn om någon ber om det."],
      ["Vad händer om vi glömmer admin-koden?", "Ägaren loggar in här på sidan med sitt OSC-konto och väljer <em>Glömt admin-koden?</em>. Tittarkoden och alla inspelningar finns kvar."],
      ["Sparas filmerna säkert?", "Filmerna ligger i föreningens egen lagring och finns kvar tills ni tar bort dem eller avslutar OSC-kontot. Det finns ingen automatisk säkerhetskopia av filmerna, så ladda ner de klipp ni vill spara för alltid. <a href=\"/data/\">Läs mer om era filmer</a>."],
      ["Behöver vi någon som kan IT?", "Nej. Den som sätter upp Courtside loggar in, väljer ett namn och klickar på Skapa. Alla nycklar och kopplingar ordnas automatiskt. Sedan är det en knapp i mobilen."],
      ["Fungerar det för andra sporter än basket?", "Sändning och inspelning fungerar för alla sporter, men perioder, pauser och klipplängd är idag anpassade för basket. Fler sporter är nästa steg."],
    ],
  },

  end: {
    h2: "Nästa hemmamatch kan vara live.", sub: "Sätt upp Courtside en kväll i veckan och sänd på helgen. 15 € i månaden för hela föreningen.",
    cta: "Kom igång", cta2: "Prata med oss", small: "Prova gratis med OSC:s gratisnivå.",
    mail: "mailto:sales@eyevinn.se?subject=Courtside%20f%C3%B6r%20v%C3%A5r%20f%C3%B6rening",
  },

  foot: {
    runs: "Courtside körs på", oss: "Öppen källkod (Apache-2.0)",
    links: [["/data/", "Era filmer"], ["/integritet/", "Integritet"], ["/support/", "Support"]],
    more: "Fler tjänster:",
  },

  film: { play: "Spela filmen" },
  filmA: {
    aria: "Animation: en mobil på stativ startar en sändning och matchen visas live i webbläsaren",
    c1: "En mobil på stativet. En knapp.", c2: "Live i webbläsaren. Hela familjen tittar, var de än är.",
    c3: "Spola tillbaka. Hoppa till live.", c4: "Slutsignal: hela matchen sparad som repris.",
    rec: "SÄNDER", domain: "dinforening.se", watching: "tittar", home: "HEMMA", away: "BORTA",
    grandma: "Mormor i Luleå", dad: "Pappa på jobbet", player: "Skadad spelare", backToLive: "Tillbaka till live",
    saved: "Matchen är sparad", m1: "Hemma – Borta", m1d: "Idag · 1:52:10", m2: "Seriematch", m2d: "Lör 18 okt", m3: "Cup, final", m3d: "Sön 5 okt",
  },
  filmB: {
    aria: "Animation: den som filmar trycker på stjärnan, klippet dyker upp i highlightlistan och visas i pausen",
    c1: "Något bra händer.", c2: "Tryck på stjärnan.", c3: "Klippet går att se direkt.", c4: "I pausen rullar matchens highlights. En signal när spelet är igång igen.",
    saved: "Klipp sparat", highlights: "Highlights", clip: "Trepoängare", justNow: "just nu", h1: "Block, #7", h2: "Snabbt anfall",
    sign: "Periodvila · matchen fortsätter snart", chime: "Spelet är igång",
  },
  filmC: {
    aria: "Animation: inloggning, val av namn, föreningens adress blir klar, mobilen skannar en QR-kod och kopplas",
    c1: "Logga in med ert OSC-konto.", c2: "Välj ett namn. Klicka på Skapa.", c3: "Några minuter senare: er egen adress.", c4: "Skanna koden med mobilen. Klart.",
    t1: "Starta er Courtside", signin: "Logga in med OSC", t2: "Föreningens namn", club: "Hornets Basket", create: "Skapa",
    t3: "Skapar Hornets Basket", k1: "Lagring", k2: "Inställningar", k3: "Webbplats", k4: "Er adress är klar",
    address: "hornets.apps.osaas.io", t4: "Lägg till kamera", paired: "Kopplad",
  },
};

export const en = {
  lang: "en", path: "/en/", other: { path: "/", label: "Svenska", flag: "🇸🇪", code: "SV" },
  title: "Courtside – stream your team's games live from a phone",
  description: "One parent, one iPhone, one tripod. The game live in any browser, instant highlights and every game saved. From €15 a month for the whole club, in your own account.",
  nav: { top: "Courtside, back to top", menu: "Main menu", how: "How it works", features: "Features", price: "Pricing", faq: "FAQ", start: "Get started", lang: "Switch language to Swedish" },

  inst: {
    h: "Your Courtside", signout: "Sign out", listH: "Installations in your account", empty: "You don't have a Courtside yet.",
    createH: "Start a new Courtside", display: "Club name", displayPh: "Hornets Basketball",
    expired: "Your Open Source Cloud sign-in has expired, so nothing was created. Sign in again and what you typed will still be there.", expiredBtn: "Sign in again",
    club: "Short name", clubPh: "hornets", clubHint: "Lowercase letters and digits. Becomes your address, shortname.apps.osaas.io, and names the services in your account.",
    create: "Create", takes: "Takes about ten minutes. Everything is created in your own OSC account and uses tokens from it.",
    creating: "Creating", steps: ["Checking the name", "Storage for recordings", "Access for the streaming engine", "Settings", "Website and backend", "Building (several minutes)", "Starting"],
    codeNote: "Your setup code. It is only shown now, so write it down.", address: "Address:", openPins: "Open and choose PIN codes", back: "Back",
  },

  hero: {
    eyebrow: "Live streaming for sports clubs",
    h1: "The whole team in the stands. Even the ones who can't make it.",
    lead: "Put an iPhone on a tripod and press one button. The game goes live in any browser, highlights are ready to watch instantly and the whole game is saved. No app for viewers, no ads.",
    priceBig: "From €15 a month", priceSmall: "for the whole club. No fees per team or per viewer.",
    cta: "Get started", cta2: "See how easy it is",
    chips: ["No app for viewers", "No ads", "Your club owns the videos"],
  },

  proof: {
    strong: "Built in the stands, not in a boardroom.",
    text: "Courtside started as one parent's fix for a basketball team in Stockholm and has streamed the team's games every weekend since early 2026. Now other clubs can do the same.",
    facts: [["1 button", "to go live"], ["0 apps", "for viewers"], ["≈ €1.50", "per game on the Personal plan"]],
  },

  how: {
    eyebrow: "How it works", h2: "From idea to live stream in one evening",
    sub: "No camera operator, no fixed camera in the gym, no IT skills needed. An iPhone, a tripod and Wi-Fi or 4G is all it takes.",
    steps: [
      ["Create your Courtside", "Sign in with an Open Source Cloud account, choose a name and click Create. A few minutes later your club has its own web address. All keys are set up automatically.", "Once per club"],
      ["Pair the phone", "Install the free camera app and scan the QR code in the admin view. Now the phone knows where to stream. Share the link in the team chat.", "Two minutes before tip-off"],
      ["Press Go live", "You're live. Tap the star when something great happens. When the final buzzer goes, the whole game is saved automatically.", "One button during the game"],
    ],
    cta: "Get started", small: "The camera app is free for iPhone and is coming to the App Store.",
  },

  who: {
    eyebrow: "For everyone around the team", h2: "One stream, four winners", sub: "Youth sports have always had more fans than seats in the stands.",
    cards: [
      ["Family", "Grandma three hours away, the dad stuck at work and the sibling at another game see it all live, wherever they are. Late arrivals just rewind.", "\"Grandma hasn't missed a game since spring.\""],
      ["The coach", "Every game is saved as a replay. Walk through the defence at the next practice and show what worked."],
      ["The players", "Highlights ready to watch right away, to download and share in the group chat the same evening."],
      ["The club", "Your own channel in your club colours and with your logo, at your own address. More people following the team, more to show sponsors."],
    ],
  },

  feat: {
    eyebrow: "Features", h2: "Everything a club needs. Nothing it doesn't.",
    sub: "Built for how a youth game actually works, with warm-ups, breaks and a parent doing the filming.",
    liveH: "Live in the browser, with rewind",
    liveP: "Viewers open a link in any browser. No app to download, no account to create. Missed a play? Rewind during the live game, then jump back to live.",
    liveTicks: ["Works on phones, tablets and computers, Android included", "Rewind during the game", "The whole game is saved automatically as a replay"],
    liveStart: "Start", liveHere: "You are here", liveNow: "Live ●",
    clipH: "Highlights you can watch right away",
    clipP: "The person filming taps the star. The clip is cut on the spot and <strong>is ready to watch right after it happened</strong>, while the game goes on. During breaks and timeouts the stream switches to a carousel of the game's highlights. A pause sign shows that play has stopped, and a chime sounds when it starts again.",
    clipTicks: ["One tap, no editing", "The clip is ready to watch seconds after it happened", "A highlight carousel in every break", "Download and share clips. A shared link works without the PIN"],
    cards: [
      ["One button on the phone", "The camera app is made for a parent holding a coffee in the other hand. Go live, pause, clip. That's it."],
      ["Viewer PIN", "It's often kids on camera. Lock the stream with a code only the team's families get. We always recommend it."],
      ["Your logo, your colours", "Pick a name, upload your logo and choose your club colour in the admin view. Changes show instantly for every viewer."],
      ["Game archive", "Every game collected and saved. Perfect before a rematch or the end-of-season party."],
      ["Admin view", "Rename games, delete what shouldn't stay, and pair new cameras by scanning a QR code."],
      ["More sports on the way", "Built for basketball today. Periods, breaks and clip length are settings, so more sports are next."],
    ],
  },

  own: {
    eyebrow: "Your videos, your rules", h2: "Your club owns its games",
    sub: "Courtside runs in your club's own Open Source Cloud account. No other platform holds your videos, shows ads around your kids or decides what happens to the footage. Not even us: Eyevinn has no access.",
    cards: [
      ["Your storage, your call", "Recordings live in your club's own storage. You decide how long to keep them, and you delete a game when a parent asks."],
      ["No ads, no algorithm", "The page shows your game and your highlights. Nothing else."],
      ["Never locked out", "Forgot the admin code? The owner signs in with their OSC account here on this page and gets back in. Videos and viewer code stay as they are."],
      ["Open source", "Courtside is built on open source (Apache-2.0). No lock-in to a closed sports platform."],
    ],
  },

  cmp: {
    eyebrow: "Compare", h2: "Why not just stream on social media?", sub: "You can, and many do. Here's the difference.",
    head: ["", "Courtside", "Social media", "Commercial sports channel"],
    rows: [
      ["Who owns the video", "Your club", "The platform, on its terms", "The provider"],
      ["Ads around the stream", "No", "Yes", "Often"],
      ["Who can watch", "Only the team's families, with a PIN", "Hard to restrict", "Paywall"],
      ["Highlights", "Instantly, with one tap", "No", "Sometimes, as an add-on"],
      ["Rewind during the game", "Yes", "Varies", "Yes"],
      ["Equipment", "An iPhone and a tripod", "A phone", "Often a fixed camera in the gym"],
      ["Cost", "From €15 a month for the whole club", "Free", "Subscription per team or venue"],
    ],
    cta: "See what €15 gets you",
  },

  price: {
    eyebrow: "Pricing", h2: "€15 a month. For the whole club.",
    sub: "Enough for about 10 games a month, 2–3 a week. That's around €1.50 a game. No fees per team, no fees per viewer. You pay for the hours you stream.",
    incH: "Here's what €15 a month gets you", incIntro: "Everything. There are no add-ons to unlock.",
    included: [
      ["Your club's own web address", "with your logo, name and club colour"],
      ["Live streaming in the browser", "no app and no account for viewers"],
      ["Rewind during the game", "and jump back to live"],
      ["Instant highlights", "one tap on the star, the clip is ready to watch right away"],
      ["Highlight carousel during breaks", "with a pause sign and a chime when play resumes"],
      ["Download and share clips", "shared links work without the PIN"],
      ["Every game saved as a replay", "automatically, in a game archive"],
      ["Viewer PIN", "so only the team's families can watch"],
      ["Admin view", "rename and delete games, pair cameras with a QR code"],
      ["The iPhone camera app", "free, coming to the App Store"],
      ["Storage for your recordings", "in your club's own account"],
      ["Automatic setup", "all keys and connections configured for you"],
      ["Never locked out", "reset a forgotten admin code with your OSC account"],
      ["No ads", "and no one else, not even Eyevinn, can access your videos"],
    ],
    incFoot: "The price is Open Source Cloud's Personal plan, €15 a month excl. VAT. Courtside runs in your own OSC account.",
    plans: {
      personal: { flag: "Right for most clubs", name: "Personal", price: "15", per: "€ / month", vat: "excl. VAT", for: "The team or smaller club streaming its home games.",
        rows: [["Games", "About 10 a month (2–3 a week)"], ["Price per game", "≈ €1.50"], ["Everything listed above", "✓"], ["Your own domain", "–"], ["Email on your club's domain", "–"], ["Tokens per day", "40"]],
        cta: "Start with Personal" },
      pro: { flag: "For large clubs", name: "Professional", price: "69", per: "€ / month", vat: "excl. VAT", for: "The club with many teams streaming home and away.",
        rows: [["Games", "Room for hundreds a month"], ["Price per game", "Drops the more you stream"], ["Everything listed above", "✓"], ["Your own domain, e.g. live.yourclub.com", "✓"], ["Email on your club's domain", "✓"], ["Tokens per day", "300"]],
        cta: "Start with Professional" },
    },
    tryH: "Want to try first?", tryP: "OSC's free tier gives you 100 tokens. That's enough to set up Courtside and stream a practice game before you decide.", tryCta: "Try it free",
    calcExplain: "Open Source Cloud bills in tokens: Courtside uses 31 a day for the website and storage and about 7 per hour of streaming, and the Personal plan gives you 40 a day.",
    calc: {
      h: "How far does the plan go?", hint: "Drag the sliders or pick an example.", presetsLabel: "Examples",
      presets: ["One team, home games", "A few teams", "The whole club"],
      matches: "Games per week", matchesHint: "All teams combined, in season.",
      hours: "Streaming time per game", hoursHint: "Including warm-up and breaks. The streaming engine stays on standby for an hour after the game, and that's included.",
      lead: "You need about", unit: "tokens / month", base: "Base (always on)", live: "Streaming", ofPlan: ["of", "in the plan"],
      reco: "Recommended OSC plan", recoDefault: "Personal <em>€15/month</em>",
    },
    extras: [
      ["Tournament weekend? Top up.", "Token packs cost €9.90 for 100 tokens and never expire. One pack covers about 5 more games, perfect for a tournament running from morning to night."],
      ["A quiet week pays for a busy weekend.", "Tokens you don't use are saved and roll over."],
    ],
    note: "The estimate is based on Open Source Cloud list prices and assumes the streaming engine only runs during games, plus one hour after. All prices in euros excl. VAT.",
  },

  worry: {
    h2: "What people usually ask",
    items: [
      ["\"Nobody here knows IT.\"", "You don't need anyone. Sign in, choose a name, click Create. Everything else is set up for you."],
      ["\"There are kids on camera.\"", "Turn on the PIN and only the team's families can watch. The videos are in your own account, and you delete a game when someone asks."],
      ["\"What if we forget the code?\"", "The owner signs in with their OSC account and gets back in. You're never locked out."],
      ["\"It must be expensive.\"", "€15 a month for the whole club, around €1.50 a game. No fees per team or per viewer."],
    ],
    cta: "Get started",
  },

  faq: {
    h2: "Frequently asked questions",
    items: [
      ["What equipment do we need?", "An iPhone, a tripod and a connection through the venue's Wi-Fi or mobile data. A good phone mount and a power bank help on a long game day, but that's all you need."],
      ["Where do we get the camera app?", "The camera app is free for iPhone and coming to the App Store. Want to try it before then? Get in touch. You pair the app with your Courtside by scanning the QR code in the admin view."],
      ["Does it work with Android?", "For viewers, yes: the stream plays in any browser. The camera app is iPhone only for now."],
      ["How soon can you watch a highlight?", "Right away. When the person filming taps the star, the play is clipped and ready to watch a few seconds later, while the game is still on. During breaks, all highlights play in a carousel."],
      ["Can we share clips?", "Yes. Clips can be downloaded and shared. A shared clip link works without the PIN, so think about what you share and with whom."],
      ["What does it actually cost?", "Courtside runs on Open Source Cloud. The Personal plan, €15 a month excl. VAT, covers about 10 games a month. Professional, €69 a month, has room for hundreds of games plus your own domain and email on your club's domain. No fees per team or per viewer."],
      ["What are tokens?", "Tokens are Open Source Cloud's currency. Your plan tops up with a fixed amount every day. Courtside uses a little all the time and more only while you stream. The calculator above shows what your setup needs."],
      ["What if we run out of tokens mid-game?", "Your plan tops up every day and unused tokens are saved. If you're close to the limit before a tournament, buy a token pack in advance. It never expires."],
      ["Can anyone watch our games?", "Only people with the link, and with a PIN switched on, only people who also have the code. We always recommend a PIN when kids and teenagers are playing."],
      ["How do we handle GDPR and consent?", "Courtside runs in your club's own account, so your club controls the videos. Eyevinn has no access. Tell parents that games are streamed and recorded, decide how long to keep them, and delete a game in the admin view if someone asks."],
      ["What if we forget the admin code?", "The owner signs in here with their OSC account and picks <em>Forgot the admin code?</em>. The viewer code and all recordings stay as they are."],
      ["Are the videos stored safely?", "Videos are kept in your club's own storage until you delete them or close the OSC account. There's no automatic backup of the videos, so download the clips you want to keep forever. <a href=\"/en/data/\">Read more about your videos</a>."],
      ["Do we need someone who knows IT?", "No. Whoever sets up Courtside signs in, chooses a name and clicks Create. All keys and connections are handled automatically. After that it's one button on the phone."],
      ["Does it work for sports other than basketball?", "Streaming and recording work for any sport, but periods, breaks and clip length are tuned for basketball today. More sports are next."],
    ],
  },

  end: {
    h2: "Your next home game could be live.", sub: "Set up Courtside one weeknight, stream at the weekend. €15 a month for the whole club.",
    cta: "Get started", cta2: "Talk to us", small: "Try it free on OSC's free tier.",
    mail: "mailto:sales@eyevinn.se?subject=Courtside%20for%20our%20club",
  },

  foot: {
    runs: "Courtside runs on", oss: "Open source (Apache-2.0)",
    links: [["/en/data/", "Your videos"], ["/en/privacy/", "Privacy"], ["/en/support/", "Support"]],
    more: "More services:",
  },

  film: { play: "Play film" },
  filmA: {
    aria: "Animation: a phone on a tripod starts a stream and the game appears live in a browser",
    c1: "A phone on a tripod. One button.", c2: "Live in any browser. The whole family watches, wherever they are.",
    c3: "Rewind. Jump back to live.", c4: "Final buzzer: the whole game saved as a replay.",
    rec: "LIVE", domain: "yourclub.com", watching: "watching", home: "HOME", away: "AWAY",
    grandma: "Grandma, 300 km away", dad: "Dad at work", player: "Injured player", backToLive: "Back to live",
    saved: "Game saved", m1: "Home – Away", m1d: "Today · 1:52:10", m2: "League game", m2d: "Sat 18 Oct", m3: "Cup final", m3d: "Sun 5 Oct",
  },
  filmB: {
    aria: "Animation: the person filming taps the star, the clip appears in the highlight list and plays during the break",
    c1: "Something great happens.", c2: "Tap the star.", c3: "Ready to watch right away.", c4: "Breaks play the game's highlights. A chime when play is back on.",
    saved: "Clip saved", highlights: "Highlights", clip: "Three-pointer", justNow: "just now", h1: "Block, #7", h2: "Fast break",
    sign: "Break · game resumes soon", chime: "Play is back on",
  },
  filmC: {
    aria: "Animation: sign in, choose a name, the club's address is ready, the phone scans a QR code and pairs",
    c1: "Sign in with your OSC account.", c2: "Choose a name. Click Create.", c3: "A few minutes later: your own address.", c4: "Scan the code with the phone. Done.",
    t1: "Start your Courtside", signin: "Sign in with OSC", t2: "Club name", club: "Hornets Basketball", create: "Create",
    t3: "Creating Hornets Basketball", k1: "Storage", k2: "Settings", k3: "Website", k4: "Your address is ready",
    address: "hornets.apps.osaas.io", t4: "Add camera", paired: "Paired",
  },
};
