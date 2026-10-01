#############################################
# Courtside — one club's whole installation
#
# Creates the storage, the configuration store, the backend and the website for
# a single club. Run it against your own OSC tenant and you have a working
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

resource "random_integer" "admin_pin" {
  min = 100000
  max = 999999
}

resource "random_integer" "viewer_pin" {
  min = 100000
  max = 999999
}

resource "random_password" "storage_password" {
  length  = 32
  special = false
}

locals {
  api_key    = coalesce(var.api_key, random_password.api_key.result)
  admin_pin  = coalesce(var.admin_pin, tostring(random_integer.admin_pin.result))
  viewer_pin = coalesce(var.viewer_pin, tostring(random_integer.viewer_pin.result))

  storage_name = "${var.club_name}storage"
  store_name   = "${var.club_name}config"
  app_name     = "${var.club_name}api"
  page_name    = "${var.club_name}-live"
  # Read the endpoint from the instance rather than constructing it. OSC places
  # instances in a region that is not always the environment name — building the
  # hostname by hand pointed the backend at a host that did not exist.
  storage_endpoint = osc_instance.storage.instance["url"]
  site_url         = coalesce(var.custom_domain, "https://${local.page_name}.pages.osaas.io")
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

resource "osc_parameter" "admin_pin" {
  parameter_store = osc_parameter_store.config.name
  key             = "ADMIN_PIN"
  secret_value    = local.admin_pin
}

resource "osc_parameter" "viewer_pin" {
  parameter_store = osc_parameter_store.config.name
  key             = "VIEWER_PIN"
  secret_value    = local.viewer_pin
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
    osc_parameter.admin_pin,
    osc_parameter.viewer_pin,
    osc_parameter.osc_token,
    osc_parameter.storage_secret,
  ]
}

#############################################
# Website
#
# Terraform creates the site; the files are published separately (osc web
# publish, or the My Page API). A new site serves nothing until that happens.
#############################################

resource "osc_my_page" "site" {
  name          = local.page_name
  custom_domain = var.custom_domain
}
