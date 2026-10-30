// === First-run setup ===
//
// A fresh installation has no admin PIN.  Whoever holds the one-time setup
// code chooses the club's PINs here, and comes out of it logged in as admin —
// ready to pair the first camera.

import { CONFIG } from "./config.js";
import { state } from "./state.js";

/** After a reset an empty viewer PIN keeps the old one, so it opens nothing. */
let keepsViewerPin = false;

/** Whether the backend is waiting for setup.  False if it cannot be asked. */
export async function isSetupRequired() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/setup`);
    if (!res.ok) return false;
    const data = await res.json();
    // After a reset, an empty viewer PIN keeps the one viewers already have.
    if (data.keepsViewerPin) {
      const hint = document.getElementById("setupViewerPinHint");
      if (hint) hint.textContent = "Lämna tom för att behålla den tittarkod ni redan har.";
      keepsViewerPin = true;
      document.getElementById("setupOpenRow")?.classList.add("hidden");
    }
    return !!data.required;
  } catch {
    return false;
  }
}

/**
 * Show the setup form in place of everything else.
 * @param {Function} onDone - called once logged in as admin
 */
export function showSetup(onDone) {
  const view = document.getElementById("setupView");
  const form = document.getElementById("setupForm");
  const code = document.getElementById("setupCode");
  const adminPin = document.getElementById("setupAdminPin");
  const viewerPin = document.getElementById("setupViewerPin");
  const submit = document.getElementById("setupSubmit");
  const error = document.getElementById("setupError");

  for (const id of ["pinView", "streamListView", "vodListView", "adminView", "playerView", "tabNav"]) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  }
  view.classList.remove("hidden");
  // The installer links here with the code in the fragment, which never
  // reaches a server log.  Take it and drop it from the address bar.
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("setup");
  if (fromLink) {
    code.value = fromLink;
    history.replaceState(null, "", location.pathname + location.search);
  }
  (fromLink ? adminPin : code).focus();

  function fail(message) {
    error.textContent = message;
    error.classList.remove("hidden", "shake");
    void error.offsetWidth;
    error.classList.add("shake");
    submit.disabled = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.classList.add("hidden");

    const body = {
      code: code.value.trim(),
      adminPin: adminPin.value.trim(),
      viewerPin: viewerPin.value.trim(),
      openAccess: document.getElementById("setupOpenAccess").checked,
    };
    if (!body.code) return fail("Fyll i uppsättningskoden.");
    if (!/^\d{6,8}$/.test(body.adminPin)) return fail("Admin-koden ska vara 6–8 siffror.");
    // It is usually children on the film: an empty field alone does not open watching to anyone.
    if (!body.viewerPin && !body.openAccess && !keepsViewerPin) {
      return fail("Välj en tittarkod, eller kryssa i att alla som har adressen får titta.");
    }
    if (body.viewerPin && !/^\d{4,8}$/.test(body.viewerPin)) return fail("Tittarkoden ska vara 4–8 siffror.");
    if (body.viewerPin && body.viewerPin === body.adminPin) return fail("Tittarkoden och admin-koden måste vara olika.");

    submit.disabled = true;
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || "Det gick inte att spara — försök igen.");

      state.viewerToken = data.token;
      state.adminToken = data.adminToken;
      try {
        localStorage.setItem("viewerToken", data.token);
        localStorage.setItem("adminToken", data.adminToken);
      } catch {}

      view.classList.add("hidden");
      onDone();
    } catch {
      fail("Kunde inte ansluta — försök igen.");
    }
  });
}
