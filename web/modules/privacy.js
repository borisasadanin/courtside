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
import { t } from "./i18n.js";

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
    ? t("privacy.watchersOpen")
    : t("privacy.watchersPin");

  return `
    <h2>${t("privacy.title")}</h2>
    <p>${t("privacy.intro", { who })}</p>
    <h3>${t("privacy.whoTitle")}</h3>
    <p>${watchers} ${t("privacy.sharedClips")}</p>
    <p>${t("privacy.familiesOnly")}</p>
    <h3>${t("privacy.keptTitle")}</h3>
    <p>${t("privacy.kept")}</p>
    <h3>${t("privacy.rightsTitle")}</h3>
    <p>${t("privacy.rights")}</p>
    <h3>${t("privacy.contactTitle")}</h3>
    <p>${contact
      ? t("privacy.writeTo", { contact: escapeHtml(contact) })
      : t("privacy.contactWho", { who })}
      ${policy ? ` ${t("privacy.policy", { url: escapeHtml(policy) })}` : ""}</p>
    <p class="privacy-note">${t("privacy.note")}</p>`;
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
      <button class="pin-btn privacy-close" data-privacy-close>${t("common.close")}</button>
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
