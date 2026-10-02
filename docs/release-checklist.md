# New Printward: first-release checklist

This is a scope and evidence checklist, not a claim that local code has reached
Cloud Run or an office PC. Best Transport and automatic order-cutoff printing are
outside the first release.

| Flow | Current evidence | Before first release |
| --- | --- | --- |
| Own cars Tidig/FM/EM | Real slip + attachment printed together from demo on Krillos; server rechecks readiness and printed generation | Verify representative FM and EM orders and the actual post-routing vehicle text |
| Kyl & Frys | Real chilled/frozen order produced separate label-first, stapled booking packets | Confirm the chosen printer queue on each operator PC |
| DSV Finland | One real chilled booking printed label-first and stapled; synthetic two-booking tests pass | Verify one real chilled **and** frozen order, both labels and waybills; resolve the nShift label's "Schenker Finland International" text |
| Eriksson | Route 25 and 49 grouping and Kyl-style packet logic are tested in code | Verify a real PDF, departure sorting, and one observed print; carrier name on label remains a separate nShift/template decision |
| Sushi Yama / ChopChop | Server-validated slip + attachment print path exists | Check real readiness/status and an observed print for each chain |
| Hämtningar, bud/taxi, personal | Live grouping exists; print is intentionally disabled | Agree the actual document for each type; Swish must use an invoice template, not a packing slip; then add and test printing |
| Returer | Live `Gr3=30` read exists for one selected date; print disabled. Visma uses Orderbekräftelser, standardformulär 220 ”Retursedel” | Obtain a PDF of that exact form through a verified Visma export/print source, then implement persistent cross-date worklist and explicit close actions |
| Print Agent | The existing Printward agent on Krillos has a local spool-confirmation hotfix; source changes and tests exist locally | Bring Krillos online, compare installed agent with source, confirm printer/Event 307 and callback. Update existing Edmark agent in place only after the tested code is on the chosen branch |
| Production rollout | `demo` auto-deploy is verified; `printward-prod` unchanged | Owner review/PR to `main`, capture current prod configuration, agree scoped rollout and rollback, verify auth and one controlled smoke test |

The local code currently requires a matched DSV label and waybill for every
booking. That intentionally blocks legacy waybill-only PDFs. The guarded
two-booking label acquisition path has no real nShift or physical test yet.
Printward currently recognizes only `order`, `parti`, `pallet`, and `freight`
PDFs; the screenshot of Visma's form 220 identifies the required return form,
but does not by itself provide a server-side PDF source for Printward.
Never infer that a passed local test, a pushed branch, a deployed demo revision,
and an installed Windows agent are the same state.
