# Deploying Shift Board (No-Login Version) to Azure

This is the simplified deployment guide for `shift-board-no-auth` — the
version with no Keycloak, no login page, and Sprout credentials entered
through an in-app "Sprout settings" panel instead of a login system.

**This is meant for whoever has Azure access — not something the CSM
needs to run.** Once this is deployed, using the dashboard afterward is
just opening a URL and typing in credentials — nothing to install.

**Before deploying:** re-read the "What this means, plainly" section in
this repo's `README.md`. This version has **no access control** — anyone
who has the URL can view attendance data and change the Sprout
credentials being used. Confirm that's genuinely acceptable for this
deployment before going further (e.g. behind a private network, or an
access gate elsewhere like sproutmarkup.com's own login).

## Architecture

Much simpler than the Keycloak version — one container, no database:

```
Browser ───HTTPS───▶  Container App: shift-board
                       (Express: serves index.html,
                        /api/shift-board, /api/settings —
                        all open, no auth)
                              │
                              │ server-to-server (no CORS issue)
                              ▼
                       Sprout HR API
```

## Step 1 — Resource group and container registry

```bash
az group create --name shift-board-rg --location southeastasia

az acr create --resource-group shift-board-rg \
  --name shiftboardacr --sku Basic
```

## Step 2 — Build and push the image

```bash
az acr login --name shiftboardacr

docker build -t shiftboardacr.azurecr.io/shift-board-no-auth:latest .
docker push shiftboardacr.azurecr.io/shift-board-no-auth:latest
```

## Step 3 — Container Apps environment

```bash
az extension add --name containerapp --upgrade

az containerapp env create \
  --name shift-board-env \
  --resource-group shift-board-rg \
  --location southeastasia
```

## Step 4 — Persistent storage for saved settings

**This step matters — don't skip it.** Credentials saved through the
"Sprout settings" panel live in a file at `/app/data/sprout-config.json`
inside the container. Without persistent storage attached, that file is
lost every time the container restarts or redeploys, and whoever's using
the dashboard would have to re-enter credentials repeatedly.

```bash
az storage account create \
  --resource-group shift-board-rg \
  --name shiftboardstorage \
  --sku Standard_LRS

az storage share-rm create \
  --resource-group shift-board-rg \
  --storage-account shiftboardstorage \
  --name shift-board-data \
  --quota 1

STORAGE_KEY=$(az storage account keys list \
  --resource-group shift-board-rg \
  --account-name shiftboardstorage \
  --query "[0].value" -o tsv)

az containerapp env storage set \
  --resource-group shift-board-rg \
  --name shift-board-env \
  --storage-name shift-board-data \
  --azure-file-account-name shiftboardstorage \
  --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name shift-board-data \
  --access-mode ReadWrite
```

## Step 5 — Deploy the app

```bash
az containerapp create \
  --name shift-board \
  --resource-group shift-board-rg \
  --environment shift-board-env \
  --image shiftboardacr.azurecr.io/shift-board-no-auth:latest \
  --target-port 3000 \
  --ingress external \
  --min-replicas 0 --max-replicas 2 \
  --registry-server shiftboardacr.azurecr.io
```

**Notice there are no `SPROUT_*` environment variables here at all** —
that's intentional — but as of this update, it's now a **choice**, not
the only option. See below.

**Recommended for this deployment — bake in the Sprout credentials here,
since this build is for one specific client.** Add all four alongside
`SPROUT_BASE` in the same `--env-vars` flag:
```
--env-vars SPROUT_BASE=<real production URL> SPROUT_CLIENT_ID=<...> SPROUT_CLIENT_SECRET=<...> SPROUT_SUBSCRIPTION_KEY=<...> SPROUT_USER_ID=<...>
```
When all four are set this way, the app detects it at startup and
**automatically hides the Credentials panel from the dashboard entirely**
— the person using it never sees a settings screen, never has to enter
anything, and can't accidentally (or otherwise) overwrite these values
later, since the save endpoint itself refuses changes once locked. This
is the safer default for a single-client build like this one.

If you only set some of the four (or none), the dashboard falls back to
its original behavior — the Credentials panel stays visible and editable
after deployment, same as before. This is only worth doing if you
genuinely expect these values to need changing without a redeploy.

**⚠️ CRITICAL — `SPROUT_BASE` defaults to the SANDBOX environment
(`gateway-sb.sprout.ph`) if not explicitly set.** This is the one thing
in this whole deployment that fails *silently* if missed — the app will
run perfectly, load data, show no errors, and everyone will assume it's
working... while quietly showing sandbox/test data instead of real
production attendance. No crash, no red banner, nothing that flags it.

For a real production deployment, explicitly add the real production
`SPROUT_BASE` value as an environment variable in this `az containerapp
create` command. This value is intentionally NOT editable from the
dashboard's Credentials panel even when that panel is visible — see
`README.md`'s "Setting Sprout credentials" section for why — so it can
only be set here, at deployment time, by whoever's running this command.

**`--min-replicas 0` — cost-saving setting.** This lets the container
scale down to zero (and stop being billed) when nobody's using it, and
start back up automatically in a few seconds when someone opens the URL.
Good fit for a low-traffic internal tool. The tradeoff: whoever opens
the dashboard after a period of no use will see a few seconds' delay on
that first load while it spins back up — not an error, just a brief
wait. If this dashboard needs to feel instant every time (e.g. checked
constantly throughout the day), change this back to `--min-replicas 1`,
which keeps it always-on but costs more.

## Step 6 — Mount the storage to the container

The Container App needs to know to actually use the storage from Step 4
at the path the app expects (`/app/data`).

**Flagging this clearly: the exact YAML structure below has not been
tested against a live Azure deployment in this session** (same honesty
standard as the rest of this repo — see the caveats already in
`README.md` and `sprout.js`). The general approach (add a `volumes`
entry, add a matching `volumeMounts` entry on the container) is correct
per Azure's documented pattern, but exact field names can shift between
API versions. If `az containerapp update --yaml` rejects this file,
check the error message against the current `az containerapp` docs for
the volume/volumeMounts schema, and adjust field names accordingly —
don't assume the deployment is broken, it may just need small syntax
fixes.

```bash
az containerapp show --name shift-board --resource-group shift-board-rg \
  -o yaml > shift-board-config.yaml
```

Open `shift-board-config.yaml`, and under `properties.template`, add:

```yaml
volumes:
  - name: data-volume
    storageType: AzureFile
    storageName: shift-board-data
containers:
  - name: shift-board
    # ... existing config stays ...
    volumeMounts:
      - volumeName: data-volume
        mountPath: /app/data
```

Then apply it:

```bash
az containerapp update \
  --name shift-board \
  --resource-group shift-board-rg \
  --yaml shift-board-config.yaml
```

## Step 7 — Custom domain (optional but recommended)

```bash
az containerapp hostname add \
  --hostname shiftboard.yourcompany.com \
  --name shift-board \
  --resource-group shift-board-rg
```

Follow the CNAME/TXT instructions Azure gives you, then bind a managed
certificate (Container App → Custom domains → Add certificate).

## Once it's live

1. Open the Container App's URL (or your custom domain)
2. Click **"Sprout settings"** in the toolbar
3. Enter the real Sprout credentials, click **Save Settings**
4. Paste the same URL + `/api/shift-board` into the "Shift Board API
   URL" box and click **Save & Connect**

From here on, using it is just opening that URL — nothing to install,
same as any other website.

## What to actually test before calling this "done"

- [ ] The Container App URL loads the dashboard (not a blank page or
      Azure's default "container starting" placeholder)
- [ ] `/health` responds with `{"ok":true,...}`
- [ ] "Sprout settings" loads status without a "Failed to fetch" error
      (confirms the frontend can actually reach the backend, not just
      that the container is running)
- [ ] Saving credentials through the panel succeeds
- [ ] The dashboard then actually loads live attendance data — this
      confirms the server can reach Sprout's API from Azure (server-to-
      server, so CORS doesn't apply here, but network/firewall rules
      inside Azure could still block it — worth confirming directly)
- [ ] **Confirm `SPROUT_BASE` is actually pointed at production**, not
      the sandbox default. Check a few real, known employees on the
      dashboard and confirm their attendance matches what you'd expect
      from actual records — don't just check that *some* data loads,
      since sandbox data loads too and looks equally plausible at a
      glance
- [ ] **Restart the container app** (`az containerapp revision restart`)
      and confirm the saved Sprout credentials are still there afterward
      — this is the real test that Step 4/6's persistent storage is
      actually working, not just that saving worked once
- [ ] Confirm with whoever owns this deployment that the "anyone with
      the URL has full access" tradeoff is genuinely acceptable here —
      this isn't a technical test, it's a decision that needs to be
      made deliberately, not assumed
