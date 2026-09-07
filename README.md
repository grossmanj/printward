# Printward

Printward is a central internal web app for tracking and printing order document packets from Google Cloud Storage.

It groups PDFs by order number:

- `orderX.pdf`: packing slip
- `partiX.pdf`: packing slip attachment
- `palletX.pdf`: pallet document
- `freightX.pdf`: freight document

The app shows whether each current document version has been printed. If a PDF is updated in the bucket after printing, it returns to a reprint-needed state.

For development and agent continuity, start with [AGENTS.md](AGENTS.md) and the
[agent handoff](docs/agent-handoff.md). The handoff records current business rules,
architecture, test coverage, and operational details that must survive between tasks.

## Why there is a local print agent

Browsers do not provide a reliable API for selecting a locally installed printer, silently printing, or enabling printer finishing features such as stapling. Printward therefore has two parts:

- Central web app: bucket overview, print history, user defaults, print jobs.
- Local print agent: runs on each user's computer and sends order packets to the locally installed printer.

Without the local agent, users can still open PDFs from the web app and manually mark them printed.

## Run locally

Use Node.js 20 or newer and install the locked dependencies first. The app starts
in mock mode if `GCS_BUCKET` is not set.

```sh
npm ci
npm run dev
```

Open:

```text
http://127.0.0.1:3100
```

In another terminal, start the local print agent:

```sh
npm run agent
```

The agent listens on:

```text
http://127.0.0.1:37951
```

On Windows, users can click **Install print agent** in Printward Settings to download the installer script. Run it from PowerShell on the same PC that has the printer installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-print-agent.ps1
```

Then verify the browser on that same PC can reach:

```text
http://127.0.0.1:37951/health
```

If Printward still says the agent is unavailable, open Settings and confirm the Local agent URL is exactly `http://127.0.0.1:37951`. The URL is intentionally local: it points to the user's own PC, not the Cloud Run service.

## Configure Google Cloud Storage

The current Nordward PDF service writes order PDFs under one bucket with company/environment prefixes:

- Demo: `gs://pdf-service-bucket/9992/`
- Production: `gs://pdf-service-bucket/2/`

Configure these as bucket plus prefix, not as separate bucket names:

```sh
GCS_BUCKET=pdf-service-bucket GCS_PREFIX=9992/ npm start
```

Production uses the same bucket with:

```sh
GCS_BUCKET=pdf-service-bucket GCS_PREFIX=2/ npm start
```

Freight sync writes to a separate prefix described below. Until `FREIGHT_GCS_BUCKET` is configured, live mode treats only packing slips and packing slip attachments as required/visible documents.

For Cloud Run or another Google-hosted runtime with a service account:

```sh
GCS_BUCKET=pdf-service-bucket GCS_PREFIX=9992/ npm start
```

For local testing with an access token:

```sh
GCS_BUCKET=pdf-service-bucket GCS_PREFIX=9992/ GCS_ACCESS_TOKEN="$(gcloud auth print-access-token)" npm start
```

Optional variables:

```text
PORT=3100
GCS_PREFIX=9992/
DATA_FILE=/path/to/printward-db.json
GCS_API_BASE=https://storage.googleapis.com/storage/v1
REQUIRED_DOCUMENT_TYPES=packingSlip,attachment
VISIBLE_DOCUMENT_TYPES=packingSlip,attachment
FREIGHT_GCS_BUCKET=another-bucket-when-ready
FREIGHT_GCS_PREFIX=freight-prefix/
```

To enable freight PDFs, set `FREIGHT_GCS_BUCKET` (which can be the same bucket) and
`FREIGHT_GCS_PREFIX`, then include `pallet` and `freight` in
`REQUIRED_DOCUMENT_TYPES` and `VISIBLE_DOCUMENT_TYPES`.

## Sync nShift freight documents

Freight documents are synced by a separate Cloud Run Job. The web app does not call nShift during printing.

The sync job:

- Reads booked consignments from `FreeInf1` where `InfCatNo = 8376`, `FrInfTp = 1213`, `FrInfTp2 = 2386`, `FrInfTp3 = 5325`, and `Val1 IN (2, 8)`.
- Uses `FreeInf1.Txt1` and `FreeInf1.Txt2` as fresh/chilled and frozen consignment numbers.
- Reads `FreeInf1.Val2`, `Val3`, `Val5`, and `Val6` by default as reported pallet/half-pallet count metadata; these counts do not control PDF page duplication.
- Calls nShift `ConsignmentWS.printWaybill` for each consignment number.
- Merges multiple PDFs into one `freight{OrdNo}.pdf`.
- For `Kyl- och Frysexpressen Mälardalen AB` orders with booked consignments, calls nShift `ConsignmentWS.print` with the configured pallet print type and uploads one `pallet{OrdNo}.pdf`, including when reported pallet counts are zero.
- Skips existing output PDFs before calling nShift in non-dry mode unless `NSHIFT_FORCE_REFRESH=true`; a missing pallet PDF can be backfilled without refetching existing freight.
- Uploads only when the PDF content hash changed, so GCS generations and Printward reprint state stay stable.

Default demo output:

```text
gs://pdf-service-bucket/freight/9992/freight{OrdNo}.pdf
gs://pdf-service-bucket/freight/9992/pallet{OrdNo}.pdf
```

When the job is active, configure the web app to scan that freight prefix:

```text
INCLUDE_FREIGHT=true
FREIGHT_GCS_BUCKET=pdf-service-bucket
FREIGHT_GCS_PREFIX=freight/9992/
REQUIRED_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight
VISIBLE_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight
```

`pallet` is conditional in the UI: SQL context requires it for a matching external
distributor with booked consignment numbers, even when reported pallet counts are
zero. An existing pallet PDF also makes it required. The pallet bundle covers
freight, so a separate freight PDF is excluded from the print packet. Defaults:

```text
NSHIFT_PALLET_DOCUMENT_DISTRIBUTORS=Kyl- och Frysexpressen Mälardalen AB
NSHIFT_PALLET_COPY_FIELDS=Val2,Val3,Val5,Val6
NSHIFT_PALLET_PRINT_OPERATION=print
NSHIFT_PALLET_PRINT_TYPE=2
```

Store nShift credentials in Secret Manager. Do not commit or paste them into deploy scripts:

```sh
printf '%s' 'Integration' | gcloud secrets create NSHIFT_USERNAME --project visma-274514 --data-file=-
printf '%s' 'group-name' | gcloud secrets create NSHIFT_GROUP_NAME --project visma-274514 --data-file=-
printf '%s' 'password' | gcloud secrets create NSHIFT_PASSWORD --project visma-274514 --data-file=-
```

Earlier project documentation recorded nShift credentials exposed in a prior
conversation. Confirm they have been rotated before production use; rotation
status is not recorded in this repository.

The Cloud Run job service account needs:

- Secret Manager access to `SQL_UID`, `SQL_PWD`, `NSHIFT_USERNAME`, `NSHIFT_GROUP_NAME`, and `NSHIFT_PASSWORD`.
- Read access to the Cloud SQL read replica through the existing VPC connector.
- GCS object read/write access on the freight output bucket.

The Cloud Scheduler caller service account needs permission to run the Cloud Run Job.

Deploy the demo sync job:

```sh
bash scripts/deploy-freight-sync-job.sh
```

By default this deploy is preview-only:

```text
NSHIFT_FETCH_ENABLED=false
NSHIFT_SYNC_DRY_RUN=true
NSHIFT_SYNC_LIMIT=1
SQLSERVER_DATABASE=F9992
```

In preview mode the job queries SQL and logs matching `FreeInf1` consignments, but it does not call nShift and does not write to GCS.

Run it manually:

```sh
gcloud run jobs execute printward-freight-sync-demo --project visma-274514 --region europe-north1
```

Schedule it every five minutes:

```sh
bash scripts/deploy-freight-sync-scheduler.sh
```

Production example:

```sh
JOB=printward-freight-sync \
GCS_PREFIX=2/ \
NSHIFT_OUTPUT_GCS_PREFIX=freight/2/ \
SQLSERVER_DATABASE=F0002 \
bash scripts/deploy-freight-sync-job.sh
```

To allow a real nShift call, redeploy with `NSHIFT_FETCH_ENABLED=true` and an explicit allow-list:

```sh
NSHIFT_FETCH_ENABLED=true \
NSHIFT_SYNC_DRY_RUN=true \
NSHIFT_ALLOWED_ORDER_NUMBERS=123456 \
bash scripts/deploy-freight-sync-job.sh
```

The job refuses production nShift calls unless `NSHIFT_ALLOWED_ORDER_NUMBERS`, `NSHIFT_ALLOWED_CONSIGNMENT_NUMBERS`, or `NSHIFT_ALLOW_ALL=true` is set.

`NSHIFT_SYNC_DRY_RUN=true` suppresses GCS uploads, but **still calls nShift when
fetching is enabled**. Keep `NSHIFT_FETCH_ENABLED=false` for a no-call preview.

Cloud Run Job retries are disabled for the freight sync. nShift's waybill endpoint may be stateful, so a failed GCS upload must not automatically trigger another nShift print request.

## Configure Cloud SQL order context

The order context is read from the same Visma Business SQL Server structure used by `NordwardVismaBusinessInterface`.

Printward reads these tables in read-only mode:

- `Ord`: order header, customer number, dispatch date `DelDt`, delivery method `DelMt`, departure priority `DelPri`, references, note, process status.
- `Txt`: delivery method name lookup where `Lang = 46`, `TxtTp = 5`, and `TxtNo = Ord.DelMt`.
- `Actor`: customer name lookup by `CustNo`.
- `OrdLn`, `Prod`, `Unit`: line count, total quantity, and a few top line descriptions.

`DelPri` is rendered as an hourly departure time, so `6` becomes `06:00`, `12` becomes `12:00`, and so on. The dashboard defaults to sorting and grouping by dispatch slot: `DelDt + DelPri + DelMt`.

Use the Cloud SQL read replica connection string from Secret Manager or the deploy environment:

```sh
ORDER_CONTEXT_MODE=sqlserver \
VISMA_BUSINESS_DB_CONNECTION_STRING="data source=10.x.x.x,1433; initial catalog=F0002; User Id=...; Password=...;" \
npm start
```

Equivalent split variables are also supported:

```text
ORDER_CONTEXT_MODE=sqlserver
SQLSERVER_HOST=10.x.x.x
SQLSERVER_PORT=1433
SQLSERVER_DATABASE=F0002
SQLSERVER_USER=...
SQLSERVER_PASSWORD=...
```

For Cloud Run in the same Google Cloud project, prefer the read replica private IP and attach the service to the same VPC/network path that can reach Cloud SQL. Keep the SQL password in Secret Manager and inject it as an environment variable at deploy time.

If no SQL settings are provided, mock GCS mode uses `data/mock-order-context.json`; live GCS mode disables order context rather than blocking printing.

## Deploy to Cloud Run

The project is prepared for `visma-274514` in `europe-north1`. The deploy script defaults to demo:

```sh
bash scripts/deploy-cloud-run.sh
```

Demo defaults:

```text
SERVICE=printward-demo
GCS_BUCKET=pdf-service-bucket
GCS_PREFIX=9992/
SQLSERVER_HOST=10.61.16.34
SQLSERVER_DATABASE=F9992
STATE_STORE=datastore
```

If freight sync is deployed for demo, also set:

```text
INCLUDE_FREIGHT=true
FREIGHT_GCS_BUCKET=pdf-service-bucket
FREIGHT_GCS_PREFIX=freight/9992/
REQUIRED_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight
VISIBLE_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight
```

Production should be deployed with the production prefix and database:

```sh
SERVICE=printward GCS_PREFIX=2/ SQLSERVER_DATABASE=F0002 bash scripts/deploy-cloud-run.sh
```

The script attaches the existing Cloud Run service account `webshop-api@visma-274514.iam.gserviceaccount.com`, the VPC connector `connector-cloudrun-sql`, and injects `SQL_UID` / `SQL_PWD` from Secret Manager as SQL credentials.

It defaults to authenticated-only Cloud Run access. For public ingress protected
by Printward's own login, set `ALLOW_UNAUTHENTICATED=true` and
`PRINTWARD_LOGIN_PASSWORD_SECRET` to a Secret Manager secret name; the script then
enables app login. Optionally set `PRINTWARD_SESSION_SECRET_SECRET` for a separate
session signing secret and `PRINTWARD_LOGIN_USER` for the username.

Cloud Run IAM authentication and Printward app login are separate. The local print
agent uses job-scoped tokens for documents and completion, but does not acquire
Google IAM identity tokens. Verify the intended access path for the deployed service.

Printward uses Datastore mode for Cloud Run state when `STATE_STORE=datastore`; local development still defaults to the JSON file under `data/`.

Script defaults are not a record of deployed state. Review existing environment
variables and secrets before redeploying: the scripts use replacement flags, and
the web script sets Datastore namespace `printward` for both demo and production.
See the [handoff](docs/agent-handoff.md#environment-and-operational-context) for
environment isolation and release considerations.

## Printing behavior

Packing left normally blocks printing. External distributor orders can print
available pallet/freight documents early while packing continues; slips and
attachments are excluded until packing is complete. This does not make the entire
order ready. Best Transport is normally freight-optional; DB Schenker Finland
International receives four consecutive copies of each freight page.

On macOS and Linux, the local agent uses CUPS `lp`. Normal orders print as one CUPS
job with all selected PDFs attached, so printers that support per-job stapling can
staple each order packet. Kyl pallet bundles are split into separate jobs: each
label page, frozen freight, cooling freight, and slip plus attachment. The server
classifies the PDF pages dynamically and rejects missing or unrecognized freight
sections rather than assuming fixed page offsets.

The default staple option is:

```text
StapleLocation=UpperLeft
```

Printer finishing options vary by driver. Change the staple option in Settings to match the local printer's CUPS option.

On Windows, the installer configures the local agent with portable SumatraPDF as the PDF print bridge. The agent merges each normal order packet or Kyl section into one PDF and sends a separate print job for each. SumatraPDF can set common options such as copies, collation, duplex, color mode, tray, and paper size, but stapling is controlled by the Windows printer driver. For stapling, create or select a Windows printer queue whose driver preferences already enable the wanted finisher/staple mode, for example an `MP C4504 Staple` queue.

The Windows installer downloads this repository's `main` branch. Rerun it to update
an installed agent; pushing to GitHub or deploying Cloud Run does not update PCs.

Print history supports retrying the original packet snapshot, including its GCS
generations and section boundaries. Retry can fail if old generations are no longer
available. To print current document versions, start a new print action. Combo
printing can include delivery-method separator pages, and the browser receives job
updates through `/api/events`.

## API

Useful endpoints:

```text
GET  /api/orders
GET  /api/orders/:orderNumber
GET  /api/health
GET  /api/events
GET  /api/print-jobs
POST /api/print-jobs
POST /api/print-jobs/:id/retry
GET  /api/print-jobs/:id/manifest
POST /api/print-jobs/:id/complete
GET  /api/documents?name=objectName&source=primary
GET  /api/defaults?user=username
POST /api/defaults
```

## Tests

```sh
npm test
```
