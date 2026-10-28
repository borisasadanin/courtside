variable "osc_pat" {
  type        = string
  sensitive   = true
  description = "OSC Personal Access Token. The backend also uses it to start Restreamer on demand."
}

variable "osc_environment" {
  type        = string
  default     = "prod"
  description = "OSC environment: prod or prod-se."
}

variable "club_name" {
  type        = string
  description = "Short identifier used to name the resources. Lowercase letters and digits only."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,20}$", var.club_name))
    error_message = "club_name must be 3-21 lowercase letters and digits, starting with a letter."
  }
}

variable "club_display_name" {
  type        = string
  description = "What the website calls itself, e.g. \"Hammarby Courtside\"."
}

variable "club_short_name" {
  type        = string
  default     = ""
  description = "Default home team on new recordings. Defaults to the display name."
}

variable "club_venue" {
  type        = string
  default     = ""
  description = "Default venue, e.g. \"Hammarbyhallen\"."
}

variable "club_accent_color" {
  type        = string
  default     = "#C8A43F"
  description = "Accent colour applied by the website at runtime."
}

variable "site_hostname" {
  type        = string
  default     = null
  description = "A name of the club's own, without https://, e.g. \"myclub.apps.osaas.io\" or \"live.myclub.se\". Needs the PROFESSIONAL plan. Leave null to use the app's generated address."
}

variable "api_git_url" {
  type        = string
  description = "HTTPS URL of the Courtside repository. It is built from its root: backend and website together."
}

variable "api_git_token" {
  type        = string
  default     = null
  sensitive   = true
  description = "Access token, for a private backend repository. Omit for a public one."
}

variable "api_git_ref" {
  type        = string
  default     = null
  description = "Release tag to deploy, e.g. \"v0.2.0\". Upgrading is changing it and applying again. Leave unset only to follow the default branch, which gets every push."
}

# Leave api_key empty and it is generated.  Leave the PINs empty and the club
# chooses them at first visit, with the setup code.  Set them only when
# migrating an installation whose PINs are already in use.
variable "api_key" {
  type      = string
  default   = null
  sensitive = true
}

variable "admin_pin" {
  type      = string
  default   = null
  sensitive = true
}

variable "viewer_pin" {
  type      = string
  default   = null
  sensitive = true
}
