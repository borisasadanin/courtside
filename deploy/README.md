# Deploy

Raises one club's whole installation on Eyevinn Open Source Cloud: object
storage, the configuration store, the backend and the website.

Works with OpenTofu or Terraform (>= 1.6).

## What it creates

| | |
|---|---|
| `osc_instance.storage` | MinIO — recordings, clips, indexes |
| `osc_parameter_store` + `osc_parameter` | Configuration, including generated secrets |
| `osc_my_app.api` | The backend, built from your repository |
| `osc_my_page.site` | The website |

**Restreamer is not created here.** The backend starts it when someone begins
broadcasting and shuts it down an hour after the last stream. It costs roughly
ten times everything else combined, so leaving its lifecycle to the backend is
what makes an installation affordable — see [../docs/cost.md](../docs/cost.md).

## Running it

```bash
cp terraform.tfvars.example terraform.tfvars   # fill in
tofu init
tofu plan
tofu apply
```

Leave `api_key`, `admin_pin` and `viewer_pin` unset and they are generated, so
no installation starts life with a credential someone else has seen. Read them
back with:

```bash
tofu output -raw admin_pin
tofu output -raw viewer_pin
```

## After apply

Terraform creates the site but does not publish its files — that is a separate
step, deliberately, so a rebuild of the website is not a Terraform run:

```bash
cd ../web
# point the site at the backend printed by `tofu output api_url`
$EDITOR runtime-config.js
npm run build
osc web publish <club_name>-live dist --sync
```

Then check the installation and pair a camera:

```bash
cd ../api && npm run preflight
```

`tofu output next_steps` prints the same list with your own values filled in.

## Tearing it down

```bash
tofu destroy
```

This deletes the storage instance **and every recording in it**, the
configuration store, the backend and the website. There is no undo.

## Notes

- The backend repository must have the API at its root. A monorepo would need
  `sub_path`, and the platform does not inject the parameter store into an app
  that uses one — the app would have to fetch its own configuration from
  `APP_CONFIG_URL` instead.
- Endpoints are read from the resources, not constructed from names. OSC places
  instances in a region that is not always the environment name.
