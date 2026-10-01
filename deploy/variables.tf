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

variable "custom_domain" {
  type        = string
  default     = null
  description = "Your own domain for the site. Leave null to use <club_name>-live.pages.osaas.io."
}

variable "api_git_url" {
  type        = string
  description = "HTTPS URL of the backend repository."
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
  description = "Branch or tag to deploy. Defaults to the repository's default branch."
}

# Leave these empty and they are generated. Set them only when migrating an
# installation that already has credentials in use.
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
