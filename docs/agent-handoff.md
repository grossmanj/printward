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
- Each label is its own print section, followed by frozen freight, cooling freight,
  and finally slip plus attachment together when packing permits. Sections use
  selected pages from the original bundle; never assume fixed page counts.
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
  update an installed agent. Pushing or deploying the web app does not update PCs.
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
