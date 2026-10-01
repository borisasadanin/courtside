output "api_url" {
  value       = osc_my_app.api.url
  description = "Backend URL. The website's runtime-config.js points here."
}

output "site_url" {
  value       = local.site_url
  description = "Where viewers go, once the files are published."
}

output "storage_endpoint" {
  value       = local.storage_endpoint
  description = "Object storage endpoint holding recordings and clips."
}

output "admin_pin" {
  value       = local.admin_pin
  sensitive   = true
  description = "Admin PIN. Read it with: tofu output -raw admin_pin"
}

output "viewer_pin" {
  value       = local.viewer_pin
  sensitive   = true
  description = "Viewer PIN. Read it with: tofu output -raw viewer_pin"
}

output "next_steps" {
  value = <<-EOT
    1. Publish the website:  cd ../web && npm run build && osc web publish ${local.page_name} dist --sync
    2. Point the site at the backend: set apiUrl in dist/runtime-config.js to ${osc_my_app.api.url}
    3. Check the installation:  cd ../api && npm run preflight
    4. Pair a camera: open ${local.site_url}, enter the admin PIN, choose "Lägg till kamera"
  EOT
}
