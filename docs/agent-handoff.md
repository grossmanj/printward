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
  pickup), `16` (courier), and `42`–`46` (taxi). `Actor.CPmtTrm=1` adds a Swish
  badge only to customer pickups. The actor value is read with the same first
  customer actor lookup as the customer name; verify this against real Visma
  examples before relying on it operationally. `Actor.R12=60` together with
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
  investigate scheduled printing at route-specific order cutoffs. Already
  printed *document generations* must be skipped; queued/created jobs are not
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
