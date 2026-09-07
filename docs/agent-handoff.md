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
| `public/app.js`, `public/index.html`, `public/styles.css` | Browser UI; filtering, grouped dispatch slots, settings, history, retry, live updates |
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
