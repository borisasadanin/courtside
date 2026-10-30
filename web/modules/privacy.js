// === About the recordings ===
//
// The club is responsible for what it records, and the people on the film —
// usually children and their parents — must be able to find out who that is,
// who can watch, how long it is kept and how to have something removed.  The
// club fills in who and where in the admin view; the rest is the same for
// every Courtside.  Shown from the footer, the PIN screen and the clip page.

import { CONFIG } from "./config.js";
import { club } from "./club.js";
import { escapeHtml } from "./utils.js";

/** Who answers for the recordings: what the admin entered, else the club's name. */
function controller() {
  return club.privacy?.controller || club.shortName || club.name;
}

/** The notice itself, as HTML. `pinRequired` is null when it is not known. */
export function privacyNoticeHtml(pinRequired) {
  const who = escapeHtml(controller());
  const contact = club.privacy?.contact;
  const policy = club.privacy?.policyUrl;
  const watchers = pinRequired === false
    ? "Alla som har adressen till sidan kan titta på sändningar och inspelningar."
    : "Bara den som har föreningens tittarkod kan titta på sändningar och inspelningar.";

  return `
    <h2>Om inspelningarna</h2>
    <p>${who} sänder och spelar in matcher här, så att lagets familjer och vänner kan följa dem. Det är ${who} som ansvarar för filmerna och klippen.</p>
    <h3>Vem kan titta</h3>
    <p>${watchers} Ett klipp som någon delar kan ses av den som får länken, men det går inte att ladda ner därifrån.</p>
    <p>Filmerna är till för lagets familjer. Sprid dem inte vidare utan lov.</p>
    <h3>Hur länge de sparas</h3>
    <p>Inspelningar och klipp sparas tills föreningen tar bort dem.</p>
    <h3>Om du eller ditt barn syns på filmen</h3>
    <p>Du kan be föreningen ta bort ett klipp eller en match, fråga vilka inspelningar som finns, eller säga att du inte vill bli filmad. Är du inte nöjd med svaret kan du vända dig till Integritetsskyddsmyndigheten, <a href="https://www.imy.se" target="_blank" rel="noopener">imy.se</a>.</p>
    <h3>Kontakt</h3>
    <p>${contact
      ? `Skriv till <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.`
      : `Kontakta ${who}.`}
      ${policy ? ` Läs också <a href="${escapeHtml(policy)}" target="_blank" rel="noopener">föreningens integritetspolicy</a>.` : ""}</p>
    <p class="privacy-note">Sidan körs av föreningen själv, på föreningens eget konto hos Open Source Cloud. Ingen reklam och ingen spårning.</p>`;
}

let dialog = null;

/** Open the notice in a dialog. */
export async function openPrivacy() {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "privacy-dialog";
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog || e.target.closest("[data-privacy-close]")) dialog.close();
    });
    document.body.appendChild(dialog);
  }
  let pinRequired = null;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/auth/status`);
    if (res.ok) pinRequired = !!(await res.json()).pinRequired;
  } catch { /* the notice reads fine without it */ }
  dialog.innerHTML = `
    <div class="privacy-body">
      ${privacyNoticeHtml(pinRequired)}
      <button class="pin-btn privacy-close" data-privacy-close>Stäng</button>
    </div>`;
  if (!dialog.open) dialog.showModal();
}

/** Make every [data-privacy-open] link open the notice. Safe to call again for new links. */
export function initPrivacy() {
  document.querySelectorAll("[data-privacy-open]:not([data-privacy-bound])").forEach((el) => {
    el.setAttribute("data-privacy-bound", "");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openPrivacy();
    });
  });
}
