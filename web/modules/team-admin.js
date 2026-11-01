// === Teams, in Hantera ===
//
// The club's own teams and the opponents they meet (ABL-047). Opponents typed
// in the camera app show up here by themselves, marked "saknar logga" until
// someone uploads one. Duplicates that slipped in ("AIK" and "A.I.K.") are
// merged, and the merged team keeps the other's recordings.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import { resize } from "./branding.js";
import { setTeams, teamBadge, deriveShortName } from "./teams.js";

/** The team whose form is open, kept open across a reload of the list. */
let openId = null;

function adminHeaders(json) {
  const h = { "X-Admin-Token": state.adminToken };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function send(method, path, body) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    method,
    headers: adminHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401) {
    alert("Du har loggats ut från admin. Logga in igen med admin-koden.");
    deactivateAdmin();
    throw new Error(data.error || "Admin-åtkomst krävs");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Load the registry and draw the list, the add form and the row in Hantera. */
export async function renderTeamsAdmin() {
  const list = document.getElementById("adminTeamList");
  if (!list) return;
  bindAdd();

  let teams;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/teams`, { headers: adminHeaders(false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    teams = setTeams(await res.json());
  } catch (err) {
    list.innerHTML = `<p class="admin-empty">Kunde inte hämta lagen (${escapeHtml(err.message)})</p>`;
    return;
  }

  const missing = teams.filter((t) => !t.logoUrl).length;
  const sub = document.getElementById("adminRowTeamsSub");
  if (sub) {
    sub.textContent = teams.length === 0
      ? "Egna lag och motståndare"
      : `${teams.length} lag${missing ? ` · ${missing} saknar logga` : ""}`;
  }

  if (teams.length === 0) {
    list.innerHTML = `<p class="admin-empty">Inga lag ännu. Lägg in föreningens egna lag, till exempel P12 och F14. Motståndare som skrivs in i appen kommer hit av sig själva.</p>`;
    return;
  }

  list.replaceChildren();
  const own = teams.filter((t) => t.own);
  const others = teams.filter((t) => !t.own);
  if (own.length) list.append(heading("Egna lag"), ...own.map((t) => teamRow(t, teams)));
  if (others.length) list.append(heading("Motståndare"), ...others.map((t) => teamRow(t, teams)));
}

function heading(text) {
  const h = document.createElement("p");
  h.className = "admin-eyebrow team-group";
  h.textContent = text;
  return h;
}

function bindAdd() {
  const btn = document.getElementById("adminTeamAdd");
  const panel = document.getElementById("adminTeamAddPanel");
  if (!btn || !panel || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", () => {
    panel.classList.remove("hidden");
    panel.innerHTML = `
      <form class="admin-branding">
        <label class="branding-field">Namn
          <input type="text" name="name" maxlength="60" autocomplete="off" required>
        </label>
        <label class="team-own"><input type="checkbox" name="own"> Ett av föreningens egna lag</label>
        <div class="branding-save-row">
          <button class="admin-pair-btn" type="submit">Lägg till</button>
          <button class="branding-link" type="button" data-action="cancel">Avbryt</button>
          <span class="branding-status" role="status"></span>
        </div>
      </form>`;
    const form = panel.querySelector("form");
    const status = form.querySelector(".branding-status");
    form.elements.name.focus();
    form.querySelector('[data-action="cancel"]').addEventListener("click", () => panel.classList.add("hidden"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      status.classList.remove("error");
      status.textContent = "Sparar…";
      try {
        await send("POST", "/api/admin/teams", { name: form.elements.name.value, own: form.elements.own.checked });
        panel.classList.add("hidden");
        await renderTeamsAdmin();
      } catch (err) {
        status.textContent = err.message;
        status.classList.add("error");
      }
    });
  });
}

/** One team: badge, name and what it lacks, and a form to change it. */
function teamRow(team, all) {
  const wrap = document.createElement("div");
  wrap.className = "team-item";

  const row = document.createElement("div");
  row.className = "device-row team-row";
  const info = document.createElement("div");
  info.className = "device-info";
  const meta = [escapeHtml(team.shortName)];
  if (!team.logoUrl) meta.push('<span class="team-no-logo">saknar logga</span>');
  if (team.aliases.length) meta.push(`även ${team.aliases.map(escapeHtml).join(", ")}`);
  info.innerHTML = `
    <span class="device-name">${escapeHtml(team.name)}</span>
    <span class="device-meta">${meta.join(" · ")}</span>`;
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "device-revoke";
  edit.textContent = "Ändra";
  row.append(teamBadge(team), info, edit);

  const form = editForm(team, all);
  form.classList.toggle("hidden", openId !== team.id);
  edit.addEventListener("click", () => {
    const opening = form.classList.contains("hidden");
    openId = opening ? team.id : null;
    form.classList.toggle("hidden", !opening);
  });

  wrap.append(row, form);
  return wrap;
}

function editForm(team, all) {
  const derivedShort = deriveShortName(team.name);
  const others = all.filter((t) => t.id !== team.id);
  const form = document.createElement("form");
  form.className = "admin-branding team-edit";
  form.innerHTML = `
    <div class="branding-logo-row">
      <span class="team-edit-badge"></span>
      <div class="branding-logo-actions">
        <button type="button" class="admin-pair-btn branding-upload" data-action="pick">${team.logoUrl ? "Byt logga" : "Ladda upp logga"}</button>
        <input type="file" accept="image/*" class="visually-hidden-file">
        ${team.logoUrl ? '<button type="button" class="branding-link" data-action="remove-logo">Ta bort logga</button>' : ""}
        <span class="branding-status" data-status="logo" role="status"></span>
      </div>
    </div>
    <label class="branding-field">Namn
      <input type="text" name="name" maxlength="60" value="${escapeHtml(team.name)}">
    </label>
    <label class="branding-field">Kortnamn, 2–4 tecken
      <input type="text" name="shortName" maxlength="4" placeholder="${escapeHtml(derivedShort)}"
        value="${team.shortName !== derivedShort ? escapeHtml(team.shortName) : ""}" autocomplete="off">
    </label>
    <label class="branding-field branding-colour">Färg
      <input type="color" name="color" value="${escapeHtml(team.color)}">
      <button type="button" class="branding-link" data-action="derive-colour">Från namnet</button>
    </label>
    <label class="team-own"><input type="checkbox" name="own"${team.own ? " checked" : ""}> Ett av föreningens egna lag</label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" type="submit">Spara</button>
      <button class="device-revoke" type="button" data-action="delete">Ta bort lag</button>
      <span class="branding-status" data-status="save" role="status"></span>
    </div>
    ${others.length ? `
    <div class="team-merge">
      <label class="branding-field">Samma lag som
        <select name="merge">
          <option value="">Välj lag…</option>
          ${others.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}
        </select>
      </label>
      <p class="privacy-admin-intro">Det valda laget slås ihop med ${escapeHtml(team.name)}. Dess matcher och namn följer med.</p>
      <button class="device-revoke" type="button" data-action="merge" disabled>Slå ihop</button>
    </div>` : ""}`;

  form.querySelector(".team-edit-badge").append(teamBadge(team, { size: "lg" }));

  const status = (which, text, isError = false) => {
    const el = form.querySelector(`[data-status="${which}"]`);
    el.textContent = text;
    el.classList.toggle("error", isError);
  };
  /** Run a change, then redraw the list with this team's form still open. */
  const act = async (which, busy, change, keepOpen = true) => {
    status(which, busy);
    try {
      await change();
      openId = keepOpen ? team.id : null;
      await renderTeamsAdmin();
    } catch (err) {
      status(which, err.message, true);
    }
  };

  // Only a colour the admin touched is sent; otherwise the team keeps following its name.
  let colour;
  form.elements.color.addEventListener("input", () => { colour = form.elements.color.value; });
  form.querySelector('[data-action="derive-colour"]').addEventListener("click", () => {
    colour = "";
    status("save", "Färgen räknas fram ur namnet när du sparar.");
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {
      name: form.elements.name.value,
      shortName: form.elements.shortName.value,
      own: form.elements.own.checked,
    };
    if (colour !== undefined) body.color = colour;
    act("save", "Sparar…", () => send("PUT", `/api/admin/teams/${encodeURIComponent(team.id)}`, body));
  });

  // Same file picking as the club logo: a hidden input opened from a button (Safari).
  const input = form.querySelector('input[type="file"]');
  form.querySelector('[data-action="pick"]').addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    act("logo", "Laddar upp…", async () => {
      await send("PUT", `/api/admin/teams/${encodeURIComponent(team.id)}/logo`, { dataUrl: await resize(file) });
    });
  });
  form.querySelector('[data-action="remove-logo"]')?.addEventListener("click", () =>
    act("logo", "Tar bort…", () => send("DELETE", `/api/admin/teams/${encodeURIComponent(team.id)}/logo`)));

  // Two clicks, like removing a camera.
  const del = form.querySelector('[data-action="delete"]');
  del.addEventListener("click", () => {
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = "Säker?";
      setTimeout(() => {
        del.dataset.confirm = "";
        del.textContent = "Ta bort lag";
      }, 4000);
      return;
    }
    act("save", "Tar bort…", () => send("DELETE", `/api/admin/teams/${encodeURIComponent(team.id)}`), false);
  });

  const merge = form.querySelector('[data-action="merge"]');
  if (merge) {
    const select = form.elements.merge;
    select.addEventListener("change", () => { merge.disabled = !select.value; });
    merge.addEventListener("click", () => act("save", "Slår ihop…", () =>
      send("POST", `/api/admin/teams/${encodeURIComponent(team.id)}/merge`, { from: select.value })));
  }

  return form;
}
