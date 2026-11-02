// Text for modules/streams.js, Swedish and English side by side.

export default {
  sv: {
    // The live page's empty state, per broadcast status ("idle" uses page.emptyTitle)
    liveTitle: "En match sänds just nu",
    liveSub: "Den dyker upp här strax.",
    upcomingTitle: "En basketmatch startar snart!",
    upcomingSub: "Sändningen börjar inom kort",
    pausedTitle: "Matchen är pausad",
    pausedSub: "Sändningen fortsätter snart",
    endedTitle: "Tack för att du tittade!",
    endedSub: "Matchen är slut",

    nextMatch: "Nästa match",
    later: "Sedan",
    upcomingMatches: "Kommande matcher",
    addToCalendar: "Lägg till i kalendern",
    addToCalendarLabel: "Lägg till {own} mot {opponent} i kalendern",

    // Status pills on the cards, and how a screen reader says them
    soon: "SNART",
    soonSpoken: "startar snart",
    live: "LIVE",
    liveSpoken: "live",
    waiting: "STARTAR",
    waitingSpoken: "startar",
    stopped: "AVBRUTEN",
    stoppedSpoken: "avbruten",
    paused: "PAUS",
    pausedSpoken: "paus",

    viewers: ({ n }) => `${n} tittare`,
    period: "Period {n}",
    watch: "Titta",
    watchLive: "Titta live",
  },
  en: {
    liveTitle: "A game is live right now",
    liveSub: "It will show up here shortly.",
    upcomingTitle: "A basketball game starts soon!",
    upcomingSub: "The broadcast starts shortly",
    pausedTitle: "The game is on a break",
    pausedSub: "The broadcast continues soon",
    endedTitle: "Thanks for watching!",
    endedSub: "The game is over",

    nextMatch: "Next game",
    later: "After that",
    upcomingMatches: "Upcoming games",
    addToCalendar: "Add to calendar",
    addToCalendarLabel: "Add {own} vs {opponent} to your calendar",

    soon: "SOON",
    soonSpoken: "starting soon",
    live: "LIVE",
    liveSpoken: "live",
    waiting: "STARTING",
    waitingSpoken: "starting",
    stopped: "STOPPED",
    stoppedSpoken: "stopped",
    paused: "BREAK",
    pausedSpoken: "break",

    viewers: ({ n }) => (n === 1 ? "1 viewer" : `${n} viewers`),
    period: "Quarter {n}",
    watch: "Watch",
    watchLive: "Watch live",
  },
};
