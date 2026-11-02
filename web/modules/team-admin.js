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
import { t } from "./i18n.js";

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
    alert(t("team-admin.loggedOut"));
    deactivateAdmin();
    throw new Error(data.error || t("common.adminRequired"));
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
    list.innerHTML = `<p class="admin-empty">${escapeHtml(t("team-admin.loadError", { error: err.message }))}</p>`;
    return;
  }

  const missing = teams.filter((tm) => !tm.logoUrl).length;
  const sub = document.getElementById("adminRowTeamsSub");
  if (sub) {
    sub.textContent = teams.length === 0
      ? t("page.teamsSub")
      : t("team-admin.rowSub", { n: teams.length, missing });
  }

  if (teams.length === 0) {
    list.innerHTML = `<p class="admin-empty">${escapeHtml(t("team-admin.empty"))}</p>`;
    return;
  }

  list.replaceChildren();
  const own = teams.filter((tm) => tm.own);
  const others = teams.filter((tm) => !tm.own);
  if (own.length) list.append(heading(t("team-admin.ownTeams")), ...own.map((tm) => teamRow(tm, teams)));
  if (others.length) list.append(heading(t("team-admin.opponents")), ...others.map((tm) => teamRow(tm, teams)));
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
        <label class="branding-field">${escapeHtml(t("team-admin.name"))}
          <input type="text" name="name" maxlength="60" autocomplete="off" required>
        </label>
        <label class="team-own"><input type="checkbox" name="own"> ${escapeHtml(t("team-admin.ownCheckbox"))}</label>
        <div class="branding-save-row">
          <button class="admin-pair-btn" type="submit">${escapeHtml(t("team-admin.add"))}</button>
          <button class="branding-link" type="button" data-action="cancel">${escapeHtml(t("common.cancel"))}</button>
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
      status.textContent = t("common.saving");
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
  if (!team.logoUrl) meta.push(`<span class="team-no-logo">${escapeHtml(t("team-admin.noLogo"))}</span>`);
  if (team.aliases.length) meta.push(escapeHtml(t("team-admin.alsoKnownAs", { names: team.aliases.join(", ") })));
  info.innerHTML = `
    <span class="device-name">${escapeHtml(team.name)}</span>
    <span class="device-meta">${meta.join(" · ")}</span>`;
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "device-revoke";
  edit.textContent = t("team-admin.edit");
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
  const derivedShort = deriveShortName(team.name, team.own);
  const others = all.filter((tm) => tm.id !== team.id);
  const form = document.createElement("form");
  form.className = "admin-branding team-edit";
  form.innerHTML = `
    <div class="branding-logo-row">
      <span class="team-edit-badge"></span>
      <div class="branding-logo-actions">
        <button type="button" class="admin-pair-btn branding-upload" data-action="pick">${escapeHtml(team.logoUrl ? t("team-admin.changeLogo") : t("team-admin.uploadLogo"))}</button>
        <input type="file" accept="image/*" class="visually-hidden-file">
        ${team.logoUrl ? `<button type="button" class="branding-link" data-action="remove-logo">${escapeHtml(t("team-admin.removeLogo"))}</button>` : ""}
        <span class="branding-status" data-status="logo" role="status"></span>
      </div>
    </div>
    <label class="branding-field">${escapeHtml(t("team-admin.name"))}
      <input type="text" name="name" maxlength="60" value="${escapeHtml(team.name)}">
    </label>
    <label class="branding-field">${escapeHtml(t("team-admin.shortName"))}
      <input type="text" name="shortName" maxlength="4" placeholder="${escapeHtml(derivedShort)}"
        value="${team.shortName !== derivedShort ? escapeHtml(team.shortName) : ""}" autocomplete="off">
    </label>
    <label class="branding-field branding-colour">${escapeHtml(t("team-admin.colour"))}
      <input type="color" name="color" value="${escapeHtml(team.color)}">
      <button type="button" class="branding-link" data-action="derive-colour">${escapeHtml(t("team-admin.colourFromName"))}</button>
    </label>
    <label class="team-own"><input type="checkbox" name="own"${team.own ? " checked" : ""}> ${escapeHtml(t("team-admin.ownCheckbox"))}</label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" type="submit">${escapeHtml(t("common.save"))}</button>
      <button class="device-revoke" type="button" data-action="delete">${escapeHtml(t("team-admin.deleteTeam"))}</button>
      <span class="branding-status" data-status="save" role="status"></span>
    </div>
    ${others.length ? `
    <div class="team-merge">
      <label class="branding-field">${escapeHtml(t("team-admin.sameTeamAs"))}
        <select name="merge">
          <option value="">${escapeHtml(t("team-admin.chooseTeam"))}</option>
          ${others.map((tm) => `<option value="${escapeHtml(tm.id)}">${escapeHtml(tm.name)}</option>`).join("")}
        </select>
      </label>
      <p class="privacy-admin-intro">${escapeHtml(t("team-admin.mergeIntro", { team: team.name }))}</p>
      <button class="device-revoke" type="button" data-action="merge" disabled>${escapeHtml(t("team-admin.merge"))}</button>
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
    status("save", t("team-admin.colourFromNameNote"));
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {
      name: form.elements.name.value,
      shortName: form.elements.shortName.value,
      own: form.elements.own.checked,
    };
    if (colour !== undefined) body.color = colour;
    act("save", t("common.saving"), () => send("PUT", `/api/admin/teams/${encodeURIComponent(team.id)}`, body));
  });

  // Same file picking as the club logo: a hidden input opened from a button (Safari).
  const input = form.querySelector('input[type="file"]');
  form.querySelector('[data-action="pick"]').addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    act("logo", t("team-admin.uploading"), async () => {
      await send("PUT", `/api/admin/teams/${encodeURIComponent(team.id)}/logo`, { dataUrl: await resize(file) });
    });
  });
  form.querySelector('[data-action="remove-logo"]')?.addEventListener("click", () =>
    act("logo", t("team-admin.deleting"), () => send("DELETE", `/api/admin/teams/${encodeURIComponent(team.id)}/logo`)));

  // Two clicks, like removing a camera.
  const del = form.querySelector('[data-action="delete"]');
  del.addEventListener("click", () => {
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = t("team-admin.sure");
      setTimeout(() => {
        del.dataset.confirm = "";
        del.textContent = t("team-admin.deleteTeam");
      }, 4000);
      return;
    }
    act("save", t("team-admin.deleting"), () => send("DELETE", `/api/admin/teams/${encodeURIComponent(team.id)}`), false);
  });

  const merge = form.querySelector('[data-action="merge"]');
  if (merge) {
    const select = form.elements.merge;
    select.addEventListener("change", () => { merge.disabled = !select.value; });
    merge.addEventListener("click", () => act("save", t("team-admin.merging"), () =>
      send("POST", `/api/admin/teams/${encodeURIComponent(team.id)}/merge`, { from: select.value })));
  }

  return form;
}
