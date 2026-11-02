// Text for modules/devices.js, Swedish and English side by side.

export default {
  sv: {
    loadError: "Kunde inte hämta kameror ({error})",
    noneSub: "Ingen kamera parad ännu",
    pairedCount: ({ n }) => `${n} parad${n === 1 ? "" : "e"}`,
    empty: "Ingen kamera är parad ännu.",
    pairedOn: "parad {date}",
    lastSeen: "senast aktiv {date}",
    sure: "Säker?",
    failed: "Gick inte",

    fetchingCode: "Hämtar kod…",
    scan: "Skanna koden med telefonens kamera, eller i Courtside-appen.",
    manual: "Eller skriv in manuellt:",
    codeError: "Kunde inte hämta kod ({error})",
    expired: "Koden gick ut. Skapa en ny.",
    validFor: "Koden gäller i {time}",
  },
  en: {
    loadError: "Couldn't load cameras ({error})",
    noneSub: "No camera paired yet",
    pairedCount: ({ n }) => `${n} paired`,
    empty: "No camera is paired yet.",
    pairedOn: "paired {date}",
    lastSeen: "last active {date}",
    sure: "Sure?",
    failed: "Didn't work",

    fetchingCode: "Getting a code…",
    scan: "Scan the code with the phone's camera, or in the Courtside app.",
    manual: "Or enter it manually:",
    codeError: "Couldn't get a code ({error})",
    expired: "The code expired. Create a new one.",
    validFor: "The code is valid for {time}",
  },
};
