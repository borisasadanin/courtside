// === Deployment configuration ===
//
// Leave apiUrl empty: the backend serves this website from its own origin and
// answers /runtime-config.js itself, so this file only matters when the
// website is hosted somewhere else.  Then set apiUrl to the backend's address.
// It is served as-is and never bundled, so an edit needs no rebuild.
window.COURTSIDE_CONFIG = {
  apiUrl: "",
};
