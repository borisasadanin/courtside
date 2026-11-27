/**
 * Sponsors, packages and surfaces (#121, phase 0): the version 2 file and its
 * migration from v0.8 (#123), the one function that decides who is shown
 * where (#125), and the registry's changes (#126).
 *
 * What matters: a club's clips from v0.8 keep playing exactly as before, a
 * rollback to v0.8.1 still finds its clips, and an exclusive surface never
 * gets a second sponsor for the same team.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SponsorRegistry,
  SPONSORS_KEY,
  DEFAULT_BREAK_SECONDS,
  DEFAULT_PACKAGES,
  migrate,
  type SponsorClip,
  type SponsorSettings,
} from "../sponsors.js";
import { SURFACES, exclusiveConflicts, sponsorsFor } from "../sponsor-surfaces.js";
import { TEAMS, V081_FILE, memoryStorage } from "./sponsor-fakes.js";

const teams = { get: async (id: string) => (TEAMS as Record<string, { id: string; name: string; own: boolean }>)[id] ?? null };

/** What v0.8.1's load() and playlist() made of a file, word for word apart from the types. */
function v081Read(raw: string) {
  const parsed = JSON.parse(raw) as { clips?: SponsorClip[]; breakSeconds?: object };
  const settings = { clips: parsed.clips ?? [], breakSeconds: { ...DEFAULT_BREAK_SECONDS, ...(parsed.breakSeconds ?? {}) } };
  const playlist: Record<string, string[]> = {};
  for (const clip of settings.clips) {
    if (clip.status !== "ready") continue;
    for (const slot of clip.slots) (playlist[slot] ??= []).push(clip.id);
  }
  return { settings, playlist };
}

function storageWith(raw: string) {
  const storage = memoryStorage();
  storage.files.set(SPONSORS_KEY, { body: raw, type: "application/json" });
  return storage;
}

describe("migration from v0.8 (#123)", () => {
  it("keeps every clip, each under a sponsor of its own in Guld, with the same slots and order", async () => {
    const storage = storageWith(V081_FILE);
    const registry = new SponsorRegistry(storage, { teams });
    const s = await registry.readAll();
    const original = JSON.parse(V081_FILE).clips;

    expect(s.version).toBe(2);
    expect(s.clips.map((c) => c.id)).toEqual(original.map((c: SponsorClip) => c.id));
    expect(s.clips.map((c) => c.slots)).toEqual(original.map((c: SponsorClip) => c.slots));
    expect(s.sponsors.map((x) => [x.id, x.name, x.packageId, x.teamIds, x.active])).toEqual([
      ["a1b2c3d4e5f6", "ICA Maxi", "gold", [], true],
      ["0f9e8d7c6b5a", "Bilfirman", "gold", [], true],
      ["112233445566", "Pizzerian", "gold", [], true],
    ]);
    expect(s.clips.map((c) => c.sponsorId)).toEqual(s.sponsors.map((x) => x.id));
    expect(s.breakSeconds.p2).toBe(600);
    expect(s.packages.map((p) => p.name)).toEqual(["Platinum", "Guld", "Silver"]);
    // Clips on, as in v0.8; every new surface off.
    expect(Object.entries(s.surfaces).filter(([, on]) => on).map(([id]) => id)).toEqual(["start", "p1", "p2", "p3", "ot", "end"]);
    expect(s.seasonStart).toBeUndefined();
    // Nothing is written by reading.
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
    expect(storage.files.get(SPONSORS_KEY)?.body).toBe(V081_FILE);
  });

  it("plays the same clips in the same order as v0.8.1", async () => {
    const registry = new SponsorRegistry(storageWith(V081_FILE), { teams });
    const playlist = await registry.playlist();
    const before = v081Read(V081_FILE).playlist;
    expect(Object.fromEntries(Object.entries(playlist).map(([slot, clips]) => [slot, clips!.map((c) => c.id)]))).toEqual(before);
  });

  it("gives the same sponsor ids on every read", async () => {
    const one = await new SponsorRegistry(storageWith(V081_FILE)).readAll();
    const two = await new SponsorRegistry(storageWith(V081_FILE)).readAll();
    expect(two.sponsors).toEqual(one.sponsors);
    expect(two.clips.map((c) => c.sponsorId)).toEqual(one.clips.map((c) => c.sponsorId));
  });

  it("writes a file that v0.8.1 reads to the same clips", async () => {
    const storage = storageWith(V081_FILE);
    const registry = new SponsorRegistry(storage, { teams });
    await registry.createSponsor({ name: "Banken", packageId: "platinum" });
    await registry.setBreakSeconds({ p3: 180 });

    const written = storage.files.get(SPONSORS_KEY)!.body.toString();
    expect(JSON.parse(written).version).toBe(2);
    const old = v081Read(written);
    const before = v081Read(V081_FILE);
    expect(old.settings.clips.map(({ sponsorId: _s, ...c }) => c)).toEqual(before.settings.clips);
    expect(old.playlist).toEqual(before.playlist);
    expect(old.settings.breakSeconds).toEqual({ ...before.settings.breakSeconds, p3: 180 });
  });

  it("gives a sponsor to a clip in a v2 file that has none, as one added by v0.8.1 after a rollback", async () => {
    const v2 = migrate(JSON.parse(V081_FILE));
    v2.sponsors[0].name = "ICA Maxi AB";
    const added = { ...JSON.parse(V081_FILE).clips[0], id: "aaaaaaaaaaaa", name: "Nytt klipp" };
    const raw = JSON.stringify({ ...v2, clips: [...v2.clips, added] });
    const s = await new SponsorRegistry(storageWith(raw)).readAll();
    expect(s.sponsors).toHaveLength(4);
    expect(s.sponsors[0].name).toBe("ICA Maxi AB");
    expect(s.sponsors[3]).toMatchObject({ id: "aaaaaaaaaaaa", name: "Nytt klipp", packageId: "gold" });
    expect(s.clips[3].sponsorId).toBe("aaaaaaaaaaaa");
  });

  it("gives a sponsor back to clips whose sponsors a v0.8.1 write dropped", async () => {
    const v2 = migrate(JSON.parse(V081_FILE));
    // v0.8.1 writes only clips and break lengths; the clips keep their sponsorId.
    const raw = JSON.stringify({ clips: v2.clips, breakSeconds: v2.breakSeconds });
    const s = await new SponsorRegistry(storageWith(raw)).readAll();
    expect(s.sponsors.map((x) => x.id)).toEqual(v2.sponsors.map((x) => x.id));
  });

  it("starts empty with the default packages", async () => {
    const registry = new SponsorRegistry(memoryStorage());
    expect(registry.snapshot().packages).toEqual(DEFAULT_PACKAGES);
    await registry.ready();
    const s = registry.snapshot();
    expect(s).toMatchObject({ version: 2, clips: [], sponsors: [] });
    // A copy: changing it changes nothing.
    s.sponsors.push({} as never);
    expect(registry.snapshot().sponsors).toEqual([]);
  });

  it("gives snapshot() the file once ready() has read it", async () => {
    const registry = new SponsorRegistry(storageWith(V081_FILE));
    await registry.ready();
    expect(registry.snapshot().sponsors).toHaveLength(3);
  });
});

// --- sponsorsFor (#125) ---

/** Settings with the given sponsors (each with one ready clip in every clip slot unless clips are given). */
function settings(
  sponsors: Partial<SponsorSettings["sponsors"][number]>[],
  extra: Partial<SponsorSettings> = {},
): SponsorSettings {
  const base = migrate({});
  const full = sponsors.map((x, i) => ({
    id: `s${i}`, name: `Sponsor ${i}`, packageId: "gold", teamIds: [], off: [], active: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...x,
  }));
  const clips: SponsorClip[] = full.map((x) => ({
    id: `c-${x.id}`, name: `Klipp ${x.name}`, sponsorId: x.id, status: "ready",
    slots: ["start", "p1", "p2", "p3", "ot", "end"], durationSeconds: 10,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return { ...base, sponsors: full, clips, ...extra };
}

const names = (s: SponsorSettings, team: string | null, surface: string) =>
  sponsorsFor(s, team, surface).map((p) => p.sponsor.name);

describe("sponsorsFor (#125)", () => {
  it.each([
    ["the surface is on, in the package, active, the club's: shown", {}, {}, ["A"]],
    ["the surface is off for the installation", {}, { surfaces: { ...migrate({}).surfaces, start: false } }, []],
    ["the surface is not in the package", { packageId: "silver" }, {}, []],
    ["the sponsor has the surface switched off", { off: ["start"] }, {}, []],
    ["the sponsor is not active", { active: false }, {}, []],
    ["the sponsor is another team's", { teamIds: ["f14"] }, {}, []],
    ["the sponsor is the team's", { teamIds: ["p12"] }, {}, ["A"]],
    ["the sponsor's teams were all removed", { teamIds: [], teamsGone: true }, {}, []],
  ] as const)("%s", (_what, sponsor, extra, expected) => {
    const s = settings([{ name: "A", ...(sponsor as object) }], extra as Partial<SponsorSettings>);
    expect(names(s, "p12", "start")).toEqual(expected);
  });

  it("puts the team's sponsors before the club's", () => {
    const s = settings([{ name: "Klubb" }, { name: "Lag", teamIds: ["p12"] }]);
    expect(names(s, "p12", "start")).toEqual(["Lag", "Klubb"]);
    expect(names(s, "f14", "start")).toEqual(["Klubb"]);
    // No team known: only the club's.
    expect(names(s, null, "start")).toEqual(["Klubb"]);
  });

  it("puts Platinum before Guld, then keeps the admin's order", () => {
    const s = settings([{ name: "Guld 1" }, { name: "Platinum", packageId: "platinum" }, { name: "Guld 2" }]);
    expect(names(s, null, "p1")).toEqual(["Platinum", "Guld 1", "Guld 2"]);
  });

  it("shows only ready clips, with the surface in their slots", () => {
    const s = settings([{ name: "A" }, { name: "B" }]);
    s.clips[0] = { ...s.clips[0], status: "processing" };
    s.clips[1] = { ...s.clips[1], slots: ["end"] };
    expect(names(s, null, "start")).toEqual([]);
    expect(sponsorsFor(s, null, "end").map((p) => p.clips.map((c) => c.id))).toEqual([["c-s1"]]);
  });

  it("shows nothing on a surface that is not released, even when switched on", () => {
    const s = settings([{ name: "A", packageId: "platinum" }]);
    s.surfaces.mvp = true;
    expect(SURFACES.find((x) => x.id === "mvp")?.available).toBe(false);
    expect(names(s, null, "mvp")).toEqual([]);
    expect(names(s, null, "timeout")).toEqual([]);
  });

  it("finds two sponsors with the corner for the same team, and for the club", () => {
    const s = settings([
      { name: "A", packageId: "platinum", teamIds: ["p12"] },
      { name: "B", packageId: "platinum", teamIds: ["p12", "f14"] },
      { name: "C", packageId: "platinum" },
      { name: "D", packageId: "platinum" },
      { name: "E", packageId: "platinum", active: false },
    ]);
    const corner = exclusiveConflicts(s).filter((c) => c.surface === "corner");
    expect(corner).toEqual([
      { surface: "corner", teamId: "p12", sponsorIds: ["s0", "s1"] },
      { surface: "corner", teamId: null, sponsorIds: ["s2", "s3"] },
    ]);
    // A team's sponsor and the club's are no conflict: the team's goes first.
    expect(exclusiveConflicts(settings([{ packageId: "platinum" }, { packageId: "platinum", teamIds: ["p12"] }]))).toEqual([]);
  });
});

// --- The registry (#126) ---

describe("sponsor registry changes (#126)", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: SponsorRegistry;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new SponsorRegistry(storage, { teams });
  });

  it("creates a sponsor in Guld for the whole club, and changes it", async () => {
    const x = await registry.createSponsor({ name: "  ICA   Maxi " });
    expect(x).toMatchObject({ name: "ICA Maxi", packageId: "gold", teamIds: [], off: [], active: true });
    expect(x.id).toMatch(/^[a-f0-9]{12}$/);

    const changed = await registry.patchSponsor(x.id, {
      url: "https://ica.se/maxi", packageId: "platinum", teamIds: ["p12"], off: ["end", "start", "end"], active: false,
    });
    expect(changed).toMatchObject({ url: "https://ica.se/maxi", packageId: "platinum", teamIds: ["p12"], off: ["start", "end"], active: false });
    expect((await registry.patchSponsor(x.id, { url: "" })).url).toBeUndefined();
    expect((await new SponsorRegistry(storage).readAll()).sponsors[0].packageId).toBe("platinum");
  });

  it("refuses a bad name, a link that is not http, an unknown package, surface or team, and other clubs' teams", async () => {
    const x = await registry.createSponsor({ name: "A" });
    await expect(registry.createSponsor({ name: " " })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor(x.id, { url: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor(x.id, { url: "ftp://ica.se" })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor(x.id, { packageId: "diamond" })).rejects.toMatchObject({ status: 400, message: "Okänt paket." });
    await expect(registry.patchSponsor(x.id, { off: ["halftime"] })).rejects.toMatchObject({ status: 400, message: "Okänd sponsoryta." });
    await expect(registry.patchSponsor(x.id, { teamIds: ["nope"] })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor(x.id, { teamIds: ["aik"] })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor(x.id, { active: "ja" })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchSponsor("aaaaaaaaaaaa", { name: "B" })).rejects.toMatchObject({ status: 404 });
    expect((await registry.getSponsor(x.id))?.name).toBe("A");
  });

  it("counts only released exclusive surfaces as conflicts", async () => {
    // Phase 1 released the corner, the match card and the share image; the
    // shared clips, the MVP and the notification are still to come.
    const released = ["corner", "match-card", "share-image"];
    await registry.createSponsor({ name: "ICA", packageId: "platinum", off: released });
    await expect(registry.createSponsor({ name: "Coop", packageId: "platinum" })).resolves.toBeTruthy();
    const s = await registry.readAll();
    expect(exclusiveConflicts(s, { onlyAvailable: true })).toEqual([]);
    expect(exclusiveConflicts(s).map((c) => c.surface)).toEqual(["shared-clip", "mvp", "notification"]);
  });

  it("refuses a second sponsor on an exclusive surface with 409, and writes nothing", async () => {
    const ica = await registry.createSponsor({ name: "ICA", packageId: "platinum", teamIds: ["p12"] });
    const writes = storage.uploadBuffer.mock.calls.length;
    await expect(registry.createSponsor({ name: "Coop", packageId: "platinum", teamIds: ["p12"] }))
      .rejects.toMatchObject({ status: 409, message: "Älta P12 har redan huvudsponsor: ICA." });
    expect(storage.uploadBuffer.mock.calls.length).toBe(writes);

    const coop = await registry.createSponsor({ name: "Coop", packageId: "platinum", teamIds: ["f14"] });
    await expect(registry.patchSponsor(coop.id, { teamIds: ["f14", "p12"] })).rejects.toMatchObject({ status: 409 });
    await expect(registry.createSponsor({ name: "Banken", packageId: "platinum" })).resolves.toBeTruthy();
    await expect(registry.createSponsor({ name: "Fler", packageId: "platinum" }))
      .rejects.toMatchObject({ status: 409, message: "Klubben har redan huvudsponsor: Banken." });

    // Switching the surface off for one, or making one inactive, makes room.
    const other = await registry.createSponsor({ name: "Bilfirman", packageId: "platinum", teamIds: ["p12"], active: false });
    await expect(registry.patchSponsor(other.id, { active: true })).rejects.toMatchObject({ status: 409 });
    await registry.patchSponsor(ica.id, { off: ["corner", "match-card", "share-image", "shared-clip", "mvp", "notification"] });
    await expect(registry.patchSponsor(other.id, { active: true })).resolves.toMatchObject({ active: true });
  });

  it("removes a sponsor only once it has no clips, and its logo with it", async () => {
    const clip = await registry.create("Reklam", 1000, "video/mp4");
    await expect(registry.removeSponsor(clip.sponsorId)).rejects.toMatchObject({ status: 409 });
    await registry.remove(clip.id);
    storage.files.set(`config/sponsor-logos/${clip.sponsorId}`, { body: "png", type: "image/png" });
    await registry.patchSponsor(clip.sponsorId, { name: "Reklam AB" });
    // Pretend a logo was set, as #128 does.
    const s = await registry.readAll();
    s.sponsors[0].logoType = "image/png";
    storage.files.set(SPONSORS_KEY, { body: JSON.stringify(s), type: "application/json" });
    const fresh = new SponsorRegistry(storage, { teams });
    await fresh.removeSponsor(clip.sponsorId);
    expect(await fresh.getSponsor(clip.sponsorId)).toBeNull();
    expect(storage.files.has(`config/sponsor-logos/${clip.sponsorId}`)).toBe(false);
    await expect(fresh.removeSponsor(clip.sponsorId)).rejects.toMatchObject({ status: 404 });
  });

  it("orders the sponsors, and their clips follow, also in the file v0.8.1 reads", async () => {
    const a = await registry.createSponsor({ name: "A" });
    const b = await registry.createSponsor({ name: "B" });
    const a1 = await registry.create("A1", 1, "video/mp4", a.id);
    const b1 = await registry.create("B1", 1, "video/mp4", b.id);
    const a2 = await registry.create("A2", 1, "video/mp4", a.id);
    for (const c of [a1, b1, a2]) {
      await registry.setSlots(c.id, ["start"]);
      await registry.patch(c.id, { status: "ready" });
    }
    expect((await registry.playlist()).start?.map((c) => c.name)).toEqual(["A1", "A2", "B1"]);

    await registry.reorderSponsors([b.id, a.id]);
    expect((await registry.playlist()).start?.map((c) => c.name)).toEqual(["B1", "A1", "A2"]);
    expect(v081Read(storage.files.get(SPONSORS_KEY)!.body.toString()).playlist.start).toEqual([b1.id, a1.id, a2.id]);

    await expect(registry.reorderSponsors([a.id])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorderSponsors([a.id, a.id])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorderSponsors("x")).rejects.toMatchObject({ status: 400 });

    // The clips' order within a sponsor.
    await registry.reorder([b1.id, a2.id, a1.id]);
    expect((await registry.playlist()).start?.map((c) => c.name)).toEqual(["B1", "A2", "A1"]);
  });

  it("moves a clip to another sponsor, last of its clips", async () => {
    const a = await registry.createSponsor({ name: "A" });
    const b = await registry.createSponsor({ name: "B" });
    const a1 = await registry.create("A1", 1, "video/mp4", a.id);
    const b1 = await registry.create("B1", 1, "video/mp4", b.id);
    const moved = await registry.setClipSponsor(a1.id, b.id);
    expect(moved.sponsorId).toBe(b.id);
    expect((await registry.read()).clips.map((c) => c.id)).toEqual([b1.id, a1.id]);
    await expect(registry.setClipSponsor(a1.id, "aaaaaaaaaaaa")).rejects.toMatchObject({ status: 404 });
    await expect(registry.setClipSponsor("aaaaaaaaaaaa", a.id)).rejects.toMatchObject({ status: 404 });
    await expect(registry.create("X", 1, "video/mp4", "aaaaaaaaaaaa")).rejects.toMatchObject({ status: 404 });
  });

  it("gives an upload without a sponsor a sponsor of its own, named after the clip", async () => {
    const clip = await registry.create("Bageriet", 1, "video/mp4");
    expect(await registry.getSponsor(clip.sponsorId)).toMatchObject({ name: "Bageriet", packageId: "gold", teamIds: [] });
  });

  it("switches surfaces on and off, but not those of later phases", async () => {
    expect((await registry.setSurfaces({ p1: false })).p1).toBe(false);
    expect((await registry.readAll()).surfaces.start).toBe(true);
    await expect(registry.setSurfaces({ mvp: true })).rejects.toMatchObject({ status: 400 });
    // Phase 1's surfaces can be switched on, and start off.
    expect((await registry.readAll()).surfaces).toMatchObject({ corner: false, waiting: false, "match-card": false, "club-footer": false, "share-image": false });
    expect((await registry.setSurfaces({ corner: true })).corner).toBe(true);
    await expect(registry.setSurfaces({ timeout: true })).rejects.toMatchObject({ status: 400, message: "Okänd sponsoryta." });
    await expect(registry.setSurfaces({ start: "on" })).rejects.toMatchObject({ status: 400 });
    // Switching one off that is off already is fine.
    await expect(registry.setSurfaces({ mvp: false })).resolves.toMatchObject({ mvp: false });
  });

  it("sets and clears the season start", async () => {
    expect(await registry.setSeasonStart("2026-08-15")).toBe("2026-08-15");
    expect((await new SponsorRegistry(storage).readAll()).seasonStart).toBe("2026-08-15");
    await expect(registry.setSeasonStart("15/8")).rejects.toMatchObject({ status: 400 });
    await expect(registry.setSeasonStart("2026-13-01")).rejects.toMatchObject({ status: 400 });
    expect(await registry.setSeasonStart(null)).toBeNull();
    expect((await registry.readAll()).seasonStart).toBeUndefined();
  });
});

// --- Packages (#154) ---

describe("packages (#154)", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: SponsorRegistry;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new SponsorRegistry(storage, { teams });
  });

  it("creates a package last in the order, renames it and changes its surfaces", async () => {
    const brons = await registry.createPackage({ name: " Brons ", surfaces: ["club-footer", "start", "club-footer"] });
    expect(brons).toMatchObject({ name: "Brons", priority: 4, surfaces: ["start", "club-footer"] });
    expect(brons.id).toMatch(/^[a-f0-9]{12}$/);
    const changed = await registry.patchPackage(brons.id, { name: "Brons+", surfaces: ["club-footer", "waiting"] });
    expect(changed).toMatchObject({ name: "Brons+", surfaces: ["waiting", "club-footer"] });
    const s = await new SponsorRegistry(storage).readAll();
    expect(s.packages.map((p) => p.name)).toEqual(["Platinum", "Guld", "Silver", "Brons+"]);
  });

  it("refuses a bad name, a name taken, an unknown surface and an unknown package", async () => {
    await expect(registry.createPackage({ name: "" })).rejects.toMatchObject({ status: 400 });
    await expect(registry.createPackage({ name: "x".repeat(41) })).rejects.toMatchObject({ status: 400 });
    await expect(registry.createPackage({ name: "guld" })).rejects.toMatchObject({ status: 409, message: "Det finns redan ett paket som heter guld." });
    await expect(registry.createPackage({ name: "Brons", surfaces: ["halftime"] })).rejects.toMatchObject({ status: 400 });
    await expect(registry.createPackage({ name: "Brons", surfaces: "club-footer" })).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchPackage("gold", {})).rejects.toMatchObject({ status: 400 });
    await expect(registry.patchPackage("nope", { name: "X" })).rejects.toMatchObject({ status: 404 });
    // Renaming to its own name in another case is fine.
    await expect(registry.patchPackage("gold", { name: "GULD" })).resolves.toMatchObject({ name: "GULD" });
  });

  it("refuses the corner in Guld when two Guld sponsors share a team, with every conflict, and writes nothing", async () => {
    await registry.createSponsor({ name: "ICA", packageId: "gold", teamIds: ["p12"] });
    await registry.createSponsor({ name: "Coop", packageId: "gold", teamIds: ["p12", "f14"] });
    const gold = (await registry.readAll()).packages.find((p) => p.id === "gold")!;
    const writes = storage.uploadBuffer.mock.calls.length;

    const err = await registry.patchPackage("gold", { surfaces: [...gold.surfaces, "corner", "match-card"] }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: "Guld kan inte få hörnlogga: Älta P12 skulle få flera, ICA och Coop. Bara en per lag går." });
    expect(err.details.conflicts).toEqual([
      { surface: "corner", label: "Hörnlogga", teamId: "p12", teamName: "Älta P12", sponsors: [{ id: expect.any(String), name: "ICA" }, { id: expect.any(String), name: "Coop" }] },
      { surface: "match-card", label: "Matchkortet", teamId: "p12", teamName: "Älta P12", sponsors: [{ id: expect.any(String), name: "ICA" }, { id: expect.any(String), name: "Coop" }] },
    ]);
    expect(storage.uploadBuffer.mock.calls.length).toBe(writes);
    expect((await registry.readAll()).packages.find((p) => p.id === "gold")!.surfaces).not.toContain("corner");

    // A non-exclusive surface is fine, and so is the corner in a package with one sponsor per team.
    await expect(registry.patchPackage("gold", { surfaces: [...gold.surfaces, "club-footer", "waiting"] })).resolves.toBeTruthy();
    await expect(registry.patchPackage("silver", { surfaces: ["club-footer", "corner"] })).resolves.toBeTruthy();
  });

  it("orders the packages, and the order decides who goes first (#125)", async () => {
    const s0 = await registry.readAll();
    const club = (name: string, packageId: string) => registry.createSponsor({ name, packageId });
    await club("Guldet", "gold");
    await club("Silvret", "silver");
    await registry.setSurfaces({ "club-footer": true, corner: true });
    await registry.patchPackage("silver", { surfaces: ["club-footer"] });
    const names = async (surface: string) => sponsorsFor(await registry.readAll(), null, surface).map((p) => p.sponsor.name);
    expect(await names("club-footer")).toEqual(["Guldet", "Silvret"]);

    const ordered = await registry.reorderPackages(["silver", "gold", "platinum"]);
    expect(ordered.map((p) => [p.id, p.priority])).toEqual([["silver", 1], ["gold", 2], ["platinum", 3]]);
    expect(await names("club-footer")).toEqual(["Silvret", "Guldet"]);
    expect((await new SponsorRegistry(storage).readAll()).packages.map((p) => p.id)).toEqual(["silver", "gold", "platinum"]);

    await expect(registry.reorderPackages(["silver", "gold"])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorderPackages(["silver", "gold", "gold"])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorderPackages("silver")).rejects.toMatchObject({ status: 400 });
    expect(s0.packages.map((p) => p.priority)).toEqual([1, 2, 3]);
  });

  it("removes a package only once no sponsor has it, and never the last one", async () => {
    const x = await registry.createSponsor({ name: "ICA", packageId: "silver" });
    await expect(registry.removePackage("silver")).rejects.toMatchObject({
      status: 409, message: "Silver har en sponsor. Flytta den till ett annat paket först.", details: { sponsors: [{ id: x.id, name: "ICA" }] },
    });
    await registry.patchSponsor(x.id, { packageId: "gold" });
    await registry.removePackage("silver");
    // Stays removed on the next read: the defaults are not put back.
    expect((await new SponsorRegistry(storage).readAll()).packages.map((p) => p.id)).toEqual(["platinum", "gold"]);
    await expect(registry.removePackage("silver")).rejects.toMatchObject({ status: 404 });

    await registry.removePackage("platinum");
    await expect(registry.removePackage("gold")).rejects.toMatchObject({ status: 409 });
  });

  it("puts new sponsors in the last package once Guld is gone", async () => {
    const brons = await registry.createPackage({ name: "Brons", surfaces: ["club-footer"] });
    await registry.removePackage("gold");
    expect((await registry.createSponsor({ name: "ICA" })).packageId).toBe(brons.id);
    const clip = await registry.create("Reklam", 1000, "video/mp4");
    expect((await registry.getSponsor(clip.sponsorId))?.packageId).toBe(brons.id);
  });

  it("gives a file without packages the three defaults", () => {
    expect(migrate({}).packages).toEqual(DEFAULT_PACKAGES);
    expect(migrate({ packages: [] }).packages.map((p) => p.id)).toEqual(["platinum", "gold", "silver"]);
  });
});
