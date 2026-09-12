# CarCare daily dashboard

Phase 1 reports one shop's daily financial activity in `America/Chicago`. It uses server-side Tekmetric requests and returns aggregates only. No customer records are returned to the browser.

## Runtime and configuration

Requires Node.js 22 or newer with built-in `fetch`, `Intl`, and the Node test runner. There are no package dependencies. Use a serverless host that maps `api/*.js` to `/api/*` with the existing CommonJS `(req, res)` interface and serves the root HTML and `/public/dashboard.js`. A static file server alone cannot execute API handlers.

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

**Production access protection remains required.** Phase 1 does not implement login or a rate-limit service. Before exposing real financial data, put the page and every API route behind an identity-aware access gateway or server-validated sessions, use an explicit staff allowlist and MFA, and protect preview deployments. Keep diagnostics disabled outside protected administrative use. Configure platform rate limiting; request concurrency alone is not rate limiting across visitors. Store credentials only in server secret storage and never commit `.env` or private API fixtures.

## Tests and release acceptance

Run `npm test` or `node --test test/*.test.js`. Tests use synthetic records and mocked transport only; no Tekmetric account or credentials are needed. Coverage includes pagination, statuses 5/6, duplicate ROs/jobs/labor, malformed fields, exact cents and discounts, empty days, Chicago midnight/DST boundaries, unavailable hours, timeouts, host restrictions, diagnostics, sanitization, concurrency, and stale browser responses.

Before production, compare the five cards against Tekmetric End of Day for the same shop/date, including A/R, fees/discounts, a multi-page day, empty days, and midnight records. Confirm filter encoding, page envelope, status shape, and ID semantics. Reopened/reposted/deleted orders and refunds can affect historical reconciliation; this implementation uses the current 5/6 population and posted dates, without inventing adjustment rules. Historical days are recomputed on refresh. Labor/sublet costs remain unverified and gross profit remains unavailable.
