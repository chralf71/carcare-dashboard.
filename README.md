# CarCare daily dashboard

The dashboard reports one shop's daily financial activity in `America/Chicago`. It uses server-side Tekmetric requests and returns aggregates only. No customer records are returned to the browser.

## Runtime and configuration

Requires Node.js 22 or newer with built-in `fetch`, `Intl`, and the Node test runner. There are no package dependencies. Use a serverless host that maps `api/*.js` to `/api/*` with the existing CommonJS `(req, res)` interface and serves `public/index.html` at `/` and `public/dashboard.js` at `/dashboard.js`. A static file server alone cannot execute API handlers.

Set these variables in the server environment (see `.env.example` for empty placeholders):

- `TEKMETRIC_BASE_URL`: exactly an HTTPS origin at `sandbox.tekmetric.com` or `shop.tekmetric.com`. A trailing slash is allowed. Paths, alternate ports, credentials, query strings, and redirects are rejected.
- `TEKMETRIC_CLIENT_ID`, `TEKMETRIC_CLIENT_SECRET`: server-only credentials.
- `TEKMETRIC_SHOP_ID`: positive decimal shop ID, never selected by the browser.
- `ENABLE_DIAGNOSTICS`: defaults off; only the exact string `true` enables legacy diagnostic URLs.

No deployment or environment changes are made by this repository's test command.

## Daily definitions

`GET /api/dashboard-summary?date=YYYY-MM-DD` defaults to today's Chicago calendar date if date is omitted. Invalid dates return HTTP 400. Dates are limited to years 1900–9998.

Repair orders are fetched separately for status 5 (Posted) and status 6 (Accounts Receivable), using `shop`, `postedDateStart`, `postedDateEnd`, `page`, and `size=100`. A broad UTC interval runs from midnight the day before the selected date to midnight two days after it. Every returned posted date is validated and only records matching the selected Chicago calendar date qualify. This accommodates uncertain inclusive/exclusive query boundaries without using fixed Chicago offsets.

A timestamp must contain `Z` or an explicit offset. A date-only `postedDate` is treated as an accounting date and preserved. Offsetless timestamps are rejected. API acceptance of ISO UTC filter values and the date-only accounting-date interpretation still require live reconciliation.

The distinct RO population includes both Posted and Accounts Receivable; it does not filter by payment receipt, positive sales, advisor, completion date, or authorization date. Other statuses are rejected. Missing financial fields are never assumed to be zero.

- **Daily sales in cents:** sum `laborSales + partsSales + subletSales + feeTotal - discountTotal`. Taxes are excluded by the documented fields; discounts are subtracted once. Job totals are not added. Integer cents are accumulated with `BigInt` and checked for safe JSON numeric representation.
- **RO count:** distinct qualifying RO IDs across both status queries.
- **Average RO in cents:** aggregate sales divided by distinct RO count. Fractional cents are retained until frontend currency formatting. An empty day has no ARO.
- **Hours sold:** fully paginated `/api/v1/jobs` requests for each qualifying RO, with `shop`, `repairOrderId`, `authorized=true`, `page`, and `size=100`. Returned jobs must have `authorized: true` and a boolean `archived`; archived jobs are excluded. Job and labor IDs are deduplicated globally. Non-archived jobs require a labor array; entries require IDs and finite, nonnegative numeric hours. `labor.complete` and `selected` are not used as filters. No labor rate is used to infer hours or costs.
- **Gross profit dollars/percentage:** always unavailable with “Cost data not available through the verified API”. No partial parts-only profit is presented.

API metric entries have `{ available, value }` and, when unavailable, a safe `reason` with `value: null`. Currency conversion to dollars happens only in the frontend. Validated empty results produce zero sales/count/hours; ARO and gross profit stay unavailable.

## Validation and request limits

Both endpoints must return a page envelope with `content`, `number`, `size`, `totalElements`, and `totalPages`. Page size must equal 100, totals must be nonnegative integers, and page counts/row counts must agree. Empty results use `totalPages: 0`. Missing metadata, incomplete pages, repeated page IDs, changing totals, contradictory duplicates, and page-limit failures yield unavailable data. This strict contract is an explicit assumption to verify against actual responses; there is no array-length count fallback.

RO status is read from `repairOrderStatus.id`. A duplicate moving between 5 and 6 is counted once when its date and monetary fields agree. Conflicting values cause unavailability. Job-to-RO association uses the request filter and additionally checks `repairOrderId` when returned. Stable job/labor IDs are required; their global uniqueness should be confirmed during reconciliation.

The client shares one token request across each summary invocation. It does not cache tokens between invocations because token lifetime semantics have not been verified. Each upstream request has an 8-second timeout; an invocation has a 45-second upstream budget. Pagination is capped at 1,000 pages per query. RO status concurrency is 2 and job concurrency is 4. Limits cause unavailability, never truncated totals. There are no automatic retries.

Job failures leave validated sales/count/ARO available but make hours unavailable. Invalid/incomplete RO data returns HTTP 503 with all daily metrics unavailable. Errors never forward upstream payloads or credential details. The frontend serializes refresh requests, skips timer overlap, aborts superseded dates, and checks request generation before rendering. Failed or pending refreshes clear old values to prevent stale figures being mistaken for current data.

## Diagnostics and production access

`/api/test-token`, `/api/shops`, `/api/employees-test`, `/api/repair-orders-test`, and `/api/repair-orders-sample` return 404 by default. If explicitly enabled, all are connectivity-only checks returning `{ connected: true }` or a generic failure. They no longer list shops, employees, fields, tokens, or sample records.

**Production access protection remains required.** This application does not implement login or a rate-limit service. Before exposing real financial data, put the page and every API route behind an identity-aware access gateway or server-validated sessions, use an explicit staff allowlist and MFA, and protect preview deployments. Keep diagnostics disabled outside protected administrative use. Configure platform rate limiting; request concurrency alone is not rate limiting across visitors. Store credentials only in server secret storage and never commit `.env` or private API fixtures.

## Tests and release acceptance

Run `npm test` or `node --test test/*.test.js`. Tests use synthetic records and mocked transport only; no Tekmetric account or credentials are needed. Coverage includes pagination, statuses 5/6, duplicate ROs/jobs/labor, malformed fields, exact cents and discounts, empty days, Chicago midnight/DST boundaries, unavailable hours, timeouts, host restrictions, diagnostics, sanitization, concurrency, and stale browser responses.

Before production, compare the five cards against Tekmetric End of Day for the same shop/date, including A/R, fees/discounts, a multi-page day, empty days, and midnight records. Confirm filter encoding, page envelope, status shape, and ID semantics. Reopened/reposted/deleted orders and refunds can affect historical reconciliation; this implementation uses the current 5/6 population and posted dates, without inventing adjustment rules. Historical days are recomputed on refresh. Labor/sublet costs remain unverified and gross profit remains unavailable.

## Phase 2: daily service advisors

The existing top-level `metrics` response is preserved. `/api/dashboard-summary` adds `advisorReport` with `status` (`complete`, `partial`, or `unavailable`), `directoryStatus`, `selectionMode: "all"`, `rows`, and `reconciliation`. Each row contains only a stable key, employee ID (or null for exception buckets), display name, assignment status, and the same aggregate metric entries as the shop cards. No RO/job records or employee contact fields are serialized.

The default is all advisors observed on qualifying ROs for the selected Chicago date. There is no selection filter, production-specific ID/name matching, or additional environment variable. Production and sandbox each use their own shop employee directory. No zero-order employee roster is displayed; a verified empty day has no advisor rows. An observed zero-sales RO still contributes one RO and a zero ARO.

RO `serviceWriterId` joins to employee `id`. Positive integer IDs and positive decimal strings are accepted. Null/missing IDs appear under **Unassigned**; malformed IDs and conflicting assignments on duplicate ROs appear under **Invalid assignment**. Unmatched valid IDs are displayed separately as **Unknown advisor** with their ID, but only after the employee directory is fully validated. An employee-directory failure instead produces **Advisor name unavailable**, retaining the ID and valid allocated figures. Exception buckets appear only when applicable. Disabled employees are not excluded from historical activity, and matching never relies on a name or inferred employee role.

`GET /api/v1/employees` uses the same client, token, shop filter, strict pagination envelope and size 100 as other requests. It runs after the shop dataset is obtained, within the same 45-second upstream budget, so a directory failure does not invalidate shop figures. Failed concurrent job workers finish before employee retrieval starts; new jobs stop scheduling after a failure. Names require string `firstName` and `lastName` with a nonempty combined display name. Employee endpoint pagination, field types, shop association, and whether disabled employees are included require live sandbox verification. Unexpected structures make the directory unavailable; no alternative undocumented response shapes are guessed.

Advisor sales and count partition the shop's already deduplicated RO population, including all exception buckets. ARO is calculated from each group's aggregate sales/count, not averaged across ROs. Jobs retain their parent RO association. Approved, non-archived hours are deduplicated by job/labor ID. If a job or labor ID appears under multiple parent ROs, advisor hours are unavailable for the report rather than assigned arbitrarily; independently valid shop hours retain Phase 1 global deduplication behavior. Failed job data also leaves advisor hours unavailable. Gross profit always remains unavailable with the existing verified-cost explanation.

Reconciliation checks sum sales cents and RO counts with integer arithmetic and reports `matched`, `mismatch`, or `unavailable` per metric. Hours use unrounded values and a tolerance of `1e-9 * max(1, abs(advisor sum), abs(shop hours))`. ARO and gross profit are not summed. Unknown/invalid assignments keep the report partial even if monetary reconciliation matches. Directory failure keeps the report partial with accurate numeric reconciliation where possible.

The responsive advisor table shares the existing refresh generation guard, clears stale rows, renders names with `textContent`, and shows reconciliation status. The output directory remains `public`; root `api`, `lib`, and `vercel.json` retain their deployment roles. Diagnostics remain disabled by default; do not enable them for advisor discovery.

Additional synthetic tests cover status allocation, discounts, repeated RO/job/labor IDs, conflicting ownership and advisor assignments, missing/unknown/invalid IDs, employee pagination/failure, duplicate names, disabled employees, zero-order days, zero-value ROs, exact/tolerant reconciliation, privacy, and safe rendering. Before production, validate employee schemas and ID uniqueness in sandbox, and establish whether historical `serviceWriterId` reflects the advisor at posting or subsequent reassignment. No historical attribution rule is inferred.

## Phase 3: technician job reporting

Two independent requests preserve the shop/advisor response and calculations:

- `GET /api/technician-summary?report=completed&date=YYYY-MM-DD`: **Completed on [date]**, with **Hours on jobs completed** and distinct completed-job count. The date defaults to today in America/Chicago. The population consists of jobs where `authorized=true`, `selected=true`, `archived=false`, and the job's `completedDate` falls on that Chicago day. All labor-line hours on those jobs are included, whether the line is currently complete or incomplete. This metric is not labor completed that day. RO posted dates are never used.
- `GET /api/technician-summary?report=current`: **Current Tech Board**, with incomplete assigned hours and active-job count. Parents are current RO statuses 1 Estimate, 2 Work in Progress, and 3 Complete. Jobs must have `authorized=true`, `selected=true`, and `archived=false`. Only labor with `complete=false` contributes hours; a job contributes one active-job count when it has at least one incomplete labor line (including a zero-hour line). No job `complete` field is used. Date query parameters are ignored in this mode.

No completion-date query filters have been verified, so the completed report fully paginates shop jobs and filters locally. Timestamp values must contain an explicit timezone; date-only or offsetless job completion values are unavailable rather than treated as posted accounting dates. Explicit null means not completed; an absent completion field on an otherwise eligible job is invalid. Chicago DST/midnight behavior uses the existing validated date helpers. Historical results reflect current API values and eligibility flags, not an immutable completion-event ledger: later job edits/reopening/reassignment can change historical results. Labor lines have no completion date, so labor completion timing cannot be inferred.

Hours prefer the labor-line technician ID. **An explicit null labor technician ID falls back to the job technician ID**, per the approved allocation rule. An absent labor assignment remains Unassigned; a malformed one goes to Invalid/conflicting assignment. Job counts always use job technician ownership, including shared jobs whose labor belongs to several technicians. Thus an observed technician can have hours with zero jobs or jobs with zero hours. Assignment IDs join to the existing complete employee directory; there are no production-specific IDs, runtime name matches, selectors, or new environment variables. Unknown IDs and directory failures are labeled separately. All observed owners and necessary exception buckets appear.

Identical jobs and labor lines deduplicate by ID. Conflicting assignments with otherwise identical quantities go into the invalid/conflict bucket. A labor ID shared by multiple eligible jobs is counted once in the conflict bucket, rather than assigned twice. Conflicting quantities, states, completion dates for duplicate jobs, or parent ownership invalidate the affected entire report. Missing/invalid required numeric/boolean fields invalidate the report. Explicit null eligibility flags do not meet the required true/true/false predicate and are excluded. Completed labor does not require a `complete` field because that report is based on job completion; current-board labor requires a boolean `complete`.

Both successful responses contain `report`, `timezone`, `startedAt`, `asOf`, and `technicianReport`; completed additionally contains `date`, while current contains `historical: false`. `technicianReport` contains `status`, `directoryStatus`, `selectionMode: "all"`, `rows`, `totals`, and `reconciliation`. Rows expose only key, minimal employee ID/name, assignment status, and `{ hours, jobCount }` metrics using `{ available, value }`. `totals` use the same metric fields. Unavailable results contain null totals and a sanitized reason, with HTTP 503. Employee lookup failure preserves complete numeric results and labels names unavailable (`status: partial`). Reconciliation is exact for job counts and uses `1e-9 * max(1, abs(total hours), abs(row sum))` for hours. These reconcile within each technician population, not to posted-date shop/advisor financial hours.

Retrieval limits are fixed server-side constants, not new environment variables: at most 10 pages per job/RO query at size 100, 200 distinct current parents, and 64 data requests per report plus one shared authentication request. Reaching a cap before traversal completes makes the entire report unavailable, including when the data-request cap is reached during employee lookup. No partial totals are returned. Existing 8-second request timeouts and 45-second per-client budgets apply; parent status requests use concurrency 2 and job requests use concurrency 4. Technician requests are independent of shop/advisor requests, so an expensive scan cannot fail the existing report. Large shops may see an unavailable completed report until a documented completion filter or bounded historical synchronization is added.

The UI refreshes completed and current tables independently with the shared serialized/stale-response loader. Changing the historical date refetches only the completed table: the current board remains unchanged. Manual refresh and the two-minute timer refresh the board with a new as-of timestamp. The snapshot consists of sequential/concurrent API reads between `startedAt` and `asOf`, not an atomic database snapshot. Old rows clear while a report refreshes or fails. Responsive tables use safe text rendering. No separate remaining-hours, clocked-time, efficiency, or technician profit metric is provided.

This branch does not contain the temporary schema-probe endpoint. Existing diagnostic defaults, environment placeholders, and Vercel configuration remain unchanged. Before using figures operationally, reconcile representative sandbox jobs with the board, confirm job completion timestamp encoding, and review historical mutation behavior and retrieval volume. No individual record timestamps, RO/job/labor records or IDs, contacts, notes, customer data, tokens, or credentials are returned by the technician endpoint.
