// === Sponsors as cards, in Hantera > Sponsring (#121, phase 0) ===
//
// Each sponsor is a card: logo or initials, name, package, teams, whether it
// is active and how many clips it has. The card opens a form for the name,
// link, package, teams, the package's surfaces and the logo (#131, #132,
// #134). The sponsor's clips are drawn inside its card by sponsor-admin.js
// (#133), which owns the page and hands in what the cards need as `ctx`:
//
//   ctx.data           what GET /api/admin/sponsorship answered
//   ctx.teams          the club's own teams
//   ctx.send()         an admin request that throws the API's message
//   ctx.reload()       fetch everything again and redraw
//   ctx.redraw()       redraw from ctx.data
//   ctx.clips(sponsor) the sponsor's clip grid, an element
//   ctx.upload(id)     pick files to upload under this sponsor
//   ctx.saveOrder(ids) store a new order of the sponsors

import { escapeHtml, mediaUrl } from "./utils.js";
import { resize } from "./branding.js";

/** The sponsor whose form is open, kept open across a redraw. */
let openId = null;
/** The sponsor whose removal waits for "Ja, ta bort". */
let confirmDeleteId = null;
let dragging = false;

/** Whether a card or a clip row is being dragged: the page must not redraw under the finger. */
export function isDragging() {
  return dragging;
}

/** Open a sponsor's form, for a sponsor just added. */
export function openSponsorForm(id) {
  openId = id;
  confirmDeleteId = null;
}

// --- Text ---

/** "ICA Maxi" → "IM", "Bageriet" → "BA". */
export function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "Hela klubben", "Inga lag" or the teams' names. */
export function teamsText(sponsor, teams) {
  if (sponsor.teamsGone) return "Inga lag";
  if (!sponsor.teamIds.length) return "Hela klubben";
  const names = sponsor.teamIds.map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "Inga lag";
}

function packageOf(data, sponsor) {
  return data.packages.find((p) => p.id === sponsor.packageId);
}

/** The package's surfaces that are released, in the order of the surface list. */
function packageSurfaces(data, packageId) {
  const pkg = data.packages.find((p) => p.id === packageId);
  return data.surfaces.filter((s) => s.available && pkg?.surfaces.includes(s.id));
}

// --- Surfaces for the installation (#134) ---

/** One switch per released surface. Surfaces of later phases are not shown at all. */
export function surfaceSection(ctx) {
  const box = document.createElement("section");
  box.className = "sponsor-section sponsor-surfaces";
  box.setAttribute("aria-labelledby", "sponsorSurfacesTitle");
  box.innerHTML = `<h3 class="admin-section-title" id="sponsorSurfacesTitle">Ytor</h3>
    <p class="privacy-admin-intro">Var sponsorerna visas. En yta som är av visas inte för någon sponsor.</p>
    <div class="sponsor-switches"></div>`;
  const list = box.querySelector(".sponsor-switches");
  for (const surface of ctx.data.surfaces.filter((s) => s.available)) {
    const label = document.createElement("label");
    label.className = "sponsor-switch";
    label.innerHTML = `<input type="checkbox" role="switch"${surface.on ? " checked" : ""}>
      <span class="sponsor-switch-text">${escapeHtml(surface.label)}</span>
      <span class="sponsor-switch-state">${surface.on ? "På" : "Av"}</span>`;
    const input = label.querySelector("input");
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        const res = await ctx.send("PATCH", "/api/admin/sponsorship/surfaces", { [surface.id]: input.checked });
        ctx.data.surfaces = res.surfaces;
      } catch (err) {
        alert(`Kunde inte spara: ${err.message}`);
      }
      ctx.redraw();
    });
    list.append(label);
  }
  return box;
}

// --- Adding a sponsor (#131) ---

/** The form under "Lägg till sponsor": name, package and teams. The rest is in the card. */
export function addSponsorForm(panel, ctx) {
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  const form = document.createElement("form");
  form.className = "admin-branding";
  form.innerHTML = `
    <label class="branding-field">Namn
      <input type="text" name="name" maxlength="80" autocomplete="off" required>
    </label>
    ${packageField(ctx.data, "gold")}
    ${teamsField(ctx, { teamIds: [] })}
    <div class="branding-save-row">
      <button class="admin-pair-btn" type="submit">Lägg till</button>
      <button class="branding-link" type="button" data-action="cancel">Avbryt</button>
      <span class="branding-status" role="status"></span>
    </div>`;
  panel.append(form);
  bindTeamsField(form);
  form.elements.name.focus();
  const status = form.querySelector(".branding-status");
  form.querySelector('[data-action="cancel"]').addEventListener("click", () => panel.classList.add("hidden"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.classList.remove("error");
    status.textContent = "Sparar…";
    try {
      const { sponsor } = await ctx.send("POST", "/api/admin/sponsorship/sponsors", {
        name: form.elements.name.value,
        packageId: form.elements.packageId.value,
        teamIds: chosenTeams(form),
      });
      panel.classList.add("hidden");
      openSponsorForm(sponsor.id);
      await ctx.reload();
      document.querySelector(`.sponsor-card[data-id="${sponsor.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("error");
    }
  });
}

function packageField(data, chosen) {
  return `<label class="branding-field">Paket
      <select name="packageId" class="sponsor-select">
        ${data.packages.slice().sort((a, b) => a.priority - b.priority)
          .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === chosen ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
    </label>`;
}

/** "Hela klubben" or a choice of the club's own teams. */
function teamsField(ctx, sponsor) {
  const some = sponsor.teamIds.length > 0 || sponsor.teamsGone;
  const name = `teams-${Math.random().toString(36).slice(2, 8)}`;
  const boxes = ctx.teams.length
    ? ctx.teams.map((t) => `<label class="team-own"><input type="checkbox" name="teamId" value="${escapeHtml(t.id)}"${sponsor.teamIds.includes(t.id) ? " checked" : ""}> ${escapeHtml(t.name)}</label>`).join("")
    : `<p class="privacy-admin-intro">Lägg in föreningens egna lag under Lag för att kunna välja dem här.</p>`;
  return `<fieldset class="sponsor-fieldset">
      <legend class="sponsor-legend">Gäller</legend>
      <label class="team-own"><input type="radio" name="${name}" value="club"${some ? "" : " checked"}> Hela klubben</label>
      <label class="team-own"><input type="radio" name="${name}" value="teams"${some ? " checked" : ""}${ctx.teams.length ? "" : " disabled"}> Bara vissa lag</label>
      <div class="sponsor-team-list${some ? "" : " hidden"}">${boxes}</div>
      ${sponsor.teamsGone ? '<p class="branding-status error">Lagen sponsorn gällde finns inte längre. Den visas ingenstans tills du väljer lag igen.</p>' : ""}
    </fieldset>`;
}

function bindTeamsField(form) {
  const list = form.querySelector(".sponsor-team-list");
  form.querySelectorAll('.sponsor-fieldset input[type="radio"]').forEach((r) => {
    r.addEventListener("change", () => list.classList.toggle("hidden", r.value === "club" && r.checked));
  });
}

/** The teams ticked, or [] for the whole club. */
function chosenTeams(form) {
  const some = form.querySelector('.sponsor-fieldset input[type="radio"][value="teams"]')?.checked;
  if (!some) return [];
  return [...form.querySelectorAll('input[name="teamId"]:checked')].map((b) => b.value);
}

// --- The card (#131) ---

export function sponsorCard(sponsor, index, ctx) {
  const { data } = ctx;
  const card = document.createElement("article");
  card.className = `sponsor-card${sponsor.active ? "" : " sponsor-inactive"}`;
  card.dataset.id = sponsor.id;
  card.setAttribute("aria-label", sponsor.name);

  const pkg = packageOf(data, sponsor);
  const meta = [
    escapeHtml(pkg?.name ?? "Okänt paket"),
    sponsor.teamsGone ? '<span class="sponsor-warn-text">Inga lag</span>' : escapeHtml(teamsText(sponsor, ctx.teams)),
    sponsor.active ? "" : '<span class="sponsor-warn-text">Inaktiv</span>',
    sponsor.clipCount === 1 ? "1 klipp" : `${sponsor.clipCount} klipp`,
  ].filter(Boolean);
  const last = index === data.sponsors.length - 1;

  const head = document.createElement("div");
  head.className = "sponsor-card-head";
  head.innerHTML = `
    <button type="button" class="sponsor-handle" aria-label="Flytta ${escapeHtml(sponsor.name)}. Dra, eller använd pil upp och ner.">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
    </button>
    ${logo(sponsor)}
    <div class="sponsor-card-text">
      <span class="sponsor-card-name">${escapeHtml(sponsor.name)}</span>
      <span class="sponsor-card-meta">${meta.join(" · ")}</span>
    </div>
    <div class="sponsor-card-actions">
      <button type="button" class="sponsor-step" data-step="-1" aria-label="Flytta ${escapeHtml(sponsor.name)} upp"${index === 0 ? " disabled" : ""}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="sponsor-step" data-step="1" aria-label="Flytta ${escapeHtml(sponsor.name)} ner"${last ? " disabled" : ""}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="device-revoke" data-action="edit" aria-expanded="${openId === sponsor.id}">${openId === sponsor.id ? "Stäng" : "Ändra"}</button>
    </div>`;
  card.append(head);

  head.querySelector('[data-action="edit"]').addEventListener("click", () => {
    openId = openId === sponsor.id ? null : sponsor.id;
    confirmDeleteId = null;
    ctx.redraw();
  });
  for (const btn of head.querySelectorAll(".sponsor-step")) {
    btn.addEventListener("click", () => step(sponsor.id, Number(btn.dataset.step), ctx, btn.dataset.step));
  }
  bindSortable(head.querySelector(".sponsor-handle"), card, {
    selector: ".sponsor-card",
    ids: () => [...document.querySelectorAll("#adminSponsors .sponsor-card")].map((c) => c.dataset.id),
    onStart: () => { openId = null; },
    onDrop: (ids) => ctx.saveOrder(ids),
    onKey: (dir) => step(sponsor.id, dir, ctx),
  });

  if (openId === sponsor.id) card.append(editForm(sponsor, ctx));

  const clips = document.createElement("div");
  clips.className = "sponsor-card-clips";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "admin-pair-btn sponsor-card-upload";
  upload.textContent = "Ladda upp klipp";
  upload.addEventListener("click", () => ctx.upload(sponsor.id));
  clips.append(ctx.clips(sponsor), upload);
  card.append(clips);
  return card;
}

function logo(sponsor) {
  return sponsor.logoUrl
    ? `<span class="sponsor-logo"><img src="${escapeHtml(mediaUrl(sponsor.logoUrl))}" alt=""></span>`
    : `<span class="sponsor-logo sponsor-logo-initials" aria-hidden="true">${escapeHtml(initials(sponsor.name))}</span>`;
}

/** Move a sponsor a step up (-1) or down (1), then give the focus back to the same button. */
async function step(id, dir, ctx, focusStep) {
  const ids = ctx.data.sponsors.map((x) => x.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await ctx.saveOrder(ids);
  const card = document.querySelector(`.sponsor-card[data-id="${id}"]`);
  const again = focusStep && card?.querySelector(`.sponsor-step[data-step="${focusStep}"]`);
  (again && !again.disabled ? again : card?.querySelector(".sponsor-handle"))?.focus();
}

// --- The form (#131, #132, #134) ---

function editForm(sponsor, ctx) {
  const { data } = ctx;
  const form = document.createElement("form");
  form.className = "admin-branding sponsor-edit";
  form.innerHTML = `
    <div class="branding-logo-row">
      ${logo(sponsor).replace("sponsor-logo", "sponsor-logo sponsor-logo-lg")}
      <div class="branding-logo-actions">
        <button type="button" class="admin-pair-btn branding-upload" data-action="pick">${sponsor.logoUrl ? "Byt logga" : "Ladda upp logga"}</button>
        <input type="file" accept="image/png,image/jpeg,image/webp" class="visually-hidden-file" tabindex="-1" aria-hidden="true">
        ${sponsor.logoUrl ? '<button type="button" class="branding-link" data-action="remove-logo">Ta bort logga</button>' : ""}
        <span class="branding-status" data-status="logo" role="status">PNG, JPG eller WebP, högst 1 MB.</span>
      </div>
    </div>
    <label class="branding-field">Namn
      <input type="text" name="name" maxlength="80" value="${escapeHtml(sponsor.name)}" autocomplete="off">
    </label>
    <label class="branding-field">Länk till sponsorns webbplats
      <input type="text" name="url" inputmode="url" autocomplete="off" placeholder="https://" value="${escapeHtml(sponsor.url || "")}">
    </label>
    ${packageField(data, sponsor.packageId)}
    ${teamsField(ctx, sponsor)}
    <fieldset class="sponsor-fieldset">
      <legend class="sponsor-legend">Visas på</legend>
      <div class="sponsor-surface-boxes"></div>
    </fieldset>
    <label class="team-own"><input type="checkbox" name="active"${sponsor.active ? " checked" : ""}> Aktiv: visas för tittarna</label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" type="submit">Spara</button>
      <span class="branding-status" data-status="save" role="status"></span>
    </div>
    <div class="sponsor-remove"></div>`;

  bindTeamsField(form);

  const status = (which, text, isError = false) => {
    const el = form.querySelector(`[data-status="${which}"]`);
    el.textContent = text;
    el.classList.toggle("error", isError);
  };

  // The package's surfaces as boxes; a box ticked off puts the surface in `off`.
  const boxes = form.querySelector(".sponsor-surface-boxes");
  const drawBoxes = () => {
    const surfaces = packageSurfaces(data, form.elements.packageId.value);
    boxes.innerHTML = surfaces.length
      ? surfaces.map((s) => `<label class="team-own"><input type="checkbox" name="surface" value="${escapeHtml(s.id)}"${sponsor.off.includes(s.id) ? "" : " checked"}>
          ${escapeHtml(s.label)}${s.on ? "" : ' <span class="sponsor-off-note">avstängd under Ytor</span>'}</label>`).join("")
      : '<p class="privacy-admin-intro">Paketet har inga ytor som finns ännu.</p>';
  };
  drawBoxes();
  form.elements.packageId.addEventListener("change", drawBoxes);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const shown = packageSurfaces(data, form.elements.packageId.value).map((s) => s.id);
    const ticked = [...form.querySelectorAll('input[name="surface"]:checked')].map((b) => b.value);
    // Surfaces not shown here (later phases, other packages) keep what they had.
    const off = [...sponsor.off.filter((id) => !shown.includes(id)), ...shown.filter((id) => !ticked.includes(id))];
    const body = {
      name: form.elements.name.value,
      url: form.elements.url.value.trim(),
      packageId: form.elements.packageId.value,
      off,
      active: form.elements.active.checked,
    };
    const teamIds = chosenTeams(form);
    // A sponsor whose teams are gone keeps showing nowhere until teams are chosen.
    const someChosen = form.querySelector('.sponsor-fieldset input[type="radio"][value="teams"]')?.checked;
    if (!(sponsor.teamsGone && someChosen && teamIds.length === 0)) body.teamIds = teamIds;
    if (someChosen && teamIds.length === 0 && !sponsor.teamsGone) {
      status("save", "Välj minst ett lag, eller Hela klubben.", true);
      return;
    }
    status("save", "Sparar…");
    try {
      const res = await ctx.send("PATCH", `/api/admin/sponsorship/sponsors/${encodeURIComponent(sponsor.id)}`, body);
      replaceSponsor(ctx, res.sponsor);
      ctx.redraw();
      document.querySelector(`.sponsor-card[data-id="${sponsor.id}"] [data-status="save"]`)?.replaceChildren("Sparat.");
    } catch (err) {
      status("save", err.message, true);
    }
  });

  // --- Logo (#132): the same picking as the teams' logos, a hidden input opened from a button (Safari) ---
  const input = form.querySelector('input[type="file"]');
  form.querySelector('[data-action="pick"]').addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const refused = logoRefusal(file);
    if (refused) return status("logo", refused, true);
    status("logo", "Laddar upp…");
    try {
      const dataUrl = await resize(file);
      const res = await ctx.send("PUT", `/api/admin/sponsorship/sponsors/${encodeURIComponent(sponsor.id)}/logo`, { dataUrl });
      replaceSponsor(ctx, res.sponsor);
      ctx.redraw();
    } catch (err) {
      status("logo", err.message, true);
    }
  });
  form.querySelector('[data-action="remove-logo"]')?.addEventListener("click", async () => {
    status("logo", "Tar bort…");
    try {
      const res = await ctx.send("DELETE", `/api/admin/sponsorship/sponsors/${encodeURIComponent(sponsor.id)}/logo`);
      replaceSponsor(ctx, res.sponsor);
      ctx.redraw();
    } catch (err) {
      status("logo", err.message, true);
    }
  });

  drawRemoval(form.querySelector(".sponsor-remove"), sponsor, ctx);
  return form;
}

/**
 * Why a picked file cannot be a logo, or null. The browser would turn an SVG
 * into a PNG without complaint, so it is refused here, before resize().
 */
export function logoRefusal(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type === "image/svg+xml" || name.endsWith(".svg")) return "SVG går inte att använda. Spara loggan som PNG, JPG eller WebP och försök igen.";
  if (type && !["image/png", "image/jpeg", "image/webp"].includes(type)) return "Loggan ska vara PNG, JPG eller WebP.";
  if (file.size > 10 * 1024 * 1024) return "Bilden är för stor. Välj en bild på högst 10 MB.";
  return null;
}

function drawRemoval(box, sponsor, ctx) {
  if (confirmDeleteId !== sponsor.id) {
    box.innerHTML = `<button class="device-revoke sponsor-delete" type="button">Ta bort sponsorn</button>`;
    box.querySelector("button").addEventListener("click", () => {
      confirmDeleteId = sponsor.id;
      drawRemoval(box, sponsor, ctx);
      box.querySelector('[data-act="no"]')?.focus();
    });
    return;
  }
  box.innerHTML = `<div class="sponsor-confirm" role="alertdialog" aria-labelledby="sponsorDel-${sponsor.id}">
      <p id="sponsorDel-${sponsor.id}">Ta bort <strong>${escapeHtml(sponsor.name)}</strong>? Sponsorn och dess logga tas bort för gott.</p>
      <div class="sponsor-confirm-actions">
        <button class="device-revoke sponsor-delete-yes" type="button" data-act="yes">Ja, ta bort</button>
        <button class="admin-pair-btn" type="button" data-act="no">Avbryt</button>
      </div>
      <span class="branding-status" role="status"></span>
    </div>`;
  box.querySelector('[data-act="no"]').addEventListener("click", () => {
    confirmDeleteId = null;
    drawRemoval(box, sponsor, ctx);
  });
  const yes = box.querySelector('[data-act="yes"]');
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    try {
      await ctx.send("DELETE", `/api/admin/sponsorship/sponsors/${encodeURIComponent(sponsor.id)}`);
      openId = null;
      confirmDeleteId = null;
      await ctx.reload();
    } catch (err) {
      // 409 while it has clips: say so where the admin is looking.
      yes.disabled = false;
      const st = box.querySelector(".branding-status");
      st.textContent = err.message;
      st.classList.add("error");
    }
  });
}

function replaceSponsor(ctx, sponsor) {
  const i = ctx.data.sponsors.findIndex((x) => x.id === sponsor.id);
  if (i !== -1) ctx.data.sponsors[i] = sponsor;
}

// --- Sorting by dragging (#100, #134) ---

/**
 * Drag an item by its handle, with a finger or a mouse. The item follows the
 * pointer and the others make room; the new order is handed to onDrop when
 * it is let go. Arrow keys on the handle call onKey for the keyboard. Used
 * for the sponsors' cards and for the clips within a sponsor.
 */
export function bindSortable(handle, item, { selector, ids, onStart, onDrop, onKey }) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Listened for on the window: moving the item in the DOM releases any pointer capture.
    const pointer = e.pointerId;
    dragging = true;
    onStart?.();
    const parent = item.parentElement;
    const startY = e.clientY;
    const startTop = item.offsetTop;
    const before = ids();
    item.classList.add("sponsor-dragging");

    const move = (ev) => {
      if (ev.pointerId !== pointer) return;
      const others = [...parent.children].filter((r) => r !== item && r.matches(selector));
      // Where the item's middle would be, without the transform.
      const mid = startTop + (ev.clientY - startY) + item.offsetHeight / 2;
      const next = others.find((r) => mid < r.offsetTop + r.offsetHeight / 2);
      if (next) { if (item.nextElementSibling !== next) parent.insertBefore(item, next); }
      else if (others.length && others[others.length - 1].nextElementSibling !== item) others[others.length - 1].after(item);
      // The item follows the pointer from wherever the DOM has put it.
      item.style.transform = `translateY(${ev.clientY - startY - (item.offsetTop - startTop)}px)`;
    };
    const up = (ev) => {
      if (ev.pointerId !== pointer) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      item.classList.remove("sponsor-dragging");
      item.style.transform = "";
      dragging = false;
      const after = ids();
      if (after.join() !== before.join()) onDrop(after);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onKey(e.key === "ArrowUp" ? -1 : 1);
  });
}
