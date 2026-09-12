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

## Temporary Phase 3 sandbox schema probe

**Remove `api/technician-schema-test.js` after schema validation.** This is not a technician dashboard or a complete shop report. `GET /api/technician-schema-test` works only when the parsed `TEKMETRIC_BASE_URL` hostname is exactly `sandbox.tekmetric.com`. Other or unparseable hosts return HTTP 403 before authentication. Existing HTTPS/origin validation still rejects insecure URLs, credentials in URLs, paths, and alternate ports. Non-GET requests on the sandbox return 405. Failures return only `{"error":"Schema sample unavailable"}` with HTTP 503. All responses set `Cache-Control: no-store`.

Verified documentation supplied for this phase establishes job `technicianId` and `completedDate`, and labor `technicianId`, `hours`, and `complete`. No labor `completedDate` is documented. Observing a field does not establish its semantics or authorize using it for historical metrics.

The probe reads one validated page of at most three parent ROs, then one page of at most three jobs per distinct parent. It inspects at most the first 30 labor entries per sampled job (maximum nine jobs and 270 labor lines). The sample is determined by upstream default ordering and is not representative of every status. It intentionally does not traverse all pages; `sampleOnly` is always true and `sampleTruncated` reports records/lines omitted by these limits. It reuses shared page-envelope validation (`readPage`), deduplication, ID validation, authentication, and concurrency controls. Conflicting duplicate associations or malformed required envelopes/records fail closed.

Request limits: at most five upstream requests (one token, one RO page, up to three job pages), two concurrent job requests, four-second per-request timeout, and twelve-second shared upstream budget. No retries and no user-controlled sampling parameters. These are per-invocation caps, not a global rate limit. No other diagnostic endpoint is enabled or modified; this separate temporary probe does not require `ENABLE_DIAGNOSTICS`.

Successful response keys are exactly:

- `temporary`, `sampleOnly`, `sampleTruncated`: booleans.
- `jobsInspected`, `laborLinesInspected`: deduplicated sample counts.
- `jobTechnicianIdPresentCount`, `laborTechnicianIdPresentCount`.
- `jobCompletedDatePresentCount`, `laborCompletedDatePresentCount`.
- `jobCompleteFieldPresentCount`, `laborCompleteFieldPresentCount`.
- `observedParentRoStatusIds`: unique sorted parent status IDs, restricted to integers 1–7.
- `jobAssignmentTypesObserved`, `laborAssignmentTypesObserved`: objects containing only boolean `numeric`, `null`, and `malformed` flags.

Presence means the object owns the field, including a null value. Missing fields do not set any assignment-type flag. Numeric assignment means a positive safe integer; strings and other present non-null values are classified as malformed for this probe, without returning their values. Parent statuses include the sampled parents even if they have no sampled jobs. No names, notes, customer/vehicle IDs, RO numbers, record/employee IDs, credentials, tokens, dates, hours, currency values, or complete records are returned. The explicit response allowlist is tested using synthetic prohibited values. Schema observation alone does not resolve completion-date meaning or technician ownership precedence.
