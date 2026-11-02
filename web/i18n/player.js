// Text for modules/player.js, Swedish and English side by side.

export default {
  sv: {
    pause: "PAUS",
    pausePeriod: "PERIODPAUS",
    pauseTimeout: "TIMEOUT",
    pauseSub: "Matchen återupptas strax",
    pauseSubHighlights: "Matchen återupptas strax — här är höjdpunkterna",
    resuming: "MATCHEN ÅTERUPPTAS",

    badgeConnecting: "ANSLUTER",
    badgeLive: "LIVE",
    badgeOffline: "OFFLINE",
    badgeReplay: "REPRIS",
    badgeHighlights: "HÖJDPUNKTER",

    connecting: "Ansluter till sändningen…",
    reconnecting: "Återansluter ({n}/{max})…",
    waiting: "Väntar på sändningen…",
    noBroadcast: "Ingen sändning just nu",
    paused: "Sändningen är pausad — återkommer snart",
    interrupted: "Sändningen verkar ha avbrutits",
    ended: "Sändningen har avslutats",
    lostServer: "Tappade kontakten med servern",
    noHls: "Din webbläsare stöder inte HLS-uppspelning",
    replayFailed: "Kunde inte spela upp reprisen",

    qualityAuto: "Auto",
    qualityAutoLevel: "Auto ({height}p)",

    highlightsCount: ({ n }) => `${n} höjdpunkt${n > 1 ? "er" : ""} från matchen`,
    highlightOf: "Höjdpunkt {n} av {total}",

    allReplays: "Alla repriser",
    replay: "Repris",
    recordedMatch: "Inspelad match.",
  },
  en: {
    pause: "BREAK",
    pausePeriod: "QUARTER BREAK",
    pauseTimeout: "TIMEOUT",
    pauseSub: "The game resumes shortly",
    pauseSubHighlights: "The game resumes shortly — here are the highlights",
    resuming: "GAME RESUMING",

    badgeConnecting: "CONNECTING",
    badgeLive: "LIVE",
    badgeOffline: "OFFLINE",
    badgeReplay: "REPLAY",
    badgeHighlights: "HIGHLIGHTS",

    connecting: "Connecting to the broadcast…",
    reconnecting: "Reconnecting ({n}/{max})…",
    waiting: "Waiting for the broadcast…",
    noBroadcast: "No broadcast right now",
    paused: "The broadcast is paused — back soon",
    interrupted: "The broadcast seems to have been interrupted",
    ended: "The broadcast has ended",
    lostServer: "Lost contact with the server",
    noHls: "Your browser doesn't support HLS playback",
    replayFailed: "Couldn't play the replay",

    qualityAuto: "Auto",
    qualityAutoLevel: "Auto ({height}p)",

    highlightsCount: ({ n }) => `${n} highlight${n > 1 ? "s" : ""} from the game`,
    highlightOf: "Highlight {n} of {total}",

    allReplays: "All replays",
    replay: "Replay",
    recordedMatch: "Recorded game.",
  },
};
