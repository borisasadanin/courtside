# Deploy

Raises one club's whole installation on Eyevinn Open Source Cloud: object
storage, the configuration store, and one app that is both the backend and the
website — on one address, `<club_name>.apps.osaas.io` unless you choose another.

Works with OpenTofu or Terraform (>= 1.6).

## What it creates

| | |
|---|---|
| `osc_instance.storage` | MinIO — recordings, clips, indexes |
| `osc_parameter_store` + `osc_parameter` | Configuration, including generated secrets |
| `osc_my_app.api` | Backend and website, built from the repository root |
| `osc_domain.site` | The club's address |

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

Leave `api_key` unset and it is generated, so no installation starts life
with a credential someone else has seen. Leave `admin_pin` and `viewer_pin`
unset too: the club chooses them at its first visit, using a one-time setup
code:

```bash
tofu output -raw setup_code
```

Until setup is done there is no admin PIN at all, so a fresh installation is
never open. Forgot the admin PIN? Set a new `SETUP_CODE` in the parameter store
and restart the app — setup opens again, and the old PINs stop working.

## After apply

The website is built together with the backend and served from the same
address, so there is nothing to publish and no backend URL to configure.
Open the address, enter the setup code, choose the PINs, and you land in the
admin view ready to pair a camera. To check the installation from a terminal:

```bash
cd ../api && npm run preflight
```

`tofu output next_steps` prints the same list with your own values filled in.

## Tearing it down

```bash
tofu destroy
```

This deletes the storage instance **and every recording in it**, the
configuration store, the app and its address. There is no undo.

## Notes

- The app is built from the repository root: the root `package.json` builds
  `web/` and `api/` and starts the API, which serves the website. Do not use
  `sub_path` — the platform does not inject the parameter store into an app
  that has one.
- Endpoints are read from the resources, not constructed from names. OSC places
  instances in a region that is not always the environment name.
