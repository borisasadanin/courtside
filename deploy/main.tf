#############################################
# Courtside — one club's whole installation
#
# Creates the storage, the configuration store and the app for a single club.
# The app is the backend and the website together, on one address. Run it against your own OSC tenant and you have a working
# system; nothing here is specific to whoever wrote it.
#
# Restreamer is deliberately NOT created here. The backend starts it when
# someone begins broadcasting and shuts it down an hour after the last stream,
# and it costs roughly ten times everything else combined — leaving its
# lifecycle to the backend is what makes this affordable to run.
#############################################

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    osc = {
      source  = "registry.terraform.io/EyevinnOSC/osc"
      version = "~> 1.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "osc" {
  pat         = var.osc_pat
  environment = var.osc_environment
}

#############################################
# Generated secrets
#
# Left empty by the operator and generated here, so no installation starts life
# with a credential someone else has seen.
#############################################

resource "random_password" "api_key" {
  length  = 48
  special = false
}

# One-time code for first-run setup, where the club chooses its own PINs.
# Letters and digits only, read aloud easily: no lower case, no specials.
resource "random_string" "setup_code" {
  length  = 8
  lower   = false
  special = false
}

resource "random_password" "storage_password" {
  length  = 32
  special = false
}

locals {
  api_key = coalesce(var.api_key, random_password.api_key.result)
  # PINs given here (migrating an existing installation) skip setup.  Otherwise
  # the club chooses them at first visit, with the setup code.
  preset_pins = nonsensitive(var.admin_pin != null)
  setup_code  = "${substr(random_string.setup_code.result, 0, 4)}-${substr(random_string.setup_code.result, 4, 4)}"

  storage_name = "${var.club_name}storage"
  store_name   = "${var.club_name}config"
  app_name     = "${var.club_name}api"
  # Read the endpoint from the instance rather than constructing it. OSC places
  # instances in a region that is not always the environment name — building the
  # hostname by hand pointed the backend at a host that did not exist.
  storage_endpoint = osc_instance.storage.instance["url"]
  site_hostname    = coalesce(var.site_hostname, "${var.club_name}.apps.osaas.io")
  site_url         = "https://${local.site_hostname}"
}

data "osc_workspace" "this" {}

#############################################
# Object storage — recordings, clips, indexes
#############################################

resource "osc_instance" "storage" {
  service_id = "minio-minio"
  name       = local.storage_name

  parameters = {
    RootUser = "root"
  }

  # The service marks this sensitive; keeping it here puts it in plan output.
  sensitive_parameters = {
    RootPassword = random_password.storage_password.result
  }
}

#############################################
# Configuration
#
# Every value here reaches the backend as an environment variable. Secrets are
# encrypted at rest and only the bound app can read them back.
#############################################

resource "osc_parameter_store" "config" {
  name           = local.store_name
  enable_secrets = true
}

resource "osc_parameter" "api_key" {
  parameter_store = osc_parameter_store.config.name
  key             = "API_KEY"
  secret_value    = local.api_key
}

resource "osc_parameter" "setup_code" {
  count           = local.preset_pins ? 0 : 1
  parameter_store = osc_parameter_store.config.name
  key             = "SETUP_CODE"
  secret_value    = local.setup_code
}

resource "osc_parameter" "admin_pin" {
  count           = local.preset_pins ? 1 : 0
  parameter_store = osc_parameter_store.config.name
  key             = "ADMIN_PIN"
  secret_value    = var.admin_pin
}

resource "osc_parameter" "viewer_pin" {
  count           = local.preset_pins && nonsensitive(var.viewer_pin != null) ? 1 : 0
  parameter_store = osc_parameter_store.config.name
  key             = "VIEWER_PIN"
  secret_value    = var.viewer_pin
}

resource "osc_parameter" "osc_token" {
  parameter_store = osc_parameter_store.config.name
  key             = "OSC_ACCESS_TOKEN"
  secret_value    = var.osc_pat
}

resource "osc_parameter" "storage_secret" {
  parameter_store = osc_parameter_store.config.name
  key             = "MINIO_SECRET_KEY"
  secret_value    = random_password.storage_password.result
}

resource "osc_parameter" "plain" {
  for_each = {
    OSC_TENANT        = data.osc_workspace.this.id
    OSC_REGION        = var.osc_environment
    OSC_INSTANCE_NAME = "${var.club_name}restreamer"
    PROCESS_PREFIX    = "${var.club_name}-"
    MINIO_ENDPOINT    = local.storage_endpoint
    MINIO_ACCESS_KEY  = "root"
    STORAGE_BUCKET    = "recordings"
    PUBLIC_SITE_URL   = local.site_url
    CLUB_NAME         = var.club_display_name
    CLUB_SHORT_NAME   = var.club_short_name
    CLUB_VENUE        = var.club_venue
    CLUB_ACCENT_COLOR = var.club_accent_color
  }

  parameter_store = osc_parameter_store.config.name
  key             = each.key
  value           = each.value
}

#############################################
# Backend
#############################################

resource "osc_my_app" "api" {
  name           = local.app_name
  type           = "nodejs"
  git_url        = var.api_git_url
  git_token      = var.api_git_token
  source_ref     = var.api_git_ref
  config_service = osc_parameter_store.config.name
  wait_for_ready = true

  # Rebuild when configuration changes, so a new value actually reaches the app.
  rebuild_trigger = sha256(jsonencode({
    club    = var.club_display_name
    storage = local.storage_endpoint
    site    = local.site_url
  }))

  depends_on = [
    osc_instance.storage,
    osc_parameter.plain,
    osc_parameter.api_key,
    osc_parameter.setup_code,
    osc_parameter.admin_pin,
    osc_parameter.viewer_pin,
    osc_parameter.osc_token,
    osc_parameter.storage_secret,
  ]
}

#############################################
# Address
#
# The app also has a generated <hash>.apps.osaas.io name; this is the one the
# club hands out.  A name under apps.osaas.io needs no DNS.  Your own domain
# needs a CNAME to the app's managed_domain first.
#############################################

resource "osc_domain" "site" {
  domain        = local.site_hostname
  service_id    = osc_my_app.api.domain_service_id
  instance_name = osc_my_app.api.id
}
