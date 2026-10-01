output "api_url" {
  value       = osc_my_app.api.url
  description = "The app's generated address. Same app as site_url; use site_url."
}

output "site_url" {
  value       = local.site_url
  description = "The club's address: website, admin view and API."
}

output "storage_endpoint" {
  value       = local.storage_endpoint
  description = "Object storage endpoint holding recordings and clips."
}

output "setup_code" {
  value       = local.preset_pins ? null : local.setup_code
  sensitive   = true
  description = "One-time code for first-run setup. Read it with: tofu output -raw setup_code"
}

output "next_steps" {
  value = <<-EOT
    1. Open ${local.site_url}
    2. Enter the setup code (tofu output -raw setup_code) and choose the club's PINs
    3. You land in the admin view: choose "Lägg till kamera" and scan the code with the camera app
  EOT
}
