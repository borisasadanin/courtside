// Every text table on the site, one per area. t("area.key") looks up the
// area here; see modules/i18n.js.

import common from "./common.js";
import page from "./page.js";
import admin from "./admin.js";
import auth from "./auth.js";
import branding from "./branding.js";
import devices from "./devices.js";
import matchAdmin from "./match-admin.js";
import matchCard from "./match-card.js";
import matches from "./matches.js";
import pins from "./pins.js";
import player from "./player.js";
import privacy from "./privacy.js";
import replayMarkers from "./replay-markers.js";
import setup from "./setup.js";
import streams from "./streams.js";
import teamAdmin from "./team-admin.js";
import teardown from "./teardown.js";
import update from "./update.js";
import vod from "./vod.js";
import clip from "./clip.js";

export default {
  common,
  page,
  admin,
  auth,
  branding,
  devices,
  "match-admin": matchAdmin,
  "match-card": matchCard,
  matches,
  pins,
  player,
  privacy,
  "replay-markers": replayMarkers,
  setup,
  streams,
  "team-admin": teamAdmin,
  teardown,
  update,
  vod,
  clip,
};
