# Agent handoff

Last reviewed: 2026-09-07. Behavior reviewed through commit `4d8d9c6`
(`Allow early external freight printing`). This handoff update changes documentation
only. GitHub repository: [grossmanj/printward](https://github.com/grossmanj/printward),
branch `main`. Check Git history for subsequent work.

## Architecture and entry points

Printward combines GCS PDFs with read-only Visma Business SQL order context, tracks
printed document versions, and sends job manifests to an agent on the operator's PC.
The nShift sync runs separately; printing in the web app does not call nShift.

| Location | Responsibility |
| --- | --- |
| `src/server.js` | HTTP API, login, order cache, job snapshots, document authorization, PDF transformations, event stream |
| `src/documents.js` | Filename classification, required documents, readiness, print sections, copy rules |
| `src/orderContext.js` | SQL queries and normalized order, distributor, consignment, and packing context |
| `src/gcsClient.js` | Mock/live storage, primary/freight sources, generation reads, conditional uploads |
| `src/stateStore.js` | JSON/Datastore defaults, jobs, completion events, printed-version index |
| `src/pdf.js` | PDF generation, page extraction/repetition, Kyl page classification |
| `src/local-agent.js` | Loopback HTTP service, PDF downloads, OS printer submission, completion callback |
| `src/freight-sync-job.js`, `src/freightSync.js`, `src/nshiftClient.js` | Job entry point, SQL selection and sync, nShift SOAP requests |
| `src/config.js` | Application environment variables and defaults |
| `src/dashboardRules.js` | Read-only dashboard freight/own-car/chain grouping, document counts, return departures, and pickup/courier/taxi summaries |
| `public/app.js`, `public/index.html`, `public/styles.css` | Browser UI; filtering, grouped dispatch slots, settings, history, retry, live updates |
| `public/printward-dashboard.*` | Staged, local dashboard prototype; freight, own-car, Yama/ChopChop, returns, pickup/courier/taxi panels, and order tabs are data-backed so far |
| `public/install-print-agent.ps1` | Windows installation and startup registration |
| `scripts/` | Separate Cloud Run service, freight job, and scheduler deployment scripts |

## Business rules to preserve

### Document versions and readiness

- Recognized names are `pallet{order}.pdf`, `order{order}.pdf`, `parti{order}.pdf`,
  and `freight{order}.pdf`. Normal packet order is pallet, slip, attachment, freight.
- Print status is tied to object name, source, and generation (updated timestamp
  when no generation exists). Replacing a printed object makes it need reprinting.
- Freight types are opt-in for live storage. Once enabled, freight is normally
  required for an external distributor (`SupNo > 0`), with Best Transport exempted
  by number `55058127` or normalized name `Best Transport AB`. Existing freight PDFs
  can make freight required even without that context.
- A required or existing pallet bundle covers freight: the separate freight PDF
  is excluded from the print snapshot and from freight requirements.
- For `Kyl- och Frysexpressen Mälardalen AB`, booked consignment numbers make the
  pallet bundle required even when the reported pallet count is zero. `Val2`,
  `Val3`, `Val5`, and `Val6` remain count metadata, not a reason to skip the bundle.
- Packing left normally blocks printing. The latest change allows an external
  distributor's available pallet/freight document to print early. While packing
  remains, the snapshot contains only pallet (preferred when required/present) or
  freight; it excludes slips and attachments. The order remains packing-blocked
  for whole-packet readiness and summary counts. Internal orders remain blocked.
- Job creation includes required document types even if user defaults omit them.
  The early-freight restriction is then applied per order.

### Kyl packets and printer finishing

- The server reads the selected pallet PDF generation and classifies pages from
  PDF stream text. `fraktsedel` identifies freight; frozen matches include
  `froozen`, `frozen`, and `fryst`; cooling matches include `cooling` and `kyla`.
  Pages without `fraktsedel` are treated as labels. This is a format-specific
  heuristic, not OCR or a general PDF text extractor.
- Job creation rejects missing label pages, missing cooling/frozen sections
  expected from consignment context, and unknown freight pages. Preserve this
  validation if nShift changes its PDF layout.
- Kyl/Eriksson use separate frozen and chilled print sections within each
  order. Each section starts with the label pages matched to its booking number
  (or an unambiguous temperature marker), followed by its freight pages. The
  sections are stapled separately, and slip plus attachment remain another
  section when packing permits. Unknown label-to-booking matches fail closed.
  Selected pages come from dynamic PDF analysis, never fixed offsets or pallet
  counts.
- The local agent submits each section as a separate OS print job, preserving
  stapling boundaries. Normal orders are one job per packet. Windows uses
  SumatraPDF with a printer queue whose driver supplies stapling preferences;
  macOS/Linux use CUPS `lp` and the configured staple option.
- `DB Schenker Finland International` gets four copies of each freight page in
  sequence (`1,1,1,1,2,2,2,2`), rather than four collated documents.
- Combo printing may insert generated delivery-method separator PDFs. These
  synthetic documents must never create order-document print events.

### SQL and UI

- A 2026-10-02 Visma cash/Swish example uses the manual Fakturor/kreditnotor
  print dialog with standard form 365, **Faktura B&N**. This identifies the
  required template, not an automated invoice-generation interface. The
  proposed rule applies to **all delivery methods**: use the **order's**
  `Ord.PmtTrm`, not customer `Actor.CPmtTrm`, to select a new invoice form 365
  plus partibilaga instead of följesedel plus partibilaga. Pickup Swish badging
  currently uses `Ord.PmtTrm=1`; confirm that code and any other cash terms
  against real orders. These orders are not yet invoiced: Visma invoice print
  and approval creates the invoice. A PDF-only Print Agent cannot do that.
  Local dashboard/server code blocks the normal packing-slip print path for
  proposed code 1. Do not enable invoice print until finance/IT verifies a
  supported Visma creation/approval flow, PDF retrieval, duplicate protection,
  and the resulting accounting state. No live invoicing was tested.
  A viable one-button design has two stages: request Visma's own invoice
  **Print to PDF** for the exact order with form 365 and complete its normal
  approval; only after approval, resolve the resulting PDF and send it with
  the partibilaga to the Printward agent. Visma documents that Print to PDF
  writes a copy to the configured Fax/e-mail route and may delete it when
  approval is cancelled. This is a design candidate, not an implemented or
  validated integration. Determine the supported command/automation interface,
  configured output path, read access, and unambiguous invoice/order mapping
  before adding any automatic button. The existing SQL connection stays read-only.
  Current owner decision (2026-10-05): defer Swish/cash invoice printing in
  Printward. Operators continue printing these invoices directly in Visma.
  Keep the dashboard's ordinary packing-slip path blocked for these orders;
  do not enable automatic invoicing or treat a Printward print status as an
  invoice status. The two-stage design above remains a future option only.
- Tidig/FM/EM följesedel counts mean **klara för utskrift**: both paper
  documents exist and packing is complete. They are not printed counts.
- The overview's virtual-print controls, status note, and printer settings sit
  in the top filter row after the distributor selector. This is a layout
  change only; print eligibility and agent behavior are unchanged.
- Dispatch grouping uses `DelDt + DelPri + DelMt`; `DelPri` is an hour (`6` means
  `06:00`). Distributor filtering deduplicates by trimmed, case-insensitive name,
  falling back to distributor number where needed.
- SQL header queries select sales transactions (`TrTp = 1`), exclude cancellation
  bit `536870912`, require status bit `8` or `8192`, and exclude delivery methods
  `6, 40, 150, 151, 152`. Normalized active-order handling also checks processed
  masks and order types; inspect both SQL and normalization before changing them.
- Line and warehouse packing queries have additional product/status filters.
  Read the complete queries in `src/orderContext.js` before changing readiness;
  unfiltered order lines are not equivalent to physical items still needing packing.
- Packing department bits are Dry `1`, Frozen `2`, and Fresh/Other `4`. Missing
  context is handled separately from a known packing block.

### History, authentication, and live updates

- Retrying creates a new job/token using the previous document snapshot, sections,
  and generations. It does not rebuild from today's PDFs or rerun readiness checks.
  Old-generation availability depends on GCS retention/versioning; a retry can fail
  when its original generation is unavailable. Use a new print action for current PDFs.
- App login uses a signed session cookie. Job-scoped tokens let the local agent
  fetch authorized documents and post completion without browser cookies. Preserve
  job membership, source, generation, and token checks when editing these routes.
- Cloud Run IAM protection and app login are distinct. The local agent does not
  acquire Google IAM identity tokens; confirm the intended access path when deploying.
- `/api/events` broadcasts job changes using a process-local SSE hub. It is not a
  shared event bus across Cloud Run instances. Orders also use caches; the application
  default is 60 seconds and SQL context cache default is 15 seconds.

## Environment and operational context

These are checked-in script defaults, not a verified inventory of running services.
No Cloud Run deployment, scheduler inspection, live SQL/nShift call, or physical
printer validation was performed for this documentation update.

| Setting | Demo | Production target |
| --- | --- | --- |
| Google Cloud project / Run region | `visma-274514` / `europe-north1` | Same |
| Web service | `printward-demo` | `printward` |
| SQL database | `F9992` | `F0002` |
| Primary PDFs | `gs://pdf-service-bucket/9992/` | `gs://pdf-service-bucket/2/` |
| Freight PDFs | `gs://pdf-service-bucket/freight/9992/` | `gs://pdf-service-bucket/freight/2/` |
| Freight job | `printward-freight-sync-demo` | `printward-freight-sync` |

- Scripts use service account `webshop-api@visma-274514.iam.gserviceaccount.com`,
  connector `connector-cloudrun-sql`, and SQL host `10.61.16.34`. SQL credentials
  come from Secret Manager `SQL_UID` / `SQL_PWD`; nShift credentials use
  `NSHIFT_USERNAME`, `NSHIFT_GROUP_NAME`, and `NSHIFT_PASSWORD`.
- Cloud Run state uses Datastore. The web deploy script hardcodes namespace
  `printward` for both environments; verify intended isolation before sharing a
  project between demo and production. Runtime config supports `DATASTORE_NAMESPACE`
  and `DATASTORE_KIND_PREFIX`, but the script does not expose every runtime option.
- Deploy scripts use `--set-env-vars` / `--set-secrets`. Review existing configuration
  before redeploying so omitted custom settings are not inadvertently replaced.
- `ALLOW_UNAUTHENTICATED=true` in the web deploy script requires
  `PRINTWARD_LOGIN_PASSWORD_SECRET` and enables app login. The optional
  `PRINTWARD_SESSION_SECRET_SECRET` selects a separate signing secret.
- nShift selection uses `FreeInf1` category/type values `8376/1213/2386/5325`,
  booked statuses `2,8`, and fresh/frozen consignments in `Txt1/Txt2`. Default date
  window is three days back through fourteen days ahead.
- Preview: `NSHIFT_FETCH_ENABLED=false` prevents nShift calls and GCS writes.
  With fetch enabled, `NSHIFT_SYNC_DRY_RUN=true` still calls nShift. Keep explicit
  order/consignment allow-lists unless a broader run was intentionally requested.
- Non-dry sync skips existing PDFs before calling nShift, can backfill a missing
  pallet PDF without refetching freight, and hashes uploads to avoid needless
  generation changes. Existing PDFs are not routinely refreshed;
  `NSHIFT_FORCE_REFRESH=true` deliberately bypasses that protection.
- Freight job retries stay at zero because nShift print operations may be stateful.
  The deployment script uses a 60-second SQL timeout, one task, and a 15-minute task
  timeout. Its default sync limit is one order; application defaults differ.
- Scheduler script defaults to every five minutes, Europe/Stockholm, with Scheduler
  in `europe-west1`. Set both `JOB` and `SCHEDULER_JOB` when targeting production.
- Windows installation downloads GitHub `main`, Node 20, and SumatraPDF 3.6.1 into
  `%LOCALAPPDATA%\PrintwardAgent`; logs are in `agent.log`. Rerun the installer to
  update an installed agent. Its ASCII `.cmd` and `.vbs` launchers must resolve
  `%LOCALAPPDATA%` at runtime, not interpolate an absolute profile path: a Windows
  account such as `Broström` otherwise loses the non-ASCII character, exits before
  starting Node, and may create no agent log. The launcher regression is covered by
  `test/windows-installer.test.js`; a Windows PC reinstallation/health check remains
  to be verified. Pushing or deploying the web app does not update PCs.
- Installer fix `53ba479` passed all 91 local Node tests on 2026-09-28. The
  `printward-demo` trigger ran both automatically (`7a18ed92`) and once manually
  (`000a3cf5`); both Cloud Build runs succeeded. Cloud Run revision
  `printward-demo-00021-t7z` was healthy and serving 100% of demo traffic after
  deployment. Production was not changed. Windows agent health and physical
  printer behavior still require an on-PC check.
- Earlier documentation recorded nShift credentials exposed in a prior conversation.
  Rotation status is unverified; confirm with the owner before production use.

## Verification and remaining checks

### Local dashboard stage (2026-09-24)

- `GET /api/dashboard/freight?deliveryDate=YYYY-MM-DD` uses the same date-scoped,
  read-only order loading as `/api/orders`. It separates Eriksson when **order**
  `DelMt=25` and supplier is 7331697 before the general Kyl supplier rule.
  DSV uses order `DelMt=47/48` or supplier 50063993, Best supplier 55058127,
  and Jansen order `DelMt=52`/other carriers. Do not use `Ord.Gr2` as a route
  code here. Best/Other departure counts deduplicate orders sharing `DelPri`
  and `DelMt`.
- Kyl and Eriksson count the required/available pallet bundle when applicable;
  DSV counts the freight PDF. These availability counts intentionally ignore a
  missing packing slip. Red badges count orders without that freight document;
  they do **not** yet count print jobs waiting to be sent. The read-only list
  shows `FreeInf1.Txt1` (chilled) and `Txt2` (frozen) separately. General order
  search also accepts those booking numbers.
- The prototype defaults to today's local date and refreshes these figures via
  its Update button. The return card and read-only list also use `/api/returns`,
  with a second filter enforcing `Ord.DelMt=151` and `Ord.Gr3=30`. Returns are
  grouped from the **order's** `DelPri`: before 07:00 = Tidig, 07:00–11:00 = FM,
  12:00–16:00 = EM, and missing/out-of-range = unscheduled. This is a time
  grouping, not proof that an own-car route has actually been assigned.
- `GET /api/pickups?deliveryDate=YYYY-MM-DD` is a separate read-only query
  because the normal order query excludes `DelMt=6`. It includes `6` (customer
  pickup), `16` (courier), and `42`–`46` (taxi). `Ord.PmtTrm=1` adds a Swish
  badge only to customer pickups. The customer `Actor.CPmtTrm` remains
  available as reference but never overrides the order. Verify term code 1
  against real Visma examples before relying on it operationally. `Actor.R12=60` together with
  `Ord.DelMt=6` is a separate staff-order row within the pickup area, excluded
  from the ordinary customer-pickup subtotal. The dashboard previews three
  non-staff pickup orders, with a full read-only list when more exist.
- `GET /api/dashboard/dispatch?deliveryDate=YYYY-MM-DD` now drives the own-car
  Tidig/FM/EM follow-slip cards. It uses the **order's** `DelPri` (before 07,
  07–11, 12–16), confirmed numeric own-car `DelMt` values `1–5, 7–15, 27, 41`,
  plus a preliminary vehicle-registration pattern in the delivery-method text
  for post-Pindeliver codes. External supplier orders are excluded. A ready
  count requires slip + attachment + completed packing; missing time stays out
  of the quick cards. Lists sort by `DelPri`, then delivery-method text, then
  order number. Both the regex and real post-Pindeliver `Txt` values need
  verification before any printing is wired to these cards.
- The own-car list now supports read-only selection: individual ready orders or
  all ready orders in the visible search result. The inline review shows the
  sorted order and per-document print state. Missing-document/packing-blocked
  rows are disabled, and selection resets on date, refresh, new search, or
  departure changes. It does **not** call `/api/print-jobs` or preview PDFs.
- The Kyl/DSV/Eriksson freight lookups now support read-only selection of orders
  with available freight documents. The inline review preserves the sorted
  order and shows booking numbers separately for `Txt1` (chilled) and `Txt2`
  (frozen), while selecting/counting the order once. Best/Other do not expose
  document selection. Fictional mock order `900001` on `2026-06-24` exercises
  two booking rows and one order; mock mode now checks the primary mock storage
  for freight/pallet files when no separate freight bucket is configured. Live
  bucket lookup behavior is unchanged. No print job or nShift action occurs.
- `POST /api/dashboard/freight-plan` is a read-only, server-validated plan for
  selected Kyl/DSV/Eriksson orders. It refreshes current date-scoped data,
  rejects wrong-group, missing-document, missing-order and duplicate selections,
  and returns the `DelPri`-sorted freight document list without packing slips,
  attachments, state writes, nShift calls or print jobs. The dashboard review
  now uses this result, not a client-only reconstruction. Do **not** wire its
  result straight into generic `/api/print-jobs`; that route calls
  `includeRequiredDocumentTypes` and may add packing documents.
- `freightOnlyPrintSnapshots` in `src/documents.js` is a staged packet builder,
  not connected to any job endpoint. It accepts a validated plan, checks exact
  document name/source/generation, includes only `pallet` or `freight`, and
  requires analyzed Kyl/Eriksson pallet-page groups before splitting labels,
  frozen freight and chilled freight. Unit tests cover Eriksson section order,
  DSV freight-only output, stale document rejection and missing PDF analysis.
  The mock GCS backend normally returns placeholder PDFs; its explicit
  synthetic page fixtures do not replace real redacted carrier documents
  before printing is enabled.
- `POST /api/dashboard/freight-packet-check` now fetches selected PDFs read-only,
  runs the existing Kyl pallet analysis and validates expected chilled/frozen
  pages, builds the exact freight-only section order, and returns page counts
  and sections for the dashboard review. It creates no job. Mock GCS metadata
  supports explicit `mockPages` for fictional orders `900001`–`900005`; these
  are synthetic test pages, not real nShift layouts. Browser QA showed labels,
  frozen and chilled waybills in order for Kyl and both Eriksson examples.
  Unknown or missing expected sections fail closed. Revalidate on real carrier
  PDFs before activating any print path.
- Fictional mock orders `900003` (07:00) and `900002` (16:00) on `2026-06-24`
  verify that `DelMt=25` with Kyl supplier 7331697 appears in Eriksson, not
  Kyl & Frys, sorted by order `DelPri`. Browser QA showed Eriksson 2/2 and
  the expected ordering. Marking nShift waybills/labels with "Eriksson" remains
  unimplemented pending a real document and integration/layout confirmation.
- Fictional mock orders `900004` (route 47, 07:00) and `900005` (route 48,
  13:00) on `2026-06-24` exercise DSV Finland's read-only freight PDF check,
  separate booking numbers and sorting. The existing four-copy freight rule
  now keys on supplier number `50063993` instead of the mutable supplier name.
  This is still only a plan; the endpoint does not multiply pages or print.
- The number of Eriksson departures is unconfirmed by the owner; keep per-order
  `DelPri` sorting without assuming a fixed number of departures. The owner is
  checking whether nShift supports a separate conditional Eriksson layout for
  both the waybill and labels while retaining the Kyl supplier number.
- `GET /api/dashboard/chains?deliveryDate=YYYY-MM-DD` now drives the Sushi
  Yama (`Actor.R12=41`) and ChopChop (`Actor.R12=100`) cards and read-only order
  lists. A chain order is counted as printed only if **both** its packing slip
  and attachment have `printStatus=printed`. Own-car, external-freight, and
  unclassified transport are shown separately; the last is never silently
  treated as remote. The Other customers card has no fake number and waits for
  an audited `Actor.DocSmt` rule. Real Visma chain orders and print-status
  propagation still need verification. The current source is mock data without
  chain examples, so zeroes do not establish real chain volume.
- Read-only lookup lists have an explicit return button; Esc closes lists and
  detail dialogs back to the Printward overview. No dashboard print operation,
  SQL write, nShift call, or deployment was done.
- Node 22.18.0 tests: 63/63 passed.
  Local smoke requests to the freight endpoint for 2026-06-24, pickup endpoint
  for 2026-09-24, and dispatch endpoint for 2026-06-24 returned the expected
  structures and mock source status. Browser QA showed mock order 1003 in Tidig
  as 0/1 ready because its attachment is missing. No live SQL/Actor values were
  checked in this stage.

On 2026-09-07, `npm test` on Node.js `v25.6.1` passed all 43 tests with no failures
or skips. The container uses Node 22 and the Windows installer selects Node 20;
those runtimes were not separately tested in this review. Tests use mocked
dependencies/synthetic PDFs and do not establish live integration health.

| Area | Tests |
| --- | --- |
| Document requirements, early freight, sections, copy order | `test/documents.test.js` |
| PDF extraction, repetition, variable Kyl page classification | `test/pdf.test.js` |
| SQL filtering, Kyl zero-count requirement, Best Transport exception | `test/orderContext.test.js` |
| App login, job tokens, exact retries, separators, SSE | `test/server-auth.test.js` |
| Sync skip/backfill/dry-run and SOAP formatting/parsing | `test/freightSync.test.js`, `test/nshiftClient.test.js` |
| Environment defaults and freight opt-in | `test/config.test.js` |

There is no checked-in CI workflow, browser automation suite, or physical printer
test. When changing browser or local-agent behavior, verify the affected flow on
the relevant OS in addition to automated tests. Outstanding operational questions
are deployed revision/configuration, credential rotation, old GCS generation
retention, Datastore environment isolation, and printer finishing behavior. These
are verification needs, not claims that the running system is broken.

## 2026-09-24 isolated dashboard stage

- The current local, uncommitted dashboard code was uploaded as an archive to
  Cloud Shell and deployed to a **new** Cloud Run service,
  `printward-dashboard-stage`, in project `visma-274514`, region
  `europe-north1`. It did not deploy to `printward-demo` or `printward-prod`.
  `scripts/deploy-readonly-stage.sh` fixes the service name and F9992 demo DB,
  uses `DATASTORE_NAMESPACE=printward_dashboard_stage`, keeps IAM-only access,
  and disables nShift fetching. The service URL is
  `https://printward-dashboard-stage-398996760490.europe-north1.run.app`.
- `PRINTWARD_READ_ONLY=true` blocks mutating API requests with HTTP 403 while
  allowing the two read-only freight preflight POSTs. Live `/api/health`
  confirmed `readOnly=true` and SQL order context available. An authenticated
  POST to `/api/print-jobs` returned 403; an unauthenticated health request
  also returned 403. No print job or nShift action was run.
- On delivery date `2026-02-25`, live F9992 SQL supplied **297 orders**. Only
  **2** had any retained PDF in the configured demo GCS source, so 295 show as
  missing documents. The new dashboard returned own-car FM 1/132 ready and EM
  0/29; Kyl & Frys 0/70, Eriksson 0/14; Best 5 departures; Sushi Yama 21 and
  ChopChop 25 orders; one courier order and no coded pickup returns. The
  `registrationTextMatches` count was 159. These counts need business-owner
  validation; groups overlap and should not be added together.
- Browser QA through a Cloud Shell proxy showed the 297-order dashboard and a
  clickable FM lookup listing 132 orders, then returned to the overview. The
  preview URL is ephemeral and depends on the Cloud Shell proxy/session; the
  Cloud Run service itself remains private. A fast date switch initially showed
  unavailable panels, but clicking Uppdatera loaded them. If reproducible,
  inspect concurrent fetches/proxy behavior before calling the UI stable.
- Local Node 22.18.0 suite: 67/67 tests passed, including read-only API guard.

## 2026-09-25 read-only live deployment

- The owner approved using production data in a read-only dashboard, with no
  printing. `scripts/deploy-readonly-live.sh` deployed a separate,
  IAM-only `printward-dashboard-live` service using F0002 and GCS prefixes
  `2/` and `freight/2/`; it did not change the existing Printward service.
  Revision `printward-dashboard-live-00001-4z6` serves 100% of its own traffic.
- Date-scoped SQL retrieval now pages normal orders, returns, and pickups
  instead of silently truncating at 500. A regression test covers 501 normal
  orders and smaller batches for the other scopes. The dashboard defaults to
  the Europe/Stockholm date rather than the browser date input's UTC day, and
  has an explicit read-only label. Node 22.18.0 suite: 71/71 passed.
- The live script sets `PRINTWARD_READ_ONLY=true` and
  `NSHIFT_FETCH_ENABLED=false`. Dedicated identity
  `printward-dashboard-readonly@visma-274514.iam.gserviceaccount.com` has
  project `roles/datastore.viewer`, bucket-scoped `roles/storage.objectViewer`
  on `pdf-service-bucket`, and secret-scoped `roles/secretmanager.secretAccessor`
  on `SQL_UID` and `SQL_PWD`. The SQL credential's database-level SELECT-only
  privileges still need confirmation; do not claim SQL infrastructure-level
  read-only until checked. Cloud Run is not public.
- The live script now reads the existing production `printward` Datastore
  namespace so printed status reflects actual history; the new service
  account must have `roles/datastore.viewer`, not write access. The dashboard
  itself still blocks every mutating route, and no simulated print completion
  is allowed to enter production history.
- The local dashboard now shows separate lookup and disabled quick-print
  buttons for dispatch, freight, chain, and return cards. All freight lookup
  labels are `Visa avgångar`. Chain and return lookups gained individual
  selection/review; dispatch and freight lookups show disabled `Skriv ut valda`.
  Pickup rows show a disabled print action and remain clickable for order
  details. Order details link to the exact available PDF generation through
  the read-only document endpoint. No new endpoint or actual print action was
  wired. Browser QA on mock date `2026-06-24` verified Kyl/Eriksson/DSV card
  data, the Kyl booking rows, and a real local mock PDF preview. The active
  production and demo services were not changed. The Node 22.18.0 suite is
  now 71/71, including static read-only quick-button checks.
- Authenticated Cloud Shell proxy check: `/api/health` returned `ok: true`,
  `readOnly: true`, `mode: live`, SQL `available: true`. `/api/orders` for
  `2026-09-25` returned 259 production orders; the dashboard rendered 259 total,
  2 Kyl & Frys freight items, 4 Best departures, and 15 ChopChop orders.
  Unauthenticated direct Cloud Run access returned HTTP 403. A diagnostic
  `POST /api/print-jobs` through the authenticated proxy also returned HTTP
  403, with no print job created. The Cloud Shell web-preview URL for port
  9090 works in Chrome but is session-dependent, not a permanent access URL.

## 2026-09-25 virtual-print simulation

- `public/printward-virtual-printer.js` stores a test queue only in browser
  `sessionStorage`. Test mode is opt-in, resets to off on page reload, and never
  invokes `/api/print-jobs`, nShift, a printer, or real print-status writes.
  The read-only service guard remains in place. Existing production counters
  and printed states are not altered; a separate simulated badge/status makes
  the local test result visible. Matching own-car/chain documents deduplicate
  by delivery date, order number, and type.
- The confirmation dialog and **Visa testkö** list document order per order.
  A packing slip followed by attachment is labeled as a *planned* stapled
  packet. Freight/label documents explicitly have no packing slip; this does
  not claim a physical staple was made. Kyl, DSV, and Eriksson require the
  existing read-only PDF preflight before recording a simulated action.
  Pickup/courier/staff simulation records intent only and warns that the
  document template (including a Swish invoice) is not verified. Best,
  other carriers, returns, and DocSmt-based customer printing stay disabled.
- Browser QA on local mock date `2026-06-24` simulated Kyl freight and on
  `2026-06-25` simulated an own-car packing slip plus attachment. The test
  queue displayed both the separate freight-document rule and the planned
  stapled bundle after reload. Local Node 22.18.0 suite: 74/74 passed.
- The owner approved uploading the 114 KB source archive to Cloud Shell and
  updating the separate private service. Revision
  `printward-dashboard-live-00002-rbp` serves 100% of that service's traffic.
  It retained `readOnly: true`, `mode: live`, the F0002/GCS read sources and
  IAM-only access: direct unauthenticated health check returned 403, and a
  diagnostic print-job POST through a fresh authenticated proxy returned 403.
  The existing Printward production service was not changed.
- Browser QA through Cloud Shell port 9091 showed 259 live orders for
  `2026-09-25`. One ChopChop order (`1986550`) was simulated locally from the
  Tidig list; the test queue showed `Följesedel → Partibilaga` as a planned
  stapled packet, and the ChopChop card independently showed one simulated
  order while real printed counters remained unchanged. The authenticated
  preview URL is session-dependent and not a permanent public URL.

## 2026-09-25 lookup sorting (local work)

- The existing top **Sortera** menu now controls Tidig/FM/EM, freight, and
  chain lookup tables. The default preserves each API's existing
  `DelPri` order. **Körsätt** groups by the order's numeric `DelMt`, then
  `DelPri`, then order number. It sorts a copy of visible rows only: overview
  quick actions, selected-document packets, read-only freight preflight, and
  simulated job order retain their original server/canonical order.
- Focused lookup-sort tests cover grouping, tie order, unknown methods, and
  non-mutation. The local mock browser showed the control on a DSV Finland
  lookup and successfully switched modes. This change is local only until a
  separate Cloud Run deployment is authorized and verified.

## 2026-09-25 return-rule correction and private live verification

- A live read-only browser check for `2026-09-24` showed 284 normal orders but
  zero returns; the owner supplied a Visma screenshot with return orders
  `1988077` and `1988159` for that date. The screenshot's **Normal rutt** column
  is not proof of the return order's `Ord.DelMt`; it may be the customer's
  default route (`CDelMt`). The precise old exclusion was not established.
- The new return read uses `Ord.Gr3=30` as the identifier, regardless of
  `Ord.DelMt`, while retaining date, `TrTp=1`, and cancellation filtering.
  The normal ready-status requirement is omitted for this separate return
  scope, since it may discard legitimate return orders. Both regular orders
  and pickups exclude `Gr3=30` to prevent duplicate/misleading grouping.
- Return UI wording and mock/SQL unit tests were updated; local Node 22 suite
  passed 78/78. The owner approved uploading the 114 KB source package to
  Cloud Shell and updating only `printward-dashboard-live` in `visma-274514`.
  SHA-256 matched before deployment. Revision
  `printward-dashboard-live-00003-hkx` serves 100% of this separate service.
- The authenticated live browser view on `2026-09-24` showed exactly two returns,
  `1988077` (07:00) and `1988159` (09:00), matching the two rows in the owner's
  Visma screenshot; the earlier revision showed zero. The return lookup still
  has disabled print controls. The direct unauthenticated health URL returned
  HTTP 403 after deployment; the existing production Printward service was not
  changed. The uploaded source also included the previously local top lookup
  sort control, which is now present in the private live dashboard. The Cloud
  Shell proxy URL is temporary, and exact old exclusion (`DelMt` vs process
  status) was not independently isolated. Return printing remains disabled.

## 2026-09-25 dedicated demo deployment preparation

- Read `AGENTS.md`, `README.md`, and this handoff before work. Fetched
  `origin/main`; both local `main` and the fetched remote pointed at
  `646949a4b4a8b0d458cc924475e3aace8a545f99`. Created local `demo` at
  that commit, preserving the existing dashboard worktree. Node 22.18.0
  `npm test` passed 78/78; `git diff --check` was clean.
- Before any deployment, inspected the *actual* `printward-demo` service in
  `visma-274514/europe-north1`: revision `printward-demo-00005-69f` received
  100% traffic and used the image digest
  `sha256:a3bdbcfd6aa6f52194115779acaaf0db2bc8dc991b31b8335ea37f4879c4f42d`.
  Runtime identity was `webshop-api@visma-274514.iam.gserviceaccount.com`;
  ingress was `all` but service IAM had **no bindings** (authentication
  required). Port 8080, 300-second timeout, concurrency 80, 1 vCPU, 512 MiB,
  startup CPU boost, max scale 100, and 100% traffic to latest revision.
- Runtime data settings were `GCS_BUCKET=pdf-service-bucket`,
  `GCS_PREFIX=9992/`, `GCS_MODE=live`, `ORDER_CONTEXT_MODE=sqlserver`,
  `SQLSERVER_HOST=10.61.16.34`, `SQLSERVER_PORT=1433`,
  `SQLSERVER_DATABASE=F9992`, `STATE_STORE=datastore`,
  `DATASTORE_NAMESPACE=printward`, `REQUIRED_DOCUMENT_TYPES=packingSlip,attachment`,
  and `VISIBLE_DOCUMENT_TYPES=packingSlip,attachment`. `SQLSERVER_USER`
  referenced Secret Manager `SQL_UID:latest`; `SQLSERVER_PASSWORD` referenced
  `SQL_PWD:latest`. There were no volumes. VPC connector was
  `connector-cloudrun-sql` with `private-ranges-only` egress. No environment,
  secret, VPC, authentication, storage, SQL, or state changes have been made.
- The Google Cloud Build GitHub App installation `26894157` has now been given
  access to `grossmanj/printward`, and `grossmanj-github` reports stage
  `COMPLETE`, authorizer user `grossmanj`. Retrying the repository link changed
  the failure from App-access denial to `repo grossmanj/printward is not
  accessible to the OAuth token`. A renewed GitHub authorizer credential is
  needed before creating the repository link and `^demo$` trigger. No demo
  deployment has occurred yet. `printward-prod`, freight jobs, schedulers,
  and the local print agent remain unchanged.
- The dashboard and `cloudbuild.demo.yaml` were committed locally on `demo`
  as `51a5aa5dabfdfcccea5354b9e09832cfbc9a637b`. The normal
  `git push -u origin demo` did **not** succeed: Git reported `could not read
  Username for 'https://github.com': Device not configured`. A separate
  batch-mode SSH check reported `Permission denied (publickey)`. Configure
  GitHub push authentication on this computer, then push normally and verify
  `refs/heads/demo` with `git ls-remote`; do not force-push. This local commit
  is not yet on GitHub, and no trigger/build/revision/health check has been
  validated. The Google OAuth authorizer and local Git push credentials are
  independent blockers.
- Production automation is a separate release decision. The repository's
  default branch is `main` (not `master`); no Printward Cloud Build trigger or
  GitHub workflow was found during the prior inspection, and the current
  production revision came from `gcloud` source deploy with automatic updates
  disabled. Future PR-merge deployment requires an explicitly reviewed
  `^main$` trigger/workflow, production-scoped build identity and image
  repository, a production configuration snapshot/preservation plan, and
  separate rollout/health/print-path validation. None of that is configured
  by the demo work.

## 2026-09-28 follow-slip method bundles (local work)

- Tidig/FM/EM lookups group their displayed orders by the **order's** `DelMt`,
  with `deliveryMethodName` as the visible route/registration label. Each
  clickable bundle shows ready/total counts and expands to all of its order
  rows, including individual document status and selection. The existing
  selected-bundle review and virtual simulation still use the server's
  original `DelPri` ordering; grouping and the top sort are view-only.
- The top search in these lookups now matches the numeric delivery-method code
  as well as its name, order and customer details. A nonempty search expands
  matching bundles by default. Changing the date, refreshing, switching
  departures, or submitting a new search still clears selected orders.
- Local Node 22.18.0 `node --test` passed 81/81 (the temporary bundled `npm`
  executable was incomplete). Browser QA against a separate read-only mock
  server on port 3102 verified Tidig on 2026-06-24: route 11 / City van 11
  expanded to order 1003; a search for `City van` found and opened the bundle,
  and an unmatched route search showed an empty result. No nShift call,
  physical print, GitHub push, or Cloud Run deployment was made for this change.

## 2026-09-28 overview search (local work)

- The overview search now opens a dedicated **Sökresultat** lookup on Enter,
  querying `/api/orders` with `status=all`, the selected delivery date, and
  the search term. Search results show order, customer, delivery town,
  delivery method/registration text and route number, departure and print
  status; clicking a row opens the existing document/status detail dialog.
- SQL context now reads the order-level `Ord.DelPArea` and `Ord.DelPNo` fields,
  normalizes them as `deliveryPostalArea` and `deliveryPostalCode`, and includes
  them in `filterOrders`. Existing customer/name, delivery-method, booking and
  order-number matches remain supported. This is a read-only addition with no
  change to eligibility or print-job creation.
- Scope: `Alla order` for the selected date, including different status values
  and carriers. Pickups and returns have separate data sources and are not yet
  included in this general search. The three own-car follow-slip departure
  lookups already share the route-bundle behavior from the preceding change.

## 2026-09-28 Eriksson route 49 (local work)

- The owner clarified that order `DelMt=49` (`K&F Danmark 13:00`) belongs in
  the Eriksson freight panel alongside `DelMt=25`. Classification requires the
  Kyl & Frys supplier `7331697` and runs before the generic Kyl group.
  Rutt 49 shares the existing Kyl/Eriksson freight-document eligibility and
  `DelPri` sorting; no nShift template or label text was changed.
- Regression tests cover classification, combined Eriksson counts, ordering,
  and read-only freight selection for route 49. Verify with real Visma/nShift
  documents before any physical print activation. Not deployed.

## First follow-up after manual printing: cutoff-triggered freight jobs

- Owner priority: once new Printward's manual freight output has been verified,
  investigate scheduled printing at route-specific order cutoffs. Edmark should
  be able to configure it in a Printward admin view: select a freight group
  (for example Kyl & Frys), a local print time, and weekdays on which to print
  every eligible freight document available at that cutoff. Reuse the normal
  Printward document verification, per-order/temperature sections, selected
  local printer queue and staple settings, status tracking and manual recovery;
  do not build a direct SQL-to-printer path. No automatic printing is enabled
  by the current demo deployment.
- Already printed *document generations* must be skipped; queued/created jobs are not
  proof of printing, and concurrent manual/automatic requests need an atomic
  reservation or equivalent idempotency mechanism. The current print status
  index is generation-aware, but `createJob` does not yet reserve or deduplicate
  pending documents, so current APIs are **not safe** as an automatic scheduler.
- Begin with a read-only planned-run/dry-run and verify actual route cutoffs,
  same-day exceptions, print agent/printer availability, failure/retry behavior,
  and whether `reprint` versions may run automatically. SQL Server Agent vs a
  separate scheduled Printward worker is undecided. Do not implement a direct
  SQL-to-printer/nShift path. No schedule or live job was created in this step.

## 2026-09-28 lookup browser history (local work)

- Opening a dashboard lookup now pushes one browser-history state. Browser Back,
  the lookup close button, and Esc return to the overview; Forward restores the
  lookup, date, and search term. Moving between lookups and changing filters
  replaces that state instead of stacking entries. This is entirely client-side
  navigation and does not enable real printing.
- Chrome QA against the local read-only mock on port 3103 verified Back and
  Forward on a Tidig lookup, plus close-button and Esc navigation. No deploy
  or physical print was performed.

## 2026-09-28 `demo` branch Cloud Build and read-only live-data deployment

- Fetched `origin/main` before publishing. GitHub Desktop was authenticated as
  `moongoaz`; committed the dashboard work on local `demo` as
  `996182341bd957f4df0b194b5e897f3c32908404`, then used a normal Publish
  Branch operation. `git ls-remote --heads origin demo main` confirmed the
  remote `demo` SHA matched and `main` stayed at
  `646949a4b4a8b0d458cc924475e3aace8a545f99`. Node 22.18.0 tests passed
  84/84, and `git diff --check` was clean.
- The earlier `grossmanj-github` OAuth blocker was resolved by a separate
  `printward-github` Cloud Build connection in `europe-north1`, with linked
  repository resource `grossmanj-printward` for `grossmanj/printward`.
  Created regional trigger `printward-demo`
  (`706c2e16-41df-4c65-b47e-b7e25feed905`): repository push branch regex
  exactly `^demo$`, build config `cloudbuild.demo.yaml`, no approval gate,
  build service account `printward-demo-build@visma-274514.iam.gserviceaccount.com`.
  The separate Docker Artifact Registry repository `printward-demo` was
  created in `europe-north1`.
- That build account has `roles/artifactregistry.writer` only on the
  `printward-demo` image repository, `roles/run.developer` only on the
  `printward-demo` Cloud Run service, `roles/iam.serviceAccountUser` only on
  `printward-dashboard-readonly@visma-274514.iam.gserviceaccount.com`, and
  project-level `roles/logging.logWriter` for Cloud Build logs. A project IAM
  query confirmed logging writer is its only project-level role. No
  production deploy or production-image permission was granted.
- Before changing the service, inspected revision `printward-demo-00005-69f`:
  runtime SA `webshop-api`, `F9992`, GCS prefix `9992/`, SQL secret refs
  `SQL_UID:latest` and `SQL_PWD:latest`, Datastore namespace `printward`,
  VPC connector `connector-cloudrun-sql` with private-ranges-only egress,
  IAM-only access, 1 vCPU / 512 MiB, startup CPU boost, max scale 100,
  100% latest traffic. Updated **only `printward-demo`** with additive
  environment changes and runtime SA `printward-dashboard-readonly`:
  `SQLSERVER_DATABASE=F0002`, `GCS_PREFIX=2/`,
  `FREIGHT_GCS_BUCKET=pdf-service-bucket`, `FREIGHT_GCS_PREFIX=freight/2/`,
  `REQUIRED_DOCUMENT_TYPES=packingSlip,attachment`,
  `VISIBLE_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight`,
  `PRINTWARD_READ_ONLY=true`, `PRINTWARD_AUTH_ENABLED=false`,
  `NSHIFT_FETCH_ENABLED=false`, `ORDERS_CACHE_WARMUP=false`. Kept the same
  bucket, SQL host/port, Secret Manager references, Datastore namespace,
  VPC, ingress/authentication, and resource/traffic settings. The temporary
  configuration-only revision was `printward-demo-00006-dxt`.
- Manually ran the new trigger on remote `demo` SHA `9961823`; Cloud Build
  `2396da32-afb6-42eb-abca-5471e85d1653` succeeded. Cloud Run revision
  `printward-demo-00007-88n` serves 100% of `printward-demo` from the image
  `europe-north1-docker.pkg.dev/visma-274514/printward-demo/app:996182341bd957f4df0b194b5e897f3c32908404`
  with the read-only runtime SA. Authenticated `/api/health` returned HTTP 200,
  `readOnly: true`, live GCS prefixes `2/` and `freight/2/`, and SQL context
  available. Authenticated `/api/orders?deliveryDate=2026-09-25` returned
  259 orders with SQL context available; no customer details were logged in
  this handoff. An authenticated empty `POST /api/print-jobs` returned HTTP
  403, confirming the code-level write guard. No nShift call or physical
  print was used as a test. The SQL user's database-level SELECT-only grant
  remains unverified; keep the runtime read-only identity and print guard.
- `printward-prod`, freight jobs, schedulers, and the local printer agent
  were not modified. Production has no Printward merge-to-`main` trigger;
  designing one requires a separate production identity, image repository,
  config-preservation plan, rollout checks, and owner approval.

## 2026-09-28 verified dashboard print flow (repository changes)

- The overview now has a feature-gated real-print path using a local PC Print
  Agent and an explicit physical-print confirmation. `POST
  /api/dashboard/print-jobs` re-reads order context, validates membership,
  document readiness, and current print status, checks the exact PDFs, and
  creates a job-scoped manifest. The existing virtual printer remains separate.
- Permitted groups: Tidig/FM/EM own-vehicle slips plus attachment, Sushi
  Yama/ChopChop slips plus attachment, and Kyl & Frys/DSV Finland/Eriksson
  freight-only documents or label sections. Best, other carriers, returns,
  pickups, Swish invoices, and DocSmt-based customers have no verified
  physical-print mapping and stay disabled. Do not imply otherwise in UI.
- Feature flags default safe: `PRINTWARD_DASHBOARD_PRINT_ENABLED=false` and
  `PRINTWARD_LEGACY_PRINT_ENABLED=true` (unchanged production behavior).
  Demo printing requires the dashboard flag true, `PRINTWARD_READ_ONLY=false`,
  and the legacy flag false. Keep `NSHIFT_FETCH_ENABLED=false` for no-call tests.
- The Print Agent on each PC must be installed/running and reachable at a
  loopback URL; operator/printer/copies/duplex/staple settings are per-browser.
  No test should call live nShift or a physical printer automatically. The
  existing Windows agent has not been updated by these repository changes.
- Environment isolation: when demo becomes writable, change its Datastore
  namespace away from `printward` and use a dedicated demo runtime identity.
  `roles/datastore.user` is granted at project scope, not namespace scope:
  namespace isolation is application-level only. Keep `printward-prod`
  unchanged. Only the demo service should be made public behind its own app
  login secret; verify unauthorized access redirects to `/login` before sharing
  the URL. A push to `demo` by itself does not adjust runtime env/IAM.
- At this handoff entry's creation, code is local and **not yet deployed**.
  Update this section with the exact commit, Cloud Build ID, Cloud Run revision,
  auth/health checks, and any unresolved limitations after deployment. Never
  record password values, customer PDFs, or job tokens.

## 2026-09-28 dashboard transfer-size optimization and demo deployment

- An authenticated Cloud Shell proxy measurement of the existing demo showed a
  forced date-scoped dispatch refresh at 4.77 seconds and a cached freight
  response at 0.13 seconds. The freight JSON response was 697,194 bytes and
  remained uncompressed even with `Accept-Encoding: gzip`; Cloud Run did not
  add compression. These timings include the temporary Cloud Shell proxy and
  do not isolate Visma, GCS, or browser rendering.
- `sendJson` now emits compact JSON and gzip-compresses responses above 1 KiB
  only when the client accepts it; text static assets receive the same
  treatment. Cache policy remains `no-store`, and PDF bytes are untouched.
  A local mock freight response fell from 9,905 to 1,429 transferred bytes
  with gzip. This reduces transfer size, not the underlying SQL/GCS work.
- Node 22.18.0 `node --test` passed 86/86, including compression negotiation,
  unchanged decoded JSON, and static asset round-trip tests. The bundled npm
  installation is incomplete, so `npm test` could not run; the equivalent
  test command was used locally.
- After the owner's explicit demo-deploy request, fetched `origin/demo`, then
  committed and normally pushed `793bae40c771f1076a013fa04eae31a31971d831`.
  `git ls-remote` confirmed the remote `demo` SHA matched while `main` remained
  at `646949a4b4a8b0d458cc924475e3aace8a545f99`. Automatic Cloud Build
  `ca59471e-d503-42f8-b037-74756fdc538f` passed install, `npm test`, image
  build/push, and `deploy-demo`. Cloud Run revision `printward-demo-00009-7hp`
  received 100% traffic from the `793bae4` image. The Cloud Run configuration
  still showed `PRINTWARD_READ_ONLY=true` and `NSHIFT_FETCH_ENABLED=false`,
  and the private Cloud Shell preview loaded live dashboard counts afterward.
  Browser-observed live compression size has not yet been measured separately;
  the transfer-size ratio above is from the local mock. No nShift call,
  physical print, production deploy, freight job, scheduler, or local agent
  change was made.

## 2026-09-28 demo printing deployment (verified runtime)

- Repository commit `6082d4815b132a89bc9cf72ca1d116ca77e55f02` is on
  `origin/demo`. Cloud Build `9fa0f71b-3bdd-4ac8-9dbb-744474d5ed26` passed
  `npm ci`, `npm test`, image build/push, and deployment. It was started
  **manually** via the enabled `printward-demo` trigger while the push build
  had not yet appeared in the history view. The push did in fact start build
  `966b0071` for the same commit, and a subsequent normal push of docs commit
  `9af1abd6debc85ee3039a982f3d4d9ae122f0bd4` automatically started and
  completed build `88b81192`. Demo push-to-deploy automation is verified;
  allow for Cloud Build history/event-display latency.
- `printward-demo` in `visma-274514/europe-north1` first served print-enabled
  revision `printward-demo-00014-9vd` with image tag matching `6082d48`.
  Runtime identity: `printward-demo-runtime@visma-274514.iam.gserviceaccount.com`.
  It has Datastore User at project scope, object read on `pdf-service-bucket`,
  and accessor on the existing SQL and demo-login secrets. The demo namespace
  is `printward_demo`; this is not an IAM isolation boundary.
- Verified runtime flags: `PRINTWARD_READ_ONLY=false`,
  `PRINTWARD_AUTH_ENABLED=true`, `PRINTWARD_DASHBOARD_PRINT_ENABLED=true`,
  `PRINTWARD_LEGACY_PRINT_ENABLED=false`, `NSHIFT_FETCH_ENABLED=false`.
  Existing SQL/GCS/VPC configuration was preserved. Cloud Run permits
  `allUsers` to invoke **only** this demo service, behind Printward's own login.
  Anonymous requests to `/printward-dashboard.html` redirect (HTTP 303) to
  `/login`; `/login` returns 200; `/api/health` returns 401. The password value
  was not read or recorded. No live nShift or physical print test was run.
- The legacy `Print defaults` page still shows selectable document types, but
  the new dashboard print endpoint ignores those browser defaults and validates
  separate slip-plus-attachment vs. freight-only packets on the server. The
  Windows Print Agent has not changed: its `staple` option only requests
  collation through SumatraPDF; physical stapling depends on the selected
  Windows printer queue/driver. Verify a small real packet and a freight-only
  packet on the office printer before trusting finishing behavior. Do not
  assume the checkbox disables a queue's default staple.
- `printward-prod`, freight jobs, schedulers, and Windows agents were not
  modified. A login-and-live-data check from a user PC is still needed; the
  anonymous checks above do not prove SQL or printer-agent connectivity.
- Successful login previously redirected to `/`, the old Printward view, even
  when the operator requested `/printward-dashboard.html`. The demo-specific
  `PRINTWARD_LOGIN_LANDING_PAGE=dashboard` setting redirects both login success
  and an authenticated `/` visit to the new overview. Its default remains `/`
  outside demo. Commit `294102b4a45de823c4edca21fd79e7469269a4ab`
  includes this fix and a focused auth regression test (local Node 22.18.0:
  90/90 passed). Cloud Build `f5de70b1-dbec-4906-b2d1-7fd5b221ea1b` passed
  all steps and deployed it. At verification, revision
  `printward-demo-00017-hpr` served 100% traffic with that image and
  `PRINTWARD_LOGIN_LANDING_PAGE=dashboard`, `PRINTWARD_READ_ONLY=false`, and
  `PRINTWARD_DASHBOARD_PRINT_ENABLED=true`. Anonymous dashboard access still
  redirected to `/login`. The post-login redirect is covered by the regression
  test, but a real PC login remains to be checked by the user.

### 2026-09-29 office-PC print diagnosis (Krillos)

- The Print Agent on the office Windows PC was reachable at
  `http://127.0.0.1:37951` and reported 14 printer queues. The demo browser
  settings explicitly selected `kf-direkt` with one copy. This is a separate
  Ricoh/NRG MP C4504ex PCL 6 queue on RAW port 9100 to `10.3.3.213`; TCP port
  9100 responded. Windows' system default remained the Zebra label printer,
  which was **not** the printer named in the latest Printward job.
- Demo job for order `1989176` was recorded as `printed`, targeting `kf-direkt`,
  but the office observer reported no paper. Windows PrintService Operational
  had no corresponding spool event around that job. Do not treat this job's
  Printward status as proof of physical output or retry a batch blindly.
- The bundled SumatraPDF version is 3.6.1. A PowerShell no-paper control
  invocation with a deliberately missing PDF produced no usable
  `$LASTEXITCODE` (blank), not a confirmed zero. The previous agent nevertheless
  treated a successfully launched Sumatra process as `printed` without checking
  the Windows spooler. The absence of a PrintService event for order `1989176`
  confirms that its app status is not evidence of Windows spool completion.
- For the next **single-order** smoke test only, the demo browser on Krillos
  retains explicit `kf-direkt`, one copy, simplex, and has its
  `Häfta per order` checkbox unchecked to remove finishing as a variable.
  Recheck/restore finishing after actual output is witnessed and the Ricoh
  queue's staple preference is verified. The Windows default printer and
  SecurePrint setup were not changed. No further physical job was sent during
  this diagnosis; obtain an observer before the next paper test.
- The local repository now has `src/windows-spool.js` and agent integration:
  before launching Sumatra it reads the latest PrintService Operational event
  307 record ID, then waits for a newer 307 on the selected queue before posting
  `printed`. The callback also rejects non-2xx responses. This is Windows spool
  confirmation, **not proof that the Ricoh delivered paper**; another concurrent
  job on the same queue could satisfy the queue-level event check. If the check
  times out, the app gets a failed job with a warning to inspect the queue before
  retrying, because late printing could otherwise cause duplicates.
- On Krillos only, the updated `local-agent.js` and `windows-spool.js` were
  transferred through Chrome Remote Desktop, matched local SHA-256 values, and
  installed in `%LOCALAPPDATA%\PrintwardAgent\app\src`. The original agent was
  preserved as `local-agent.js.pre-spool-20260929.bak`. Only the verified agent
  process listening on port 37951 was restarted. The new process returned
  `/health` with `canPrint:true`, and its Windows spool module successfully read
  existing 307 events. A no-paper, same-record-ID check correctly rejected
  `kf-direkt`. No real document was submitted after this update. The installed
  Windows installer still downloads GitHub `main`; rerunning it before these
  changes are merged would overwrite this Krillos-only hotfix. No GitHub push,
  Cloud Run deployment, production service, default printer, or SecurePrint
  setting was changed. Local Node 22 test suite: 94/94 passed (`node --test`;
  the temporary runtime lacks npm's CLI). A one-order physical smoke test with
  an observer at the printer remains required.

### 2026-10-01 physical staple check and freight-selection fix

- Two single-order follow-slip tests were submitted from `printward-demo` on
  Krillos to `kf-direkt`. The first, with Printward's **Häfta per order** off,
  reached Windows as one two-page job but the observer found the slip stapled
  alone and the attachment separate. The Ricoh queue already had upper-left
  stapling enabled. For the second order, the Printward checkbox was turned on;
  the observer confirmed that slip and attachment came out stapled together.
  This is a printer/driver observation, not a cross-printer guarantee. The
  checkbox adds SumatraPDF `collate`; Windows stapling remains a queue setting.
  Both documents were subsequently marked printed in demo. The observer also
  reported thicker-looking text than Visma output; no font or printer-quality
  setting was changed, and a same-order side-by-side comparison remains to be
  done before attributing the difference to PDF rendering or the driver.
- A proposed two-order Kyl & Frys test found a deployed UI defect before any
  freight job was created: the checkboxes changed visually but the selection
  counter stayed at zero, and **Skriv ut valda** did not respond. In
  `renderFreightList`, a listener was registered for a nonexistent
  `.print-selected` element before the selection handlers. The fix adds
  separate **Granska valda** and **Skriv ut valda** buttons, preserving the
  read-only PDF review and explicit confirmation for real printing. It was
  pushed to `demo` as `ea577d0` and the live lookup showed both controls.
  Orders `1988702` and `1989211` were then printed from Kyl & Frys; the user
  reported good physical output. The demo job showed `printed` and the lookup
  subsequently showed the current pallet generations as printed.
- A first grouping change (`0e2b92a`) combined each order's labels and chilled/
  frozen waybills into one staple section. The real PDF preflight showed one
  section for order `1989251`, and one physical test job reached `printed` on
  `kf-direkt` with `staple:true`. The user confirmed the page order was correct
  but the grouping was wrong: chilled and frozen must be separate stapled
  bundles **within** the order, not one common bundle.
- The correction (`54a6a55`) classifies label pages by their booking number or
  an unambiguous chilled/frozen marker, then creates two sections with each
  label before its own waybill pages. Ambiguous label ownership fails the
  read-only preflight. The real PDF preflight for two-booking order `1989331`
  showed two sections; its one test job reached `printed` on `kf-direkt` with
  `documentCount:2` and `staple:true`. The user physically confirmed two
  correct, separately stapled bundles with the right label first in each.
  No nShift fetch or production deployment was performed for these print
  tests. The latest local Node 22.18.0 suite passed 98/98 (`node --test`; npm
  CLI is absent on this Mac).

### 2026-10-01 DSV booking packets (in progress)

- Edmark reported DSV output unsorted and requested Kyl-style separation.
  Printward's existing DSV rule repeated every page four times, so a multi-page
  PDF would become A A A A B B B B, not complete booking packets. The new
  implementation classifies DSV PDF pages by the exact `FreeInf1.Txt1`/`Txt2`
  booking number, sorts frozen then chilled, and makes one stapled section per
  booking. If a label page exists in the source PDF, it precedes four complete
  waybill copies in that booking's section. No label is synthesized when the
  current `printWaybill` source contains waybills only. Missing or ambiguous
  booking pages fail preflight and the print endpoint closed.
- Read-only live inspection on Krillos of DSV order `1986736` for 2026-10-01
  showed two Visma booking numbers but a one-page freight PDF visibly containing
  only the chilled number. This is evidence of an incomplete stored PDF, not
  proof of why it is incomplete. Freight sync currently skips an existing
  `freight{order}.pdf` without comparing its booking set; a later-added booking
  or a partial allow-list run could explain this. Do not print this order or
  assume the dashboard's document-available count proves both bookings exist.
- Local Node 22.18.0 `node --test` passed 101/101 after the code change and
  focused regression tests. No live nShift call or physical DSV print has been
  made. A real PDF preflight, demo deployment verification, and one observed
  physical order test remain required. Keep this repository state distinct
  from the currently deployed demo until the deployment is checked.

- A later single-booking DSV order `1987752` (booking `200158213419`) was
  physically submitted from Krillos through demo and became `Utskriven` in
  Printward. The observer confirmed four waybill sheets stapled together but
  **no label**. Its source PDF was waybill-only because the sync used
  `printWaybill`; this was not a printer omission. The test therefore proved
  four-copy stapling, not the final label-first packet.
- An explicit one-booking **demo-only** label fetch path is now in local code.
  `NSHIFT_DSV_LABEL_TEST_ORDER_NUMBER` and
  `NSHIFT_DSV_LABEL_TEST_CONSIGNMENT_NUMBER` must match one allow-listed DSV
  order and its only current Visma booking. The SQL query restricts to that
  order before `TOP`; it requires force refresh and rejects a second booking
  before any nShift call. It requests a label using `print` type 1 and a
  waybill using `printWaybill`, merges label first, and rejects missing or
  ambiguous booking/page classification before upload. Test suite: 104/104 via
  Node 22.18.0 `node --test`; npm CLI symlink is incomplete in the temporary
  runtime. This text describes repository state, not a deployed demo job or a
  completed label-inclusive paper test.

- Commit `7c9c3c4` was pushed to `demo`; Cloud Build
  `42195509-e3e6-452e-a6c4-d88210030d7b` succeeded and
  `printward-demo` runs that image. The demo freight-sync job was updated to
  the same image and given existing nShift Secret Manager references, but its
  **default** remains `NSHIFT_FETCH_ENABLED=false`, `NSHIFT_SYNC_DRY_RUN=true`,
  zero retries. A one-execution, SQL-only override for order `1987847`, booking
  `200158214793`, and `2026-09-24` completed successfully with one preview
  result and no nShift/GCS write.
- The one approved nShift fetch override for that same booking (`lh8xn`)
  returned label and waybill pages that passed booking/page analysis, but GCS
  rejected the upload with 403: the job service account's conditional
  `storage.objectAdmin` binding permits only `freight/2/`. The isolated
  `freight/demo-dsv-label-20261001/` prefix was not writable. Therefore no
  test PDF was stored and **no second physical DSV job was submitted**. Demo
  and prod both currently read `freight/2/`; never write the test PDF there
  without separately assessing prod impact. A narrowly conditioned creator
  permission and one explicit retry are awaiting user approval. Do not
  silently repeat nShift `print` or `printWaybill` since they may register
  document history. This status supersedes the earlier local-only paragraph.
- The user explicitly approved a narrow GCS permission and one rerun.
  Conditional `roles/storage.objectCreator` on only
  `freight/demo-dsv-label-20261001/` was granted to the existing job account,
  execution `printward-freight-sync-demo-2lc2g` succeeded, and
  `freight1987847.pdf` was created there (17,250 bytes, generation
  `1790864799114918`). The temporary creator binding was immediately removed
  and confirmed absent; existing production-prefix permissions were unchanged.
  `printward-demo` revision `printward-demo-00028-gkb` temporarily read this
  isolated test prefix. On Krillos, Printward's freight-packet check selected
  exactly order `1987847` and showed one chilled DSV packet with pages 1–2,
  including four copies of the waybill page. The local Print Agent health
  endpoint returned `canPrint: true` and its printer setting was `kf-direkt`,
  simplex, one copy, staple per order. The settings dialog's separate agent
  test timed out while enumerating printers; PowerShell checks confirmed both
  `/health` and `/printers` answered locally. One real print was submitted
  through the Printward UI; the list changed to `Dokument finns · Utskriven`
  for `1987847`. This confirms the app/agent accepted the job, **not** the
  physical page order or staple; the user was asked to inspect the output.
  No second physical job was submitted. Demo was then restored to
  `FREIGHT_GCS_PREFIX=freight/2/` on revision `printward-demo-00029-lgc`,
  which serves 100% traffic; a service describe returned `freight/2/`.
  `printward-prod` was unchanged throughout. The user's photo of the physical
  output shows the label at the front with a staple in its upper-left corner,
  order reference `1987847_Chilled`, and booking `200158214793`. The visible
  label still says `Schenker Finland International` even though the Printward
  group is named DSV Finland; this is an nShift document/template branding
  question, not evidence of a different Printward route. The user subsequently
  confirmed all output was stapled together in one neat packet. The photo and
  confirmation do not separately prove the exact waybill page count. The
  carrier text is part of the nShift-supplied label PDF; Printward does not
  draw or rename it. Check the carrier service/label template in nShift before
  changing printed branding.

### 2026-10-01 release-scope and agent review (local only)

- The user confirmed DSV Finland must keep chilled and frozen in **separate
  stapled booking packets**. The booking-page classifier and packet builder
  implement this and have synthetic tests. The guarded nShift label test now
  accepts one exact allow-listed order with either one booking or an exact
  chilled/frozen pair, fetching label and waybill separately for each before
  merging and verifying. Preflight and printing now require a matching label
  as well as a waybill for every DSV booking; a waybill-only legacy PDF fails
  closed. The synthetic DSV fixtures include label-first pages. No nShift call
  was made for this change. A real two-booking DSV PDF and
  physical output are not yet verified. Do not use the successful single-booking
  label-first test as evidence for that two-booking requirement.
- The first release is intended to cover own-car Tidig/FM/EM packing slip plus
  attachment, Kyl & Frys, DSV Finland and Eriksson freight, required Yama and
  ChopChop packing documents, and pickups. Best Transport waits for its
  integration. Pickup document/template rules, especially the Swish invoice,
  still require confirmation and must not be represented as print-ready.
- Returns should remain in an actionable queue across delivery dates until a
  real print is confirmed or an operator closes them as handled another way.
  The current `/api/returns` endpoint is still date-scoped and return printing
  is disabled; no persistent return disposition has been implemented yet.
  On 2026-10-02 the user showed that Visma prints returns through
  **Orderbekräftelser → Standard formulär 220, Retursedel**. In the open Visma
  Returer view, order **1990006** dated **2026-09-30** has `Gr3=30` and its
  read-only preview renders that exact one-page Retursedel. A subsequent
  single-order test used **Skriv till PDF** and also tried the default
  **Cameyo Virtual Printer**: both opened a PDF in the remote Visma/Cameyo
  Windows session, not on Krillos or in Printward. No physical print was
  verified. This manual UI export is not a verified automated PDF source for
  Printward. Return slips should be printed without stapling, even if future
  templates contain multiple pages. Do not substitute `order{number}.pdf` or
  mark a return printed until its actual print is confirmed.
- The Windows agent spool-confirmation hotfix exists locally and on Krillos,
  but it is not in GitHub `main`. The current installer downloads `main`, so
  running it on another PC today would install the older agent. The agent now
  advertises `spoolConfirmation: true` and the dashboard rejects older Windows
  agents for real printing. Its `/printers` diagnostic gets a longer timeout
  and cannot turn a successful health check into a false "agent not ready".
  The local agent also restricts browser origins to the configured Printward
  URLs; new app URLs require `PRINTWARD_AGENT_ALLOWED_ORIGINS`. The existing
  Windows installer now accepts `-SourceBranch demo` for a controlled update
  of the same per-user agent while retaining `main` as its default; it does not
  create or alter a printer queue. These are local
  repository changes only, not deployed or installed on Edmark's PC.
- Krillos is offline as of this review, so current agent process, printer queue,
  event-log status and physical output could not be rechecked. No print job,
  nShift call, GitHub push, Cloud Run deploy, or Windows installation was made.

### 2026-10-02 demo agent-status guard rollout

- The user requested an urgent, status-safe path for Edmark to test. The agent
  hotfix, Windows spool-event checks, browser guard against older Windows agents,
  and controlled `-SourceBranch demo` installer option were committed as
  `09f17898f2db20be63f37ae0aca949ff98bd9716`. Unrelated local DSV source
  changes were left uncommitted. The remote `demo` SHA was verified to match.
  The local Node 22.18.0 `node --test` suite passed 110/110; `npm` is not on
  this Mac's PATH, so `npm test` itself could not run here. `git diff --check`
  was clean.
- Before the push, `printward-demo` was at revision
  `printward-demo-00029-lgc` with `F0002`, GCS prefix `2/`, demo runtime service
  account, dashboard printing enabled, legacy printing disabled, and nShift
  fetching disabled. The image-only auto-deploy build
  `44ebe025-295c-4788-b7aa-5f228121e18a` succeeded and Cloud Run revision
  `printward-demo-00030-b5q` serves image tag matching `09f17898`. The
  authenticated browser showed real demo printing active and the date-scoped
  2026-09-30 return `1990006` after reload. No nShift or physical print was
  triggered during this rollout; `printward-prod` was not changed.
- Chrome Remote Desktop currently lists Krillos and Kristoffers, but not
  Edmark's PC. Edmark was unavailable at rollout time, so his installed agent
  and printer queue were **not** changed or verified. He must update his
  existing per-user agent from the verified `demo` branch, check `/health` for
  `canPrint: true` and `spoolConfirmation: true`, select his actual printer
  queue, and run one observed order before relying on new status. The dashboard
  now blocks an older Windows agent, but old demo print events remain in
  history; some pre-hotfix `Utskriven` states, notably order `1989176`, do
  not prove paper output. Even the new Event 307 check confirms Windows spool
  completion on the selected queue, not physical delivery; it currently
  matches queue and a newer event ID, so another simultaneous queue job could
  theoretically satisfy the check. Do not use automatic or unattended bulk
  printing as a verification step.
- The return view remains date-scoped and its form 220 print action disabled.
  Return `1990006` appears when delivery date 2026-09-30 is selected, but is
  not yet a persistent cross-date worklist or an actual printed-status flow.

### 2026-10-09 Edmark follow-up (local repository work)

- Own-car Tidig/FM/EM now mean through 08:00, 09:00–10:00, and 13:00–23:00
  respectively. Orders at 11:00 and 12:00 remain outside those quick
  cards and are counted in the caution message; this is an explicit gap, not a
  reassignment. Green ready counts exclude packets whose slip and attachment
  are both already printed; the dark total still includes them.
- Every own-car `DelMt` bundle has a print-ready-only action (at most 200 orders).
  Own-car, freight, and chain rows have an explicit **Visa order** button;
  clicking elsewhere in a selectable row no longer opens details accidentally.
  Closing a detail dialog leaves the lookup and checked selection intact.
  Print-job creation still revalidates every order
  against current server data and requires operator confirmation.
- Yama/ChopChop chain panels and their print authorization now include only
  confirmed remote freight. Own-car orders remain in Tidig/FM/EM and cannot be
  printed again through the chain panel; unknown transport is not assumed to
  be remote. Chain printed/total counts refer only to this remote subset.
- Freight bulk selection and quick printing leave orders with no `Txt1`/`Txt2`
  booking visible but skip them. The overview's freight quick action now
  preflights each order independently on the server and reports skipped order
  numbers/reasons. Missing bookings, missing documents, already-printed
  documents, and incomplete/ambiguous PDFs cannot enter the print job; valid
  orders may proceed. If all fail, no job is created. Multiple selected freight
  orders use the same skip rule; a single selected order stays strict.
  Packet-level PDF verification is unchanged.
  Existing Finland waybill-only PDFs remain blocked from label-first printing.
  The ordinary nShift sync is not yet verified to store label pages for every
  DSV booking; the one-off test path is not a general fix.
- Separate chilled/frozen print buttons are intentionally not enabled yet.
  Printward marks the entire freight PDF generation printed after a job;
  printing one booking alone would incorrectly mark the other temperature
  printed. First add per-booking/section completion state and verify retries,
  counters, and label matching before exposing that choice.
- The read-only SQL join for visible delivery method already uses `Ord.DelMt`
  and `Txt.TxtNo = o.DelMt`, not the customer card. Edmark's report that a
  *printed* order shows the customer's normal route needs a concrete Visma
  order example with before/after values to identify where the assigned
  registration is stored. No alternate field was guessed or substituted.
- Local Node test suite: 116 tests passed using the bundled Node CLI. At this
  local review stage no live nShift call, physical print, Windows agent update,
  GitHub push, Cloud Run deploy, or production change was made. The worktree
  also contained pre-existing staged and unstaged changes; those were preserved.
  Browser QA used a temporary, local read-only mock on port 3111: on
  2026-06-25 a ready order remained selected after its **Visa order** dialog
  was closed; clicking the customer cell did not open that dialog. The local
  server was stopped afterward. The real demo service had not been updated at
  that point; see the rollout below.

### 2026-10-09 Edmark follow-up demo rollout

- The reviewed behavior changes above, along with pending cash-order and DSV
  safeguards, were committed on `demo` as
  `2168bd64b11b02d96f6b376f60a5e2b0f5ad2f57`. The remote `demo` SHA was
  verified after a normal push. `git diff --cached --check` was clean and the
  local Node suite passed 116 tests before the push.
- Before deploying, Cloud Run `printward-demo` was inspected in project
  `visma-274514`, region `europe-north1`. It used the demo printing runtime
  service account, Secret Manager references for SQL and login, SQL database
  `F0002`, GCS prefix `2/`, freight prefix `freight/2/`, Datastore namespace
  `printward_demo`, the existing Serverless VPC Access connector, app login,
  dashboard printing enabled, legacy printing disabled, and nShift fetching
  disabled. The image-only Cloud Build deploy command did not set or replace
  those runtime values.
- Trigger `printward-demo` launched Cloud Build
  `0b7ee1bc-afb5-4bf2-9770-6b96fbc7019c` for that commit. `npm ci`,
  `npm test`, image build/push, and `deploy-demo` all succeeded. Cloud Run
  revision `printward-demo-00032-5d8` received 100% traffic. The login page
  returned HTTP 200, unauthenticated `/api/health` correctly returned HTTP
  401, and the authenticated dashboard loaded live order counts and the new
  Tidig/FM/EM labels. This confirms service availability, not physical print.
- No nShift call, physical print, Windows agent update, production deploy,
  freight job change, or scheduler change was made during this rollout.
  Finland label-first bundles, per-temperature printing/status, the assigned
  registration display on printed orders, and the return worklist remain the
  unresolved items noted above. A Monday operator test should record exact
  order numbers and observed paper/status results before further changes.

### 2026-10-12 freight bulk and sync investigation (local only)

- The server previously rejected the entire overview freight quick-print job
  when any selected order's source PDF failed verification. The local change
  verifies each order separately and includes only complete packets; skipped
  order numbers and reasons are returned to the browser. Explicitly selected
  single-order freight print jobs remain strict; multi-order selections use the
  same per-order skip rule after an explicit warning. No packet's PDF preflight
  was relaxed.
- Code inspection of the normal sync path shows DSV uses the generic
  `printWaybill` operation; only the explicitly allow-listed DSV label test
  fetches and verifies a label and waybill per chilled/frozen booking.
  Non-force sync skips an existing freight PDF without checking whether its
  booking set or labels are still complete. These are plausible explanations
  for missing frozen labels, but no current Finland order or deployed source
  PDF was inspected in this change. Do not auto-refresh or mass-fetch from
  nShift based on this inference: its print operations may have side effects.
- The user's demo screenshot shows `PDF verification failed: No DSV booking
  numbers for order 1993262.` That is a missing-booking preflight failure,
  not evidence of a missing frozen label. A synthetic DSV regression now
  covers that exact order number: the bulk action skips it while retaining a
  separately verified Finland packet. The current Visma/FreeInf1 values for
  1993262 were not independently inspected.
- A second screenshot shows `No verified DSV label pages for Frozen booking…`.
  That is a separate PDF-content failure: a frozen booking exists, but its
  stored PDF lacks a verified matching label page. A synthetic DSV regression
  confirms bulk printing skips that packet and retains another complete DSV
  packet. It does not repair or re-fetch the affected source PDF.
- The freight-job deploy script defaults to `NSHIFT_SYNC_LIMIT=1`,
  `NSHIFT_FETCH_ENABLED=false`, and a candidate limit of ten. This can explain
  slow/no progress **if** the current demo job has those settings. Its live
  configuration could not be read because the Google Cloud console session
  required sign-in. Inspect the current job and scheduler before changing
  cadence or limits; script defaults are not deployment evidence.
- Full local Node test suite: 120 tests passed; `git diff --check` and browser
  JavaScript syntax check passed. No nShift call, physical print, GitHub push,
  Cloud Run deployment, or freight-job/scheduler change was made in this step.

### 2026-10-12 freight bulk demo rollout

- The freight bulk fix above was committed as
  `54a64cdd4828eb3e3f35f1d078a670d2a477df0b` and pushed normally to
  `demo`; `git ls-remote origin refs/heads/demo` confirmed that exact SHA.
  The local Node suite passed 120 tests before the push.
- Before deployment, the existing `printward-demo` Cloud Run configuration was
  inspected in `visma-274514` / `europe-north1`. It used the demo runtime
  service account and existing login/SQL Secret Manager references, SQL
  database `F0002`, GCS prefix `2/`, freight prefix `freight/2/`, Datastore
  namespace `printward_demo`, Serverless VPC Access connector
  `connector-cloudrun-sql`, dashboard printing enabled, legacy printing
  disabled, and `NSHIFT_FETCH_ENABLED=false`. The build deploys only a new
  image; these settings were not supplied from script defaults.
- Cloud Build trigger `printward-demo` ran build
  `47988c05-9aeb-45c8-8df8-bc0d92c5deda` for that SHA. Its `npm ci`,
  `npm test`, image build/push, and `deploy-demo` steps all succeeded. Cloud
  Run revision `printward-demo-00034-d6m` received 100% of traffic and the
  service reported healthy. The Containers view showed image tag
  `54a64cdd4828eb3e3f35f1d078a670d2a477df0b` and the checked demo
  environment values remained in place. `/login` returned HTTP 200 and
  unauthenticated `/api/health` returned HTTP 401, as expected.
- This is an availability and configuration check, not a physical print or a
  proof that existing Finland source PDFs contain labels. No nShift call,
  Windows agent update, production deploy, freight-job change, or scheduler
  change was made. Incomplete freight packets remain skipped with reasons;
  obtaining missing verified DSV labels is still unresolved.

### 2026-10-12 DSV source repair (local repository work)

- The user accepted repeat nShift document retrieval if Printward's printed
  state remains accurate. Normal DSV sync now requests a PDF label and waybill
  per chilled/frozen booking, verifies each booking's label and freight pages,
  and uploads only a complete combined PDF. Other carriers retain their sync
  path. Orders without booking numbers stay visible but are skipped by bulk
  printing; they cannot be fetched from nShift by this job.
- `NSHIFT_DSV_REPAIR_EXISTING=true` is opt-in and defaults false. It reads the
  existing DSV PDF at its generation and refetches only if current bookings
  lack a verified label or waybill. A failure leaves the GCS object intact.
  A changed upload gets a new generation, which Printward treats as needing
  printing; old printed status does not automatically transfer. The DSV card
  now labels its count "med PDF (ej verifierade)" because PDF presence alone
  is not a complete packet.
- Local Node suite passed 123/123 tests with synthetic PDFs and fake
  nShift/storage; `npm` is not available on this Mac, so the equivalent
  `node --test` command was used. `git diff --check` was clean. No nShift call,
  Cloud Run job change, demo deploy, GitHub push, or physical print has been
  made for this change. Before any rollout, inspect the live freight job and
  account for the fact that `freight/2/` is read by production too. The code
  and opt-in flag alone do not repair the existing Finland source PDFs.

### 2026-10-12 DSV source repair rollout and checks

- With the user's approval, commit `28d327e25f30207700bef80ed7120606f54da8a2`
  was pushed normally to `demo` after a fetch; `git ls-remote` confirmed the
  remote SHA. Cloud Build `9285d174-2d4d-445c-b8aa-2ffa2d5a7367` succeeded.
  `printward-demo` revision `printward-demo-00036-tbm` runs that image with its
  existing demo runtime service account. The existing public demo URL returned
  HTTP 200 for `/login` and HTTP 401 for unauthenticated `/api/health`.
- The current `printward-freight-sync` job was inspected before update. It was
  already scheduled every five minutes with live nShift fetching, output prefix
  `freight/2/`, limit 50, and zero task retries. Only its image was changed to
  the same tested SHA and `NSHIFT_DSV_REPAIR_EXISTING=true` was added; its
  `webshop-api` service account, `node src/freight-sync-job.js` entry point,
  and existing settings were retained. The job still writes to `freight/2/`,
  which production also reads. Neither `printward-prod`, the scheduler, nor a
  Windows agent was changed.
- The first scheduled execution on the new image,
  `printward-freight-sync-9jl8b`, completed successfully at
  `2026-10-12T08:46:23Z` (1m18s). Its summary was 215 shipments checked,
  25 PDFs uploaded, 190 skipped, zero failures. GCS generation timestamps
  showed fresh PDFs for previously failing Finland orders 1993020, 1993099,
  and 1993262 at approximately 08:45 UTC. Each DSV PDF was validated against
  its current chilled/frozen booking set before upload by the new sync path.
  This is source-document evidence, not proof of a physical print. The user
  was asked to refresh demo on W10 and try the Finland print; paper output and
  printed-status correctness await their observation. Orders without booking
  numbers remain visible and are skipped by bulk printing.

### 2026-10-12 freight status clarity and failed-batch accounting (local only)

- The owner supplied 20 route-47/48 Finland order numbers for 2026-10-12 and
  clarified that the `9` visible in another Visma window is unrelated to this
  Printward problem. Do not use that value to explain the missing-booking
  warnings. Printward still reads booking numbers using its existing
  `FreeInf1.Val1 IN (2,8)` filter, but the cause of the current warnings has
  not been established. Compare the actual booking fields returned for an
  affected order before changing this filter or the upstream integration.
- Read-only demo state inspection found two failed Finland mass jobs: the first
  contained 18 unique orders, the next 16. Orders `1991441` and `1991391`
  appeared in neither; `1993020` and `1993099` appeared only in the first.
  A separate job for `1993020` was recorded as printed. Both mass jobs failed
  because Windows did not confirm a completed spool event on `printwarddirekt`.
  Neither job record retained which of its sections physically produced paper.
- Locally, Kyl & Frys, DSV Finland, and Eriksson now all say **med PDF**. That
  number is file availability only. A separate count shows current-generation
  print events registered by Printward and the number without an eligible
  booking. Freight lookup rows display PDF/print status even if booking
  eligibility disappears; the warning remains and new printing stays blocked.
- The state stores now accept a failed agent callback's ordered, spool-confirmed
  section results. They mark a document printed only if **all sections of that
  order** appear in the confirmed prefix. A partly confirmed chilled/frozen
  order stays unprinted. The job itself remains failed. The browser refreshes
  status after an agent failure as well as success. These changes cannot
  reconstruct the missing per-section results of older failed jobs or establish
  which sheets were physically collected at the printer.
- Local Node test suite passed 127/127 using the bundled Node CLI; the host has
  no working `npm` binary. No live nShift call, physical print, Windows agent
  update, GitHub push, Cloud Run deployment, freight job/scheduler change, or
  production change was made for this local correction. Before deployment,
  inspect current demo config and obtain authorization for the separate rollout.

### 2026-10-13 own-car grouping and dashboard refresh (local only)

- The owner clarified that the quick cards use each order's current `DelPri`:
  Tidig through 08:00, FM 09:00–10:00, EM from 13:00 through 23:00. `DelPri` 11:00
  and 12:00 remain outside the quick cards, but in Alla order. The own-car
  `DelMt`/registration matching is unchanged and is read again after routing.
- The visible dashboard checks the selected date every two minutes, except
  while printing, reviewing, selecting, or in a dialog. Background refresh
  preserves checked rows and prior data on failure. The browser shows when it
  last fetched data or that an update failed. `refresh=auto` waits for an
  expired order cache rebuild and concurrent requests share it; an unexpired
  cache is reused. Manual update still forces a rebuild. This is read-only
  polling of Printward/Visma context and stored document metadata, **not** a
  new nShift fetch, GCS upload, print job, or change to freight sync cadence.
- Freight overview cards show only the numbers, without `med dokument` or
  `med PDF (ej verifierade)` suffixes. The separate registered-print count
  remains; presence of a stored PDF is not proof of verified pages or paper.
- Local Node suite passed 130/130 tests (`npm` is unavailable on this host;
  bundled Node ran `node --test`). No GitHub push, Cloud Run
  deployment, Windows agent update, live SQL/nShift call, or physical print
  has been performed for this work. Live morning speed and two-minute behavior
  must be verified after an explicitly authorized demo rollout.

### 2026-10-13 dashboard batch progress and manual recovery (local only)

- Each dashboard print job retains its existing per-order/per-temperature section
  boundaries and original document snapshot. The updated local agent reports a
  confirmed section after each Windows spool event; the server counts both
  completed sections and **whole** completed orders. This applies equally to
  Kyl & Frys and DSV Finland. A partially confirmed chilled/frozen order is
  not marked printed and is included from its first section on manual resume.
- The dashboard shows a live job counter (sections and whole orders), including
  the next order. It remembers the latest job ID in that browser so its status
  can be read after a reload. A failed dashboard job exposes a manual
  **Återuppta återstående order** action with an explicit paper-check warning.
  The server creates one new job containing only unconfirmed whole orders from
  the *original snapshot*, with a fresh callback token, and rejects a second
  resume of the same failed job. If the resumed job fails, resume that child.
  Legacy whole-job retry is unchanged and must not be used for partial batches.
- Windows spool confirmation is **not physical paper confirmation**. A jam or
  delayed output requires the operator to inspect the printer and printed
  stack before manually resuming. No automatic retry, live nShift fetch,
  physical test, or Windows agent update occurred. An agent without the new
  `progressReporting` capability can still print via its prior behavior but
  cannot show intermediate counts; update each PC separately at rollout.
- `npm test` could not run because this host has no `npm`; the bundled Node CLI
  passed 134/134 tests, including token-gated progress, Finland partial-order
  recovery, and snapshot-preserving resume. No GitHub push or Cloud Run deploy
  has been done. Before deployment, review changes with the owner and confirm
  target demo configuration; the owner explicitly wants to speak with Edmark
  first. Production remains untouched.

### 2026-10-13 overview status split and print preparation (local only)

- Tidig/FM/EM cards now show ready now, registered printed, not yet ready, and
  the total separately. The server computes a `printed` count only when both
  slip and attachment have registered print status; it preserves the old
  `waiting` field for compatibility. The browser derives not-yet-ready as
  total minus ready minus printed. The lookup states explicitly that
  registered printed is spool-confirmed status, not proof of physical paper.
- The local agent now downloads and (on Windows) merges the upcoming two
  section PDFs in separate per-section temporary folders while the current
  section is printing. At most three sections are in flight, and failed
  prefetches abort safely when reached. This reduces preparation gaps but
  preserves one Windows spool job per section for independent stapling and
  the existing per-section Event 307 confirmation. The printer's own pause
  between jobs is not eliminated. No live printer validation has happened.
- Bundled Node tests passed 136/136. `npm` remains unavailable on this Mac.
  No GitHub push, demo/production deploy, or Windows-agent update has occurred.

### 2026-10-13 dashboard count wording (local only)

- The upper-left count is now labeled **Alla order**: it includes every order
  in the selected date's source data, even one outside the visible print
  groups. In the mock preview, two source orders but one own-car print order
  are therefore expected, not a duplicate count.
- Tidig/FM/EM say **X redo för utskrift av N order**. Tracked Kyl & Frys,
  DSV Finland, and Eriksson cards instead say **X av N order utskrivna**;
  the large number is the registered Printward print count, not merely the
  number with stored PDF. The smaller line shows orders remaining and any
  missing freight document or booking. This changes presentation only, not
  eligibility, printer behavior, or print-event semantics.
- No GitHub push, demo/production deploy, Windows-agent update, or physical
  print was performed for this wording change.

### 2026-10-13 demo deployment and follow-up (verified)

- Owner approved deploying the dashboard/status and recoverable-job changes to
  demo for testing. Commit `a67d80456ce3f6be8ac50ede8e825f5b2df6a99d` was
  pushed to `origin/demo`; `git ls-remote` confirmed the same SHA. Cloud Build
  run `d98c24d3` for the `printward-demo` trigger completed successfully, and
  the Cloud Run `printward-demo` container in `europe-north1` showed the image
  tag `a67d80456ce3f6be8ac50ede8e825f5b2df6a99d` as healthy and serving.
- Before deployment, the live demo service was checked: SQL Server order
  context, Datastore state, app login, and dashboard printing were enabled;
  nShift fetching, cache warmup, and legacy printing were disabled. The live
  dashboard subsequently showed the new own-car ready/printed/remaining
  wording and Kyl & Frys registered-print count. An unauthenticated `/api/health`
  request returned 401 because app authentication is enabled. No physical
  printing, live nShift fetch, freight scheduler change, production deploy, or
  Windows-agent update was performed. The new per-section progress/preparation
  features require a separate Windows-agent update on each PC.
- Local bundled Node CLI passed 136/136 tests and `git diff --check` passed;
  `npm test` was unavailable on the Mac because `npm` is not installed there,
  while the successful Cloud Build ran `npm ci` and `npm test` before deployment.

### 2026-10-13 dismissible print progress (local work)

- After the demo test, Edmark reported that the fixed progress panel kept
  covering the screen even after the print count updated. The panel now has a
  dismiss button that does not cancel the print job. It stays expanded during
  printing, condenses to a small status line after spool confirmation, and a
  failed run reopens the full panel so manual recovery is visible. A completed
  run is cleared from browser persistence and will not reappear on reload;
  active/failed runs still restore.
- The Ricoh may still pause between individual Windows spool jobs. The agent
  deliberately keeps per-order/per-temperature sections separate for correct
  stapling. This UI change does not merge those spool jobs or change the agent.
