// === Shared state module ===
// Centralized mutable state used across all modules.
// Import `state` to read; import setters to update.

export const state = {
  // Auth
  viewerToken: localStorage.getItem("viewerToken") || null,
  adminToken: localStorage.getItem("adminToken") || null,

  // Tab / mode
  activeTab: "live", // "live" | "vod" | "admin"
  isVodMode: false,
  isDvrMode: false,

  // Current stream/VOD being played
  currentStreamUrl: null,
  currentStreamId: null,
  currentStatus: "offline",
  hlsReconnectAttempts: 0,
  liveStartTime: null,

  // HLS instance
  hls: null,

  // Timer IDs
  controlsTimeout: null,
  streamPollTimer: null,
  listPollTimer: null,
  vodPollTimer: null,
  viewerHeartbeatTimer: null,

  // Seek state
  isSeeking: false,

  // Highlight carousel (during pause)
  highlightClips: [],
  highlightIndex: -1,
  highlightHls: null,
  isPlayingHighlights: false,
};

export const MAX_RECONNECT_ATTEMPTS = 30;

// --- DOM element references (initialised once from initDom) ---
export const dom = {};

export function initDom() {
  // PIN view
  dom.pinView = document.getElementById("pinView");
  dom.pinInput = document.getElementById("pinInput");
  dom.pinSubmit = document.getElementById("pinSubmit");
  dom.pinError = document.getElementById("pinError");

  // Stream list
  dom.streamListView = document.getElementById("streamListView");
  dom.streamGrid = document.getElementById("streamGrid");
  dom.emptyState = document.getElementById("emptyState");
  dom.emptyBg = document.getElementById("emptyBg");
  dom.emptyLogo = document.getElementById("emptyLogo");
  dom.emptyTitle = document.getElementById("emptyTitle");
  dom.emptySub = document.getElementById("emptySub");

  // VOD list
  dom.vodListView = document.getElementById("vodListView");
  dom.vodGrid = document.getElementById("vodGrid");
  dom.vodEmptyState = document.getElementById("vodEmptyState");

  // Player
  dom.playerView = document.getElementById("playerView");
  dom.backBtn = document.getElementById("backBtn");
  dom.tabNav = document.getElementById("tabNav");
  dom.backBtnText = document.getElementById("backBtnText");

  // Progress bar
  dom.progressContainer = document.getElementById("progressContainer");
  dom.controls = document.getElementById("controls");
  dom.progressBar = document.getElementById("progressBar");
  dom.progressBuffered = document.getElementById("progressBuffered");
  dom.progressFilled = document.getElementById("progressFilled");
  dom.progressHandle = document.getElementById("progressHandle");
  dom.timeElapsed = document.getElementById("timeElapsed");
  dom.timeDuration = document.getElementById("timeDuration");

  // Video & wrapper
  dom.video = document.getElementById("video");
  dom.wrapper = document.getElementById("videoWrapper");
  dom.overlay = document.getElementById("overlay");
  dom.overlayText = dom.overlay.querySelector(".overlay-text");
  dom.overlaySpinner = document.getElementById("overlaySpinner");

  // Controls
  dom.playBtn = document.getElementById("playBtn");
  dom.muteBtn = document.getElementById("muteBtn");
  dom.volumeSlider = document.getElementById("volumeSlider");
  dom.fullscreenBtn = document.getElementById("fullscreenBtn");
  dom.qualityBtn = document.getElementById("qualityBtn");
  dom.qualityLabel = document.getElementById("qualityLabel");
  dom.qualityMenu = document.getElementById("qualityMenu");
  dom.liveBadge = document.getElementById("liveBadge");
  dom.statusDot = document.getElementById("statusDot");
  dom.backToLiveBtn = document.getElementById("backToLiveBtn");
  dom.streamTitle = document.getElementById("streamTitle");
  dom.streamDesc = document.getElementById("streamDesc");
  dom.pipBtn = document.getElementById("pipBtn");

  // Icons
  dom.iconPlay = dom.playBtn.querySelector(".icon-play");
  dom.iconPause = dom.playBtn.querySelector(".icon-pause");
  dom.iconVol = dom.muteBtn.querySelector(".icon-vol");
  dom.iconMuted = dom.muteBtn.querySelector(".icon-muted");
  dom.iconFsEnter = dom.fullscreenBtn.querySelector(".icon-fs-enter");
  dom.iconFsExit = dom.fullscreenBtn.querySelector(".icon-fs-exit");

  // Highlights
  dom.highlightsSection = document.getElementById("highlightsSection");
  dom.highlightsGrid = document.getElementById("highlightsGrid");
  dom.clipPlayer = document.getElementById("clipPlayer");
  dom.clipVideo = document.getElementById("clipVideo");

  // Header / Admin
  dom.headerLogout = document.getElementById("headerLogout");
  dom.adminView = document.getElementById("adminView");
  dom.adminTab = document.getElementById("adminTab");
  dom.adminLogout = document.getElementById("adminLogout");
  dom.adminStorageSummary = document.getElementById("adminStorageSummary");
  dom.adminVodList = document.getElementById("adminVodList");
}
