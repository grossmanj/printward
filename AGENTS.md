# Working on Printward

Read [README.md](README.md) for setup and operations, then
[docs/agent-handoff.md](docs/agent-handoff.md) for the current business rules,
architecture, verification coverage, and operational caveats. These instructions
apply throughout this repository.

## Development

- Use Node.js 20 or newer, ES modules, and the committed npm lockfile. Run `npm ci`
  on a fresh checkout and `npm test` before handing off behavioral changes.
- The app uses Node's HTTP server and plain browser JavaScript; there is no
  frontend build step. Use `npm run dev` for mock mode and `npm run agent` for the
  separate local printing process.
- Keep SQL access read-only. Preserve the order/line filters and packing rules in
  `src/orderContext.js`; they encode warehouse requirements.
- Keep browser eligibility rules in `public/app.js` aligned with the authoritative
  rules in `src/documents.js` and `src/server.js`. Preserve the early external
  freight exception without marking an unfinished order fully ready.
- Preserve document source and GCS generation through snapshots, downloads,
  retries, and completion. A retry intentionally uses the original snapshot.
- Kyl pallet bundles need dynamic page classification and separate print sections.
  Do not replace this with fixed page offsets or pallet-count-based duplication.
- Add focused regression coverage for changes to document requirements, PDF
  sections, SQL filters, job authorization, or sync behavior. Existing test files
  are mapped in the handoff; do not use live nShift or physical printing as tests.

## Operations and handoff

- Keep secrets, customer PDFs, local state, logs, and temporary diagnostics out of
  commits. `.gitignore` excludes `node_modules/`, `tmp/`, and
  `data/printward-db.json`; other sensitive files still need deliberate exclusion.
- nShift print calls may have side effects. `NSHIFT_SYNC_DRY_RUN=true` suppresses
  GCS writes but still calls nShift when fetching is enabled. For a no-call preview,
  keep `NSHIFT_FETCH_ENABLED=false`. Preserve allow-list gates and zero job retries.
- GitHub pushes, Cloud Run deployments, freight job deployments, scheduler changes,
  and Windows agent updates are separate operations. Execute only the operations
  within the user's request; do not infer deployment from a request to push code.
- Check the target environment and existing runtime configuration before deploying.
  Script defaults target demo and do not prove what is currently deployed.
- Preserve unrelated working-tree changes. Fetch before pushing, use normal
  fast-forward pushes, and verify the remote branch SHA afterward. Do not force-push
  shared history to resolve divergence.
- Update the README and handoff when behavior or operational requirements change.
  Record actual checks, unresolved limitations, and deployment evidence; distinguish
  repository state from live service state. Do not leave important decisions only
  in a chat transcript.
