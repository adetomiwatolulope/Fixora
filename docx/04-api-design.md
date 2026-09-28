# Fixora — API Design (Task 3, Checkpoint 4)

**Nothing in this document is implemented.** Task 3 builds the schema and a proof, not the API
(PR-TECH-004 locks the shape; CS-12 makes handlers thin; AGENTS Q4 places every allow-or-deny
decision in `/modules`).

Convention source: PR-TECH-004 — REST, JSON request and response bodies, versioned under `/v1/`.
Every mutating endpoint validates on the server regardless of client validation (CS-13).

---

## 1. Conventions

### 1.1 Base, versioning, media type

| Property | Value |
|---|---|
| Base path | `/v1` — in the path, not a header, and not a query parameter (PR-TECH-004) |
| Media type | `application/json; charset=utf-8` on request and response |
| Field naming | `camelCase` in JSON; the wire format is not the snake_case database format |
| Identifiers in URLs | `cuid()` only. **Never a phone number, never a job address, never a name** (SEC-12) |
| Dates | ISO-8601 UTC, `2026-09-28T12:00:00.000Z`. The server clock decides every time (CS-7) |
| Money | `Int` kobo only, in a field ending `Kobo`. No currency field — see `03-design-decisions.md` §2.2 |
| Trailing slashes | Rejected. One canonical form per resource |
| Unknown JSON fields | **Rejected with 400**, not ignored — SEC-6's allowlist applies to responses and to inputs |

### 1.2 Authentication and the four-step handler order

Sessions are established by phone + OTP (PR-AUTH-001). How a session persists is **undefined by the
PRD** (SEC-3). The most restrictive option is proposed and flagged, not assumed:
a server-side session referenced by an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, with the
identifier regenerated at login. Role and capabilities are read from server-side data and never
from anything the client can edit (SEC-3).

Every route follows the same order (api-route-scaffolder, "Opening ritual"):

```
1. Session        → who is calling. 401 if none.
2. Input          → validate the body and query. 400 malformed, 422 semantic.
3. Ownership      → capability + relationship, in /modules. 403, never a filtered result.
4. Limits         → rate limits, caps. 429.
```

Reordering these is how a "not found" leaks in front of an authorisation check.

### 1.3 Error envelope

One shape for every error. SEC-12: generic bodies, no stack traces, no Prisma error text.
CS-11: permission failure is a typed error that becomes 403; validation failure is 4xx with field
errors; anything unexpected is a generic 500 and the detail goes to the log.

```json
{
  "error": {
    "code": "ORDER_ALREADY_CANCELLED",
    "message": "This order is already cancelled and cannot be changed.",
    "fields": [
      { "name": "status", "message": "Expected REQUESTED, found CANCELLED." }
    ],
    "requestId": "01J8Z4K2QW9V3XB7T0M5N6P8RC"
  }
}
```

`code` is a **closed, stable, machine-readable** string, not a database error string. It is the
contract; `message` is for humans and may be reworded; `requestId` correlates with server logs
without putting any user data in them (SEC-12).

### 1.4 Status code semantics

The line that matters: **403 for a wrong-role or wrong-owner request, never a filtered or empty
result standing in for a denial** (PR-TECH-005, SEC-4). A 404 must mean the resource does not exist,
not that you may not see it.

| Code | Meaning | Typical cause |
|---|---|---|
| 200 | OK | Read, or a transition that converged on the target state |
| 201 | Created | `POST /v1/orders`, `POST /v1/orders/:id/review` |
| 202 | Accepted, asynchronous | `POST /v1/auth/otp/request` — the code goes out over SMS; nothing is returned to the caller |
| 204 | No content | `DELETE` on nothing. **No endpoint in v1 returns 204** — see §1.6 |
| 400 | Malformed request | Unparseable JSON, unknown field, unknown query parameter, bad cursor, out-of-range coordinate |
| 401 | No valid session | Absent, expired, or invalidated session |
| 403 | Authenticated but not permitted | Wrong capability, or wrong owner. Explicitly used instead of 404 (PR-TECH-005) |
| 404 | Does not exist | Unknown id, or a search that matched nothing for a non-existence claim |
| 409 | State conflict | A guarded write matched zero rows: duplicate review on one order, or a transition from an illegal current state |
| 422 | Semantically unprocessable | Self-order (PR-ORDER-001), a price field the API refuses, an amount out of MB-2's range, a category the provider does not list |
| 429 | Rate limited | OTP: 3/phone/hour, 5 attempts/code, 10/IP/hour (PR-AUTH-003, PR-TECH-002a) |
| 500 | Unexpected | Generic body; the real cause is logged, never returned |

**409 vs 422, the rule:** *409 means "the resource is not in a state where this action makes
sense"* (time-varying, so a retry later may succeed). *422 means "this request is wrong and always
will be"* (stable under retry). PR-ORDER-001's self-order rejection is 422 by explicit requirement.

### 1.5 Response allowlisting

Every response is an explicit `select` or DTO. Never `return prisma.order.findUnique(...)`
(CS-6's mirror for reads, SEC-7). No response ever contains `codeHash`, another user's `phone`, a
job address to a third party, or a provider's raw coordinates (SEC-7, SEC-12).

Two data rules, in force on **every** endpoint:

- **`agreedPriceKobo` is order-scoped.** Visible to that order's customer, its provider, and Admin
  (PR-ORDER-011). **Never** in search results, never on a public provider profile (MB-4).
- **A provider's `phone` is relationship-scoped.** Returned to a customer only if that customer
  holds an order with that provider (PR-PROVIDER-004, AGENTS rule 8). Whether a provider sees the
  *customer's* phone is undefined; the default is to omit it (SEC-7, flagged).

### 1.6 No state change on GET, and no DELETEs in v1

SEC-10: no state change on GET. A mutating route using cookie auth must verify `Origin` — Server
Actions do this by default, route handlers do not.

**No `DELETE` endpoint exists in v1**, and this is a requirement, not an omission. The PRD defines
no deletion path for any entity, and the tables that could plausibly be deleted are exactly the
ones the rules forbid it for: a `COMPLETED`/`DECLINED`/`CANCELLED` order is immutable (PR-ORDER-010,
DB-6), a review's `rating` and `comment` are never deleted (DB-6), `AdminAction` is append-only
(PR-ADMIN-004), and account deletion is an unresolved NDPR question (Open Question 11, AGENTS
rule 23). 204 is therefore unused in v1.

---

### 1.7 The full surface, in one table

Twenty-nine endpoints. This exists so the shape of the API can be judged as a whole rather than
endpoint by endpoint — the pattern that matters is the **width-to-depth ratio**: almost every
mutation is a narrow single-purpose verb, and there is no general-purpose `PATCH` on any entity
whose fields are governed by rules.

| # | Method / path | Action | Actor | Idempotency | §|
|---|---|---|---|---|---|
| 1 | `POST /v1/auth/otp/request` | - | anonymous | **No, by design** (supersedes) | 2 |
| 2 | `POST /v1/auth/otp/verify` | - | anonymous | **No** (code is single-use) | 2 |
| 3 | `GET /v1/me` | - | any caller | read | 4.2 |
| 4 | `PATCH /v1/me` | - | any caller | convergent | 4.2 |
| 5 | `GET /v1/providers` | **A1** | any caller | read | 3 |
| 6 | `GET /v1/providers/:id` | **A1** | any caller | read | 3 |
| 7 | `GET /v1/providers/:id/reviews` | **A5** | any caller | read | 3 |
| 8 | `POST /v1/providers` | - | any non-admin | no | 4.1 |
| 9 | `PATCH /v1/providers/me` | - | the profile's user | convergent | 4.1 |
| 10 | `POST /v1/orders` | **A2** | any caller | **No** (open item) | 3 |
| 11 | `GET /v1/orders` | **A2** | any caller | read | 3 |
| 12 | `GET /v1/orders/:id` | **A4** | customer, provider, Admin | read | 3 |
| 13 | `GET /v1/providers/me/orders` | **A3** | the provider | read | 3 |
| 14 | `POST /v1/orders/:id/accept` | **A3** | provider | convergent | 3 |
| 15 | `POST /v1/orders/:id/decline` | **A3** | provider | convergent | 3 |
| 16 | `POST /v1/orders/:id/propose-time` | **A3** | provider | convergent | 3 |
| 17 | `POST /v1/orders/:id/accept-proposal` | **A3** | customer | convergent | 3 |
| 18 | `POST /v1/orders/:id/decline-proposal` | **A3** | customer | convergent | 3 |
| 19 | `POST /v1/orders/:id/start` | **A4** | provider | convergent | 3 |
| 20 | `POST /v1/orders/:id/mark-done` | **A4** | provider | convergent | 3 |
| 21 | `POST /v1/orders/:id/confirm-completion` | **A4** | customer | convergent | 3 |
| 22 | `POST /v1/orders/:id/cancel` | **A4** | customer or provider | convergent | 3 |
| 23 | `POST /v1/orders/:id/dispute` | **A4** | customer or provider | convergent | 3 |
| 24 | `POST /v1/orders/:id/review` | **A5** | the order's customer | convergent + unique constraint | 3 |
| 25 | `GET /v1/admin/reviews` | - | Admin | read | 9 |
| 26 | `POST /v1/admin/reviews/:id/approve` | - | Admin | **No** (new audit row) | 9 |
| 27 | `POST /v1/admin/reviews/:id/reject` | - | Admin | **No** (new audit row) | 9 |
| 28 | `GET /v1/admin/orders` | - | Admin | read | 9 |
| 29 | `POST /v1/admin/orders/:id/resolve-dispute` | - | Admin | **No** (new audit row) | 9 |
| 30 | `POST /v1/admin/providers/:id/subscription` | - | Admin | **No** (new audit row) | 9 |
| 31 | `GET /v1/admin/actions` | - | Admin | read | 9.2 |

**"Convergent" is the word to read carefully.** It is not idempotency. A guarded transition
converges on the target state and then reports 409 on every subsequent call: the resource ends up
where the first call put it, but the response is not replayed identically. Sixteen of these
endpoints are convergent, and the distinction from true idempotency is set out in §10.

**What is absent, and that is the design:** no `DELETE` anywhere (§1.6), no `PATCH` on `Order` or
`Review` (§4.3, §4.4), no read endpoint for `OtpCode` or a create endpoint for `AdminAction`
(§4.5, §4.6), no `GET /v1/users/:id`, and no `sort` on search (§5.3). Each absence has a reason;
none of them is an oversight.


## 2. Authentication

**Design only. Not implemented in Task 3** (the brief excludes authentication), but designed
because the five actions all sit behind a session.

### `POST /v1/auth/otp/request`

Request → SMS. The code is delivered only through the SMS channel and is **never** in the response
body in any non-development environment (PR-TECH-002, AGENTS rule 4).

| | |
|---|---|
| Method / path | `POST /v1/auth/otp/request` |
| Auth | None — this is how a session is obtained |
| Request body | `{ phone: string }` — required |
| Response | **202** `{ "expiresInSeconds": 300 }`. Never the code. |
| Errors | 400 malformed/unknown field · 429 if >3 requests for this phone in an hour, or >10 for this IP in an hour (PR-AUTH-003, PR-TECH-002a) · 500 |
| Idempotency | **No, and deliberately.** Requesting a new code invalidates any prior unconsumed code for that number (PR-AUTH-002). A retry supersedes rather than duplicates. That is the requirement, not a defect. |
| Rate-limit state | Needs `phone` (in the schema) and originating IP (**not** in the schema — SEC-11 says flag it, never use a per-instance counter). Open item. |

**The 202 is load-bearing.** A 200 with a body would tempt someone to put the code in it, which is
the exact failure AGENTS rule 4 forbids.

### `POST /v1/auth/otp/verify`

| | |
|---|---|
| Method / path | `POST /v1/auth/otp/verify` |
| Request body | `{ phone: string, code: string }` — both required |
| Success | **200** `{ "status": "EXISTING_ACCOUNT" }`, or `{ "status": "NEW_ACCOUNT", "roleOptions": ["CUSTOMER", "PROVIDER"] }` |
| Errors | 400 · 401 wrong/expired code · **409** code already consumed (single-use) · 429 if >5 verification attempts on one issued code (PR-AUTH-003) |
| Idempotency | **No.** A code is single-use (PR-AUTH-002), so a retry after a dropped response fails. The client's recovery is to request a new code. |
| On success | Regenerate the session identifier at login (SEC-3). Establish the server-side session. Return no token in the body. |

`code` is compared in constant time against `codeHash`, an HMAC, never a plain hash — a plain hash
of a 6-digit code is trivially reversible if the table leaks (SEC-1). The attempt counter is
incremented **before** comparison so parallel guesses cannot exceed 5 (SEC-2, CS-4).

A newly verified number must choose a role and complete a minimal profile before the account is
usable (PR-AUTH-004). `roleOptions` deliberately contains **only** `CUSTOMER` and `PROVIDER` — there
is no path, API or UI, that creates or promotes an `ADMIN` (PR-AUTH-006, SEC-5, AGENTS rule 5).

---

## 3. The five important actions

### A1 — Find a provider

#### `GET /v1/providers`

| | |
|---|---|
| Method / path | `GET /v1/providers` |
| Auth | **Required.** A public marketplace search needs a session for two reasons: proximity needs the caller's coordinates, and PR-PROVIDER-004's phone rule needs to know the caller's relationship to each result. |
| Requirements | PR-SEARCH-001, PR-SEARCH-002, PR-SEARCH-003, PR-AI-001, PR-SUB-002, PR-TECH-001 |

**Query parameters** — an explicit allowlist. No generic filter DSL (a client-authored filter
expression is mass assignment at the query layer, SEC-6).

| Param | Type | Required | Notes |
|---|---|---|---|
| `category` | `ServiceCategory` | yes | One of the seven enum values. Drives the GIN-indexed `@>` containment (PR-SEARCH-001) |
| `city` | `string` | yes | Single city in v1 (PR-SEARCH-003) |
| `latitude` | `number` | yes | Caller's latitude, −90…90. Validated as a number in range (SEC-8) |
| `longitude` | `number` | yes | −180…180 |
| `radiusKm` | `number` | no | **Capped.** The PRD gives no cap; SEC-8 requires one so a request cannot force a full scan. **Proposed 50 km, max — flagged for owner decision.** |
| `minRating` | `number` | no | 0–5, defaults to 0 |
| `limit` | `integer` | no | Default 20, max 100 [ASSUMPTION] |
| `cursor` | `string` | no | Opaque (§5) |

**`sort` is deliberately not a parameter.** PR-SEARCH-001 and PR-AI-001 mandate a specific composite
ordering — proximity, rating, and a `FEATURED` boost applied after the proximity/rating score
(PR-SUB-002). Letting a client pass `sort` would let it bypass the boost, so the score is not
client-controllable. A provider with zero reviews is **not** excluded; they rank on proximity alone
with a neutral rating placeholder, so new providers are not buried (PR-AI-001).

```jsonc
// 200
{
  "data": [
    {
      "id": "clx…",                    // ProviderProfile.id
      "name": "Emeka O.",
      "bio": "Electrician, 8 years.",   // ≤500 chars
      "categories": ["ELECTRICAL", "REPAIRS"],
      "startingPriceKobo": 1500000,     // Int kobo, informational only (PR-PROVIDER-003)
      "ratingAverage": 4.4,
      "ratingCount": 17,
      "featured": true,                 // effective tier, not the stored enum (PR-SUB-004, MB-6)
      "distanceKm": 3.2,                // a distance, never raw coordinates (SEC-7)
      "score": 0.71                     // the ranking score, for debugging the deterministic sort
    }
  ],
  "page": { "nextCursor": "eyJj…", "hasMore": true }
}
```

**Errors:** 400 unknown parameter, non-numeric or out-of-range coordinate, `radiusKm` over the cap,
malformed cursor · 401 no session · 500.

**Idempotency:** yes — a read.

**Execution:** one `$queryRaw` containing the bounding-box prefilter on the indexed
`users (city, latitude, longitude)`, the exact haversine distance, the score, the `ORDER BY`, and
the `LIMIT` (PR-TECH-001, CS-10). Fetching candidates and computing distance or sorting in
application code is a failure — it pulls the whole candidate set into memory and breaks pagination
correctness. A zero-review provider gets a neutral rating placeholder rather than being filtered
out. An expired `FEATURED` provider must produce the same result as a `FREE` one — the SQL
expression and the TypeScript function must agree, proven by MB-6's four-case test (open item).

#### `GET /v1/providers/:id`

| | |
|---|---|
| Method / path | `GET /v1/providers/:id` — `id` is a `ProviderProfile.id` |
| Auth | Required |
| Requirements | PR-PROVIDER-004, PR-SUB-004, PR-PROVIDER-001, PR-PROVIDER-005 |

Returns the profile, the aggregate rating, the review count, and the subscription tier (to render a
"Featured" badge). **It does not return the provider's phone number to a customer who has no order
with that provider** (PR-PROVIDER-004, AGENTS rule 8).

```jsonc
// 200 — "phone" is present ONLY when the caller holds an order with this provider
{
  "data": {
    "id": "clx…",
    "name": "Emeka O.",
    "bio": "…",
    "categories": ["ELECTRICAL"],
    "city": "Lagos",
    "startingPriceKobo": 1500000,
    "ratingAverage": 4.4,
    "ratingCount": 17,
    "featured": true,
    "phone": "+234…"            // conditional, relationship-scoped
  }
}
```

`featured` is the **effective** tier: `FEATURED` only if the stored tier is `FEATURED` **and**
`featuredEndsAt` is in the future by the UTC server clock; everything else, including `FEATURED`
with a null end, is `FREE` (PR-SUB-004, CS-8, MB-6). The raw `subscriptionTier` enum is not
returned, so no client can act on a stale value.

**Errors:** 401 · 404 unknown id · 500.
**Idempotency:** yes — a read.

### A2 — Place a service order

#### `POST /v1/orders`

| | |
|---|---|
| Method / path | `POST /v1/orders` |
| Auth | **Required.** Ordering needs an authenticated user, not `role = CUSTOMER` — a `PROVIDER` may order (PR-AUTH-005). Capability is "authenticated and not admin-only" (CS-9). |
| Requirements | PR-ORDER-001, PR-ORDER-002, PR-PROVIDER-002, MB-5 |

```ts
type CreateOrderRequest = {
  providerId: string;            // ProviderProfile.id — required
  category: ServiceCategory;     // required; must be one this provider lists
  description: string;           // required; ≤ 1000 chars
  preferredDate: string;         // required; ISO-8601 date-time
  jobAddress: string;            // required
  jobLatitude?: number;          // optional
  jobLongitude?: number;         // optional
};
```

**Required fields:** all six non-optional ones. There is **no price field** — PR-ORDER-001 accepts
none, and if one arrives in the body the request is **rejected with 422**, not silently dropped and
not stored (MB-5).

```jsonc
// 201
{
  "data": {
    "id": "ord…",
    "status": "REQUESTED",
    "category": "PLUMBING",
    "description": "Leaking kitchen tap…",
    "jobAddress": "…",
    "preferredDate": "2026-10-01T09:00:00.000Z",
    "proposedDate": null,
    "createdAt": "2026-09-28T12:00:00.000Z"
  }
}
```

**Errors:**

| Code | When | Source |
|---|---|---|
| 400 | Unparseable, unknown field, malformed date | SEC-8 |
| 401 | No session | — |
| **422** | **The caller's `userId` matches the `userId` behind the target `ProviderProfile` — a provider ordering from themselves** | **PR-ORDER-001, AGENTS rule 6** |
| 422 | `category` is not one the provider lists | PR-ORDER-001, PR-PROVIDER-002 |
| 422 | A price field was supplied | MB-5 |
| 403 | The caller is an `ADMIN` with no customer capability layered on | PR-AUTH-005 |
| 500 | — | — |

The 422 is a **guarded write**, not a read-then-check: the insert is conditioned on the customer's
`userId` differing from the profile's `userId`, and a row count of zero is the rejection (CS-4).
A `findUnique` followed by an `insert` is a race and fails review.

**Idempotency: no.** Two POSTs create two orders. The PRD defines no `Idempotency-Key` header and
no idempotency table, and inventing one would add a model the PRD does not describe (AGENTS Q7).
A retry after a network timeout therefore produces a duplicate `REQUESTED` order, which the
provider may decline. **Open item — flagged, not resolved.**

#### `GET /v1/orders` — the caller's own orders (customer's view)

| | |
|---|---|
| Method / path | `GET /v1/orders` |
| Auth | Required. Any authenticated caller — a `PROVIDER` may hold orders as a customer (PR-AUTH-005). An `ADMIN` has no customer capability unless one is layered on. |
| Requirements | PR-ORDER-011, PR-TECH-005 (scope), DB-6 |
| Idempotency | Yes — a read |

**The scope is decided by the session, not by a parameter.** There is deliberately no `userId` or
`customerId` query parameter: the module resolves the caller's own orders before any filter runs, so
**no query string can widen it** (CS-4, SEC-6). This is the single most important line in the
contract — a `?customerId=` parameter here would be a data leak waiting to be found.

| Param | Type | Required | Notes |
|---|---|---|---|
| `status` | `OrderStatus` | no | A **single** value, not a list. Repeating it, or passing a comma-joined string, is 400 |
| `from` | `string` | no | ISO-8601 date-time, inclusive lower bound on `createdAt` |
| `to` | `string` | no | ISO-8601 date-time, exclusive upper bound. `from > to` → 400 |
| `sort` | `enum` | no | `createdAt` (default) or `preferredDate`. Any other key → 400 |
| `order` | `enum` | no | `desc` (default) or `asc`. Only meaningful with a named `sort` |
| `limit` | `integer` | no | Default 20, max 100 [ASSUMPTION] |
| `cursor` | `string` | no | Opaque, server-signed (§5.1) |

**Sorting contract:** the order is always `createdAt DESC, id DESC` unless `sort` names another
key, and the `id` tiebreak is **never** omitted. A total order is what makes a keyset cursor
correct; two rows sharing a `createdAt` must still have a deterministic position or a page
boundary can repeat or drop one.

**Pagination contract:** keyset on the effective sort tuple, never offset. See §5.1 for why offset is
unstable against a table whose rows change status constantly.

```jsonc
// 200
{
  "data": [
    {
      "id": "ord…",
      "status": "IN_PROGRESS",
      "category": "PLUMBING",
      "description": "Leaking kitchen tap…",
      "jobAddress": "…",
      "preferredDate": "2026-10-01T09:00:00.000Z",
      "proposedDate": null,
      "providerName": "Emeka O.",   // the provider's display name, never their phone
      "agreedPriceKobo": 150000,    // order-scoped: visible to this order's customer only (PR-ORDER-011, MB-4)
      "providerMarkedDone": true,
      "autoCompleted": false,       // travels on every order, not only completed ones
      "createdAt": "2026-09-28T12:00:00.000Z"
    }
  ],
  "page": { "nextCursor": "eyJj…", "hasMore": true }
}
```

| Code | When |
|---|---|
| 400 | Unknown parameter, repeated `status`, malformed or foreign cursor, `from > to`, `limit` out of range |
| 401 | No session |
| 500 | — |

**Empty `data` with `hasMore: false` is a 200, not a 404.** The caller's order list existing and
being empty is a successful answer to a question they were entitled to ask.

### A3 — Respond to an incoming request

All four endpoints are provider-only except the two the customer drives, and every one is a
guarded `updateMany` whose `where` carries both the actor and the legal from-state (CS-3, CS-4).

#### `POST /v1/orders/:id/accept` — provider, `REQUESTED` → `ACCEPTED`

```ts
type AcceptOrderRequest = {
  agreedPriceKobo?: number;   // OPTIONAL, informational, integer kobo
};
```

`agreedPriceKobo` is accepted **here and nowhere else** — it is optional, stays null if not
recorded, and is written inside the same guarded transition as the status change (PR-ORDER-004a,
MB-4). There is no standalone route to set or amend it. Range and sign are enforced at this
boundary: non-integer, negative, zero, or above 2,147,483,647 → **422**, never a 500 and never a
silent clamp (MB-2). Because the PRD does not say whether zero is a valid price, zero is rejected
as the most restrictive reading, and **flagged** (MB known-gap 6).

200 returns the order with `status: "ACCEPTED"`.

**Errors:** 401 · **403** not this order's provider (PR-TECH-005, AGENTS rule 10) · 404 · **409**
not currently `REQUESTED` · 422 for the price · 500.

#### `POST /v1/orders/:id/decline` — provider, `REQUESTED` → `DECLINED`

```ts
type DeclineOrderRequest = { declineReason: string };  // required, ≤ 300 chars (PR-ORDER-004)
```

**Errors:** as accept, plus **422** if `declineReason` is missing or over 300 characters.

#### `POST /v1/orders/:id/propose-time` — provider, `REQUESTED` (status unchanged)

```ts
type ProposeTimeRequest = { proposedDate: string };  // required, ISO-8601
```

Sets `proposedDate` and leaves `status` as `REQUESTED` (PR-ORDER-005). Only the order's provider
may propose. **Not capped** — Open Question 9 leaves a cap or expiry undecided, and the schema
holds only the latest proposal, so no count is representable. Flagged.

#### `POST /v1/orders/:id/accept-proposal` — **customer**, `REQUESTED` → `ACCEPTED`

```ts
// no body
```

Copies `proposedDate` into `preferredDate` and accepts (PR-ORDER-005). **`agreedPriceKobo` is not
set by this endpoint.** MB-4 gives that field exactly one writer — the provider, inside
`acceptOrder()` — but here the *customer* drives the transition, and the PRD does not say who
records a price. The field stays null and the question is flagged (MB known-gap 3).

#### `POST /v1/orders/:id/decline-proposal` — **customer**, `REQUESTED` → `DECLINED`

```ts
// no body
```

The customer declining a proposed date. PR-ORDER-005 specifies no reason field for this path, so
none is accepted; a `declineReason` in the body is rejected as an unknown field.

#### `GET /v1/providers/me/orders` — the provider's incoming queue

| | |
|---|---|
| Method / path | `GET /v1/providers/me/orders` |
| Auth | Required, and the caller must own a `ProviderProfile` — otherwise 403. `me` is resolved server-side. |
| Requirements | PR-ORDER-004, PR-ORDER-005, PR-ORDER-011 |
| Idempotency | Yes — a read |

**This is the queue A3 acts on.** Without it, `accept` / `decline` / `propose-time` have nothing to
be invoked against, which is why the PRD's goal of providers managing incoming requests "from a
single place" needs it (PRD §3).

| Param | Type | Required | Notes |
|---|---|---|---|
| `status` | `OrderStatus` | no | A **single** value. `?status=REQUESTED` is the normal call — the pending queue. May **not** be repeated or comma-joined; 400 |
| `category` | `ServiceCategory` | no | Restrict to one of the provider's own listed categories. A value the provider does not list returns `data: []`, not 422 — the filter is legal, it simply matches nothing |
| `from` / `to` | `string` | no | ISO-8601 bounds on `createdAt`, same semantics as `GET /v1/orders` |
| `sort` | `enum` | no | `createdAt` (default), `preferredDate`, or `agreedPriceKobo` |
| `order` | `enum` | no | `asc` (default for this endpoint) or `desc` |
| `limit` / `cursor` | | no | As §5.1 — default 20, max 100, keyset |

**`order` defaults to `asc` here, and `desc` on `GET /v1/orders`.** A provider wants the *oldest*
unanswered request at the top — that is the one the two-hour response metric is measured against
(PRD §11). A customer wants the newest. Defaulting both to `desc` would bury exactly the row the
provider exists to act on, so the default is endpoint-specific rather than uniform.

**The queue's default view should probably be `?status=REQUESTED`**, because an unanswered request
is the only row on this list that has a deadline. Making it a default would change the meaning of
the endpoint rather than filter it, so it stays an explicit parameter — flagged as a UX decision for
the owner rather than assumed here.

```jsonc
// 200
{
  "data": [
    {
      "id": "ord…",
      "status": "REQUESTED",
      "category": "ELECTRICAL",
      "description": "Consumer unit keeps tripping…",
      "jobAddress": "…",
      "preferredDate": "2026-10-01T09:00:00.000Z",
      "proposedDate": null,
      "customerName": "Chidinma A.",   // the customer's display name
      "agreedPriceKobo": null,          // null until the provider themselves accept and set it
      "createdAt": "2026-09-28T12:00:00.000Z"
    }
  ],
  "page": { "nextCursor": "eyJj…", "hasMore": true }
}
```

**`agreedPriceKobo` is null for a `REQUESTED` order and always will be** — the provider is the only
writer, inside `acceptOrder()` (MB-4). It is not a field the provider fills in when browsing their
own queue, and a client rendering it as "price agreed" for a pending request is misreading it.

| Code | When |
|---|---|
| 400 | As `GET /v1/orders` |
| 401 | No session |
| **403** | The caller has no `ProviderProfile` — there is no queue to show them |
| 500 | — |


### A4 — Complete, cancel, or dispute

Six endpoints, all of them guarded `updateMany` whose `where` carries the actor **and** the legal
from-state (CS-3, CS-4). All six share the same response shape and the same error floor; only the
actor, the legal from-state, and the body differ. The shared contract is stated once so each
endpoint below records only what is genuinely specific to it.

**Shared response body** — the full order DTO, identical to `POST /v1/orders` plus every field the
lifecycle writes. `GET /v1/orders/:id` is the canonical definition; these transitions return the same
projection so a client never has to re-fetch after a mutation.

**Shared error floor** (every one of the six can return all of these):

| Code | When | Source |
|---|---|---|
| 400 | Unparseable body, unknown field, malformed date | SEC-8 |
| 401 | No session, or an invalidated one | SEC-3 |
| 403 | Caller is not this order's customer, this order's provider, or an Admin | PR-ORDER-011, PR-TECH-005, AGENTS rule 15 |
| 404 | Unknown order id | — |
| **409** | **The guarded write matched zero rows** — the order is not in this endpoint's legal from-state, or the caller is the wrong actor *for this state*. The error body names the current `status`. | PR-TECH-005, CS-4 |
| 500 | Generic body; cause logged, never returned | SEC-12 |

**409, not 404 and not 422, for a wrong-state transition.** The order exists and the caller may see
it; what failed is that this action does not apply to its current state. Retrying later may
succeed, which is exactly the 409 test from §1.4.

**Shared idempotency: convergent, not replayed.** A second call matches zero rows and returns 409.
Every client → server action in this section is a one-way state change, which is the fact that
settles the WebSockets-versus-SSE question in §8.3.

---

#### `POST /v1/orders/:id/start` — provider, `ACCEPTED` → `IN_PROGRESS`

| | |
|---|---|
| Method / path | `POST /v1/orders/:id/start` |
| Auth | **Provider only** — the order's provider. A customer calling this is 403. |
| Request body | **None.** An empty body; any field is an unknown field → 400. |
| Response | **200** the order DTO, `status: "IN_PROGRESS"` |
| Idempotency | Convergent. Repeat → 409 |

Errors: the shared floor, plus **422** if the body carries any field (this endpoint takes none).

#### `POST /v1/orders/:id/mark-done` — provider, `status` stays `IN_PROGRESS`

| | |
|---|---|
| Method / path | `POST /v1/orders/:id/mark-done` |
| Auth | **Provider only** |
| Request body | **None** |
| Response | **200** the order DTO. `status` is **still** `IN_PROGRESS`; `providerMarkedDone: true` and `providerMarkedDoneAt` are both now set. |
| Idempotency | Convergent. Repeat → 409 |

Sets `providerMarkedDone = true` **and** `providerMarkedDoneAt = now()` in one write (CS-5, DB-8).
`status` deliberately does **not** change: `IN_PROGRESS` is the intermediate sub-state, and moving
to `COMPLETED` here is the one-sided completion AGENTS rule 11 forbids (PR-ORDER-007).

The response returning `status: "IN_PROGRESS"` is not a bug. A client that waits for `COMPLETED`
here would wait forever.

#### `POST /v1/orders/:id/confirm-completion` — **customer**, `IN_PROGRESS` → `COMPLETED`

| | |
|---|---|
| Method / path | `POST /v1/orders/:id/confirm-completion` |
| Auth | **Customer only** — the order's customer. The provider calling this is 403. |
| Request body | **None** |
| Response | **200** the order DTO, `status: "COMPLETED"`, `completedAt` set, **`autoCompleted: false`** |
| Idempotency | Convergent. Repeat → 409 (the order is no longer `IN_PROGRESS`) |

Requires `providerMarkedDone = true`. **If the provider has not marked done, this is 409** — not a
silent success, and not a 422, because the order is in a perfectly valid state that simply is not
ready for this action yet.

This is the **only** request-reachable path to `COMPLETED`. It sets `completedAt` and leaves
`autoCompleted = false`, which is the field that distinguishes a customer-confirmed completion from
an auto-completed one (AGENTS rule 11, PR-ORDER-007a).

The second path to `COMPLETED` is the 72-hour sweep, and it has **no endpoint at all** — it is a
scheduled job, and reaching it by request would defeat the control (PR-TECH-008, CS-14, AGENTS
Q4: `/jobs` is never invoked by a route handler).

#### `POST /v1/orders/:id/cancel` — customer **or** provider, `ACCEPTED`|`IN_PROGRESS` → `CANCELLED`

```ts
type CancelOrderRequest = {
  cancelReasonCode: CancelReasonCode;  // REQUIRED
                                        // CUSTOMER_CHANGED_MIND | PROVIDER_UNAVAILABLE
                                        // | PROVIDER_NO_SHOW | SCHEDULING_CONFLICT | OTHER
  cancelReason?: string;               // optional free text, <= 300 chars
                                        // detail, never a substitute for the code
};
```

| | |
|---|---|
| Method / path | `POST /v1/orders/:id/cancel` |
| Auth | The order's customer **or** the order's provider |
| Response | **200** the order DTO, `status: "CANCELLED"`, `cancelledBy` set from the session |
| Idempotency | Convergent. Repeat → 409 |

**The enum is required; free text is not a substitute** (PR-ORDER-008, AGENTS rule 12). Without
`cancelReasonCode`, a pattern like repeated `PROVIDER_NO_SHOW` across unrelated orders is
unqueryable — it is buried in prose that nobody will ever aggregate.

| Code | When |
|---|---|
| *shared floor* | as above |
| 422 | `cancelReasonCode` absent, not a member of the enum, or `cancelReason` over 300 chars |

`cancelledBy` comes from the session, **never** the body (SEC-6, CS-6).

**No cancellation window and no penalty.** Cancellation is permitted at any point before
`COMPLETED` (Open Question 2 — undecided, PRD working assumption applied). A cancel against a
terminal order is **409**, and terminal orders never leave (PR-ORDER-010, AGENTS rule 14).

#### `POST /v1/orders/:id/dispute` — customer **or** provider, `IN_PROGRESS`|`COMPLETED` → `DISPUTED`

```ts
type RaiseDisputeRequest = {
  disputeReason: string;  // REQUIRED, <= 1000 chars
};
```

| | |
|---|---|
| Method / path | `POST /v1/orders/:id/dispute` |
| Auth | The order's customer **or** the order's provider |
| Response | **200** the order DTO, `status: "DISPUTED"`, `disputeRaisedBy` from the session |
| Idempotency | Convergent. Repeat → 409 |

`disputeRaisedBy` comes from the session, never the body.

**A `DISPUTED` order never resolves itself.** No timer, no auto-release, no fallback status. It
leaves `DISPUTED` only through an explicit Admin action carrying a resolution note
(PR-ORDER-009, AGENTS rule 13). There is deliberately no "escalate" or "expire" endpoint, because
inventing one is exactly the auto-resolution path AGENTS rule 13 forbids.

**`COMPLETED` → `DISPUTED` is listed here because PR-ORDER-009 enumerates it, and it is
contradicted by PR-ORDER-010** (AGENTS rule 14, which names `COMPLETED` as terminal). Both
readings are recorded in `03-design-decisions.md` §4.1.3 and neither has been silently resolved.
**Owner decision required.** If `COMPLETED` is meant to be genuinely terminal, this endpoint's legal
from-states become `IN_PROGRESS` only, and the error changes from 200 to 409 for every completed
order — including one the customer is disputing right now.

| Code | When |
|---|---|
| *shared floor* | as above |
| 422 | `disputeReason` absent or over 1000 chars |

#### `GET /v1/orders/:id`

Visible only to the order's customer, the order's provider, or an Admin (PR-ORDER-011). A
wrong-owner request is **403**, never a filtered or empty result (PR-TECH-005, SEC-4).

Returns `autoCompleted` prominently: an auto-completed order must be visibly distinguished from a
customer-confirmed one wherever order history is shown, and never rendered identically (AGENTS
rule 11, PR-ORDER-007a). A bare `status: "COMPLETED"` is not sufficient — the distinction travels
as its own field.

### A5 — Review a completed job

#### `POST /v1/orders/:id/review`

| | |
|---|---|
| Auth | Required |
| Requirements | PR-REVIEW-001, PR-REVIEW-002, PR-REVIEW-003, PR-AI-002 |

```ts
type CreateReviewRequest = {
  rating: number;     // required, integer 1–5
  comment?: string;   // optional, ≤ 500 chars
};
```

No `providerId` — the provider is derived from the order server-side. No `moderationStatus` — the
review starts `PENDING` always (PR-REVIEW-003, SEC-6). No `orderId` in the body — it is the path
parameter.

```jsonc
// 201
{ "data": { "id": "rev…", "rating": 5, "comment": "…",
            "moderationStatus": "PENDING", "createdAt": "2026-09-28T12:00:00.000Z" } }
```

**Errors:**

| Code | When | Source |
|---|---|---|
| 401 | No session | — |
| **403** | The caller is not **this order's** customer | PR-REVIEW-001, PR-TECH-005 |
| 404 | Unknown order id | — |
| 409 | A review already exists on this order (`P2002` on `reviews (orderId)`) — a **normal rejection, never a 500** | PR-REVIEW-001, CS-4 |
| 409 | The order is not `COMPLETED` | PR-REVIEW-001 |
| 422 | `rating` outside 1–5, or non-integer | PR-REVIEW-002 |
| 500 | — | — |

**The order must be `COMPLETED`, including an auto-completed one** — PR-ORDER-007a explicitly does
not affect review eligibility, and the two-sided-completion fallback must not silently cost a
customer their right to review. The order's status, the caller's identity, and the absence of an
existing review are all checked **inside** the transaction, as a guarded write (CS-4).

On creation the review is `PENDING`, invisible, and excluded from `ratingAverage` (PR-REVIEW-003).
A rating-only review (no comment) skips text moderation and may be auto-approved; a comment passes
the rules-based filter or is `FLAGGED` for an Admin — the moderation step **never** rejects
(PR-AI-002, AGENTS rule 18). `rating` and `comment` are never edited or deleted afterwards
(DB-6), so no `PATCH` or `DELETE` on a review exists.

#### `GET /v1/providers/:id/reviews`

Public, paginated list of **approved** reviews only. `PENDING` and `FLAGGED` are invisible;
`REJECTED` is never shown and never counted (PR-REVIEW-003, PR-REVIEW-005, AGENTS rule 17). Never
embed this list in A1's search response — see §6.

---

## 4. Per-entity basic operations

### 4.1 Provider profile

| Endpoint | Method | Actor | Body | Requirement |
|---|---|---|---|---|
| `POST /v1/providers` | create | any authenticated non-admin | `{ categories, bio?, startingPriceKobo }` | PR-AUTH-005, PR-PROVIDER-001 |
| `PATCH /v1/providers/me` | update | the profile's own user | `{ categories?, bio?, startingPriceKobo? }` | implied — **no PR ID, flagged** |
| `GET /v1/providers/me/orders` | list incoming | the provider | — | PRD §3 goal, PR-ORDER-004/005 |

**`POST /v1/providers`** lets a `CUSTOMER` add a `ProviderProfile` to their own account without
changing `role` (PR-AUTH-005). A `PROVIDER` account calling it is already at one profile —
`provider_profiles (userId)` is unique, so the second attempt is **409** (DB-11, CS-4). `role`,
`ratingAverage`, `ratingCount`, `subscriptionTier`, `featuredStartedAt` and `featuredEndsAt` are
**not accepted** — a provider can never upgrade themselves (MB-8, SEC-6). A phone number in the
body is not accepted: the phone identifies the account, it is not profile data.

`startingPriceKobo` is required and range-checked per MB-2. It is informational and binds nothing
(PR-PROVIDER-003, MB-3).

**`PATCH /v1/providers/me`** is the one endpoint here with no requirement ID behind it. The PRD
defines what a profile *has* (PR-PROVIDER-001) but names no update route, and no field list is
left to be inferred. Each accepted field is picked explicitly; the tier fields are never among
them. Flagged as an inferred endpoint, not a PRD requirement.

---

### 4.2 User

`User` is the only entity whose fields are mostly **not** client-writable. `id`, `role`, `phone`,
`createdAt` and every rating aggregate are server-owned.

| Endpoint | Method | Actor | Body | Requirement |
|---|---|---|---|---|
| `GET /v1/me` | read | any authenticated caller | — | PR-AUTH-001 |
| `PATCH /v1/me` | update | any authenticated caller | `{ name?, city?, state?, latitude?, longitude?, role? }` | PR-AUTH-004, PR-AUTH-005 |

**`GET /v1/me`** returns the caller's own account and is the cheapest possible way for a client to
learn who it is acting as. It returns the caller's own `phone` — this is the one endpoint where a
phone number is always present, because it is always the caller's own.

```ts
type MeResponse = {
  id: string;
  phone: string;              // the caller's own; never anyone else's
  role: UserRole;             // CUSTOMER | PROVIDER | ADMIN
  name: string;
  city: string;
  state: string;
  hasProviderProfile: boolean;  // lets a client route to the provider surface without
                                // a second request; PR-AUTH-005
  createdAt: string;
};
```

`hasProviderProfile` is a derived convenience, not a stored column: `role` and "has a profile" are
independent, because a `CUSTOMER` may hold a profile and a `PROVIDER` is backed by one (PR-AUTH-005).

**`PATCH /v1/me`** accepts only the fields listed. Two rules make this safe:

- **`role` is accepted at exactly one moment** — the first authenticated request after OTP
  verification, to complete PR-AUTH-004's minimal profile — and only with a value from
  `["CUSTOMER", "PROVIDER"]`. `role: "ADMIN"` is **422**, not 403 and not silently ignored. This is
  AGENTS rule 5 and PR-AUTH-006, and it is enforced by rejecting the value rather than by
  withholding the field: a client that sends it should be told it is invalid, not told nothing.
  `roleOptions` in the verify response exists so a correct client never has to guess.
- **No `phone` in the body.** The phone identifies the account; it is not profile data, and
  changing it is a re-verification flow the PRD does not define (SEC-12, DB-11).

| Code | When | Note |
|---|---|---|
| 400 | Unknown field, malformed coordinate, `from > to` equivalents | SEC-8 |
| 401 | No session | |
| 422 | `role: "ADMIN"`, or `role` supplied after the first request | AGENTS rule 5, PR-AUTH-006 |
| 422 | Latitude outside -90…90, longitude outside -180…180 | SEC-8 |

**There is no `GET /v1/users/:id` and no `DELETE /v1/me`.** The first because a public user profile
is not a v1 concept and a phone number must never appear in a URL (SEC-12). The second because
account deletion is an unresolved NDPR question and every relation is `Restrict`, so it is not
merely unimplemented — it is currently impossible (AGENTS rule 23, `03-design-decisions.md` §5.3,
Open Question 11).

### 4.3 Order

| Operation | Endpoint | Status |
|---|---|---|
| Create | `POST /v1/orders` | §3 A2 |
| Read one | `GET /v1/orders/:id` | §3 A4 |
| List own | `GET /v1/orders` | §3 A2 |
| List as provider | `GET /v1/providers/me/orders` | §3 A3 |
| Transition | six endpoints | §3 A4 |
| **Update arbitrary fields** | **none** | — |
| **Delete** | **none** | PR-ORDER-010, DB-6 |

**There is no `PATCH /v1/orders/:id`, and that is the point.** Every mutable field on an order —
`status`, `proposedDate`, `providerMarkedDone`, `agreedPriceKobo`, `completedAt`, `autoCompleted`,
`cancelReasonCode`, `disputeReason` — is written by exactly one named transition function, and each
of those is its own endpoint with its own actor check and its own legal from-state. A general
`PATCH` would be a second, weaker door into all of them, and the single most attractive mass
assignment target in the whole API (SEC-6, CS-3). Six narrow verbs beat one wide one here.

**There is no `DELETE`.** A `COMPLETED`, `DECLINED`, or `CANCELLED` order is immutable
(PR-ORDER-010, DB-6), and an in-flight order is a live obligation between two people. 204 is
therefore unused in the entire v1 surface (§1.6).

### 4.4 Review

| Operation | Endpoint | Status |
|---|---|---|
| Create | `POST /v1/orders/:id/review` | §3 A5 |
| List approved for a provider | `GET /v1/providers/:id/reviews` | §3 A5 |
| **Edit rating or comment** | **none** | DB-6, PR-REVIEW-003 |
| **Delete** | **none** | DB-6 |
| **Read one by id** | **none** | see below |

**A review's `rating` and `comment` are never edited and never deleted** (DB-6). A review is
moderated, not amended: the `APPROVED`/`REJECTED` decision is a separate `AdminAction` row, and
editing the text would break the audit trail that moderation depends on. So no `PATCH` and no
`DELETE`.

**There is no `GET /v1/reviews/:id`**, deliberately, and the reason is not tidiness. It would have
to answer for four audiences at once — the author, the provider, an Admin, and the public — and
`PENDING`, `FLAGGED`, and `REJECTED` are invisible to all but the first two (PR-REVIEW-003,
PR-REVIEW-005, AGENTS rule 17). An id-addressed review endpoint is the natural place for that
visibility rule to be got wrong, because the author can always see their own review and the code
that serves them is the code every other caller runs. The provider's approved list and the Admin
queue each have a narrow, unambiguous audience instead.

### 4.5 OtpCode

**No public operation of any kind.** The entity has two surfaces and both are in §2:
`POST /v1/auth/otp/request` creates one, and `POST /v1/auth/otp/verify` consumes one. There is no
`GET`, no `PATCH`, and no `DELETE`.

This is worth stating as a designed absence rather than an omission, because an `OtpCode` table
looks like a normal CRUD table and would pass an entity-coverage checklist. It is not one:

- **No read endpoint, ever.** `codeHash` is an HMAC and must not leave the database (SEC-1); the
  code itself is delivered only over SMS and never appears in a response outside development
  (PR-TECH-002, AGENTS rule 4).
- **No delete.** Expiry is a query on `expiresAt`; a row that has expired is not "deleted", it is
  just past `expiresAt`. Deleting it would destroy the evidence that a code was issued to this
  number within the window, which is exactly what PR-AUTH-003's rate limits are reasoned about.
- **No update except the two internal writes** — `consumedAt` on successful verification, and the
  `attempts` counter, which is incremented **before** comparison so parallel guesses cannot exceed
  five (SEC-2, CS-4).

### 4.6 AdminAction

| Operation | Endpoint | Status |
|---|---|---|
| Read by target | `GET /v1/admin/actions?targetId=…` | §9.2 |
| **Create directly** | **none** | — |
| **Update** | **none** | AGENTS rule 21 |
| **Delete** | **none** | AGENTS rule 21 |

**There is no endpoint that creates an `AdminAction` directly.** Rows are written only as a side
effect of the admin action they describe — approve, reject, resolve-dispute, change tier — in the
same transaction as that action (PR-ADMIN-002, PR-ADMIN-004, CS-5). A general
`POST /v1/admin/actions` would let an Admin fabricate an audit row for a decision that never
happened, which defeats the entire purpose of the table.

**No update and no delete, structurally.** These are append-only (AGENTS rule 21, PR-ADMIN-004). A
correction is a **new** row referencing the same `targetId`. Note that this is enforced only by the
absence of code — `03-design-decisions.md` §6.4 records that Postgres offers no append-only table
primitive, so the table itself would not stop an `UPDATE` issued by a future migration or script.


## 5. List endpoints: pagination, filtering, sorting

### 5.1 Pagination — keyset, never offset

Orders change status constantly, so an offset page is unstable: a new order at the head shifts
every page boundary and a client walking pages sees duplicates and gaps. Every list uses keyset
(cursor) pagination on a **total, unique** ordering.

| Endpoint | Ordering | Cursor tuple |
|---|---|---|
| `GET /v1/providers` | The ranking score, then `id` as a tiebreak | `{ score, id }` |
| `GET /v1/orders` | `createdAt DESC, id DESC` (default) | `{ createdAt, id }` |
| `GET /v1/providers/me/orders` | `createdAt ASC, id ASC` (default) - oldest unanswered request first, against the 2-hour metric | `{ createdAt, id }` |
| `GET /v1/providers/:id/reviews` | `createdAt DESC, id DESC` | `{ createdAt, id }` |
| `GET /v1/admin/reviews`, `GET /v1/admin/orders` | `createdAt ASC, id ASC` — oldest first is the work queue | `{ createdAt, id }` |

The cursor is **opaque**: base64url of the tuple, server-signed. Clients must not parse it, and an
unparseable or foreign cursor is **400**, not a silent reset to page one.

`limit` defaults to 20, max 100. **[ASSUMPTION]** — the PRD specifies no page size, so this is the
most restrictive reading, following the MB-2 precedent. Proposed for owner confirmation.

```jsonc
{ "data": [ /* … */ ],
  "page": { "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA5LTI4VDEyOjAwOjAwLjAwMFoiLCJpZCI6Im9yZC4uLiJ9",
            "hasMore": true } }
```

`page` is a sibling of `data`, never mixed into it, so a client iterating `data` never mistakes
metadata for a record.

### 5.2 Filtering — an explicit allowlist per endpoint

| Endpoint | Filter params | Serves |
|---|---|---|
| `GET /v1/providers` | `category`, `city`, `minRating`, `radiusKm` | PR-SEARCH-001 |
| `GET /v1/orders` | `status` (single `OrderStatus`), `from`, `to` | The caller's own orders |
| `GET /v1/providers/me/orders` | `status` (single), `category`, `from`, `to` | The provider's queue — `?status=REQUESTED` |
| `GET /v1/providers/:id/reviews` | none | Approved only |
| `GET /v1/admin/reviews` | `moderationStatus` | The `FLAGGED` queue (PR-ADMIN-001) |
| `GET /v1/admin/orders` | `status` | The `DISPUTED` queue (PR-ADMIN-002) |

**No generic filter language.** No `?filter[status][in][]=…`, no `?where=…`. An unknown parameter
is **400**, not ignored — silently ignoring `?categorie=PLUMBING` returns wrong results that look
like correct ones.

**Scope is applied before filtering, in the module, not in SQL:** `GET /v1/orders` resolves to the
caller's own orders before any filter runs, so there is no parameter that can widen it. A provider
reaching for someone else's order id gets 403 (PR-ORDER-011, PR-TECH-005).

### 5.3 Sorting — an allowlist, and one deliberate absence

Where sorting is the caller's choice, `sort` accepts only keys from a fixed set, defaulting to
`createdAt`. The set is enumerated server-side; an unknown key is **400**.

**`GET /v1/providers` has no `sort` parameter at all.** PR-SEARCH-001 and PR-AI-001 mandate a
specific composite order — proximity and rating, with the `FEATURED` boost applied after the score
(PR-SUB-002). A client-selectable sort would let a caller sidestep the boost, which is the paid
feature. Absent by design, and the most common thing a designer reflexively adds.

### 5.4 Index reality for the list queries

`(customerId, status)` and `(providerId, status)` serve the order lists' filter and grouping. They
do **not** order by `createdAt`, so exact keyset pagination on `(createdAt, id)` would want a
composite `(customerId, status, createdAt)`. That index is not added: no PR ID names a list endpoint
or its pagination, so tuning for it now would be optimising an unapproved pattern
(`03-design-decisions.md` §8.4). Adequate at v1 volume; flagged.

---

## 6. The over-fetching example

### 6.1 The failure

`GET /v1/providers/:id` needs four things: the profile, the aggregate rating, the review count, and
whether the profile is `FEATURED`. The tempting shortcut is one query that returns the joined
`ProviderProfile` + `User` row and lets the client read what it wants:

```ts
// ✗ The over-fetch. Compiles. Ships. Leaks.
return prisma.providerProfile.findUnique({
  where: { id },
  include: { user: true, reviews: true },
});
```

That one call returns `user.phone` — personal data that must reach a customer **only** if they hold
an order with this provider (PR-PROVIDER-004, AGENTS rule 8) — plus `user.latitude` and
`user.longitude`, which SEC-7 requires to be a distance rather than raw coordinates because a
provider's coordinates may be their home. And it returns **every review**, including the `PENDING`
and `FLAGGED` ones that must be invisible before approval (PR-REVIEW-003, AGENTS rule 17) and the
`REJECTED` ones that are never shown (PR-REVIEW-005).

Three disclosure classes in one query: phone, location, unpublished reviews. The endpoint is
public-facing, so the exposure is to any signed-in user.

It is also wrong in the other direction: including all reviews to show a count is an N+1-shaped
mistake at the page level, pulling a review row per provider across the whole candidate set for a
number already denormalised into `ratingCount` (PR-TECH-006, D1).

### 6.2 The correct shape

Two responses, each with an explicit allowlist, and the rating count read from the cached column:

```ts
// Provider detail — explicit select, relationship-scoped phone, no coordinates
const provider = await prisma.providerProfile.findUnique({
  where: { id },
  select: {
    id: true, bio: true, categories: true, startingPriceKobo: true,
    ratingAverage: true, ratingCount: true,          // cached aggregate, PR-TECH-006
    subscriptionTier: true, featuredEndsAt: true,    // → effectiveTier() (PR-SUB-004, CS-8)
    user: { select: { name: true, city: true } },
  },
});

// The phone is a second, separately authorised step — never a field of the profile
const phone = await callerHasOrderWith(providerId)
  ? await prisma.order.findFirst({ where: { providerId, customerId: callerId }, select: { id: true },
                             then: () => loadProviderPhone(providerId) })
  : null;
```

```ts
// Reviews — their own paginated endpoint, approved only
const reviews = await prisma.review.findMany({
  where: { providerId, moderationStatus: "APPROVED" },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  take: limit + 1,
  select: { id: true, rating: true, comment: true, createdAt: true },
});
```

### 6.3 The same need over the wire

The provider card is the case. A search result row needs six things: display name, bio, categories,
starting price, average rating, review count, and whether the badge should read "Featured". **A
typical client needs roughly 400 bytes for that.**

Here is the over-fetched response — one query with `include: { user: true, reviews: true }`, which
compiles, passes review, and ships:

```jsonc
// GET /v1/providers/clx8f2k9…  — what actually goes on the wire. ~6 KB.
{
  "data": {
    "id": "clx8f2k9…",
    "userId": "usr4m1n8…",
    "categories": ["ELECTRICAL", "REPAIRS"],
    "bio": "Electrician, 8 years. Domestic and industrial.",
    "startingPriceKobo": 1500000,
    "ratingAverage": 4.4,
    "ratingCount": 17,
    "subscriptionTier": "FEATURED",      // the stored enum — the client wanted the *effective* one
    "featuredStartedAt": "2026-09-01T00:00:00.000Z",
    "featuredEndsAt": "2026-10-01T00:00:00.000Z",
    "createdAt": "2026-01-14T08:12:00.000Z",
    "updatedAt": "2026-09-01T00:00:00.000Z",

    "user": {
      "id": "usr4m1n8…",
      "phone": "+2348012345678",         // ← PR-PROVIDER-004 breach unless this caller ordered
      "role": "PROVIDER",
      "name": "Emeka O.",
      "city": "Lagos",
      "state": "Lagos",
      "latitude": 6.5244,                // ← a provider's home, not a service address
      "longitude": 3.3792,
      "createdAt": "2026-01-14T08:12:00.000Z"
    },

    "reviews": [                          // ← 17 objects, including PENDING, FLAGGED, REJECTED
      { "id": "rev…", "orderId": "ord…", "customerId": "usr…", "providerId": "clx…",
        "rating": 5, "comment": "Came same day, fixed a tripping consumer unit.",
        "moderationStatus": "APPROVED", "flagReason": null, "createdAt": "…" },
      { "id": "rev…", "rating": 1, "comment": "…", "moderationStatus": "PENDING",  "flagReason": null, "…": "…" },
      { "id": "rev…", "rating": 2, "comment": "…", "moderationStatus": "FLAGGED",  "flagReason": "KEYWORD_MATCH", "…": "…" },
      { "id": "rev…", "rating": 1, "comment": "…", "moderationStatus": "REJECTED", "flagReason": null, "…": "…" }
      // … 13 more, of which 4 are PENDING or FLAGGED and must be invisible
    ]
  }
}
```

**Four disclosure classes in one response, on a public-facing endpoint:** a phone number the caller
may not be entitled to, a home location, eleven reviews of internal bookkeeping fields
(`orderId`, `customerId`, `providerId`, `flagReason`), and reviews that are explicitly not public
(PR-PROVIDER-004, SEC-7, PR-REVIEW-003, AGENTS rules 8 and 17). And it is *still* wrong in the
other direction — 17 review rows were fetched to render `ratingCount`, a number already
denormalised into a column (D1, PR-TECH-006).

The same need, asked for precisely, in GraphQL:

```graphql
query ProviderCard($id: ID!) {
  provider(id: $id) {
    id
    displayName
    bio
    categories
    startingPriceKobo
    rating {
      average
      count
    }
    effectiveTier          # computed server-side, never the stored enum
  }
}
```

```jsonc
// exactly the fields asked for. ~310 bytes.
{
  "data": {
    "provider": {
      "id": "clx8f2k9…",
      "displayName": "Emeka O.",
      "bio": "Electrician, 8 years. Domestic and industrial.",
      "categories": ["ELECTRICAL", "REPAIRS"],
      "startingPriceKobo": 1500000,
      "rating": { "average": 4.4, "count": 17 },
      "effectiveTier": "FEATURED"
    }
  }
}
```

**19× smaller, and the four disclosure classes are gone** — not because GraphQL filtered them, but
because the selection set did not name them. That distinction is the whole argument, and §7 picks it
up: the client *may* write `phone` into that selection set, and the server is then obliged to
decide whether to honour it. The safety here came from the query being narrow, not from the
transport.


### 6.4 The rule this establishes

**No `include: { … : true }` in a response path.** Every read names its fields. This is SEC-7's
"output is allowlisted" and it is not merely tidiness: `include: true` on a relation containing
personal data converts every future column added to that table into an accidental public
disclosure, with no code change and no review. The relationship-scoped phone is the sharper
version — a field that is *conditionally* present needs a conditional decision, and that decision
belongs in `/modules/providers`, not in a `select`.

---

## 7. REST vs GraphQL


**The MVP framing, stated plainly.** The standard guidance for a REST-first MVP is to model the
resources the product actually has, expose a small number of narrow endpoints, and add
representations later as clients reveal what they need. That guidance is not a fallback when a
better tool exists; it is the right default for a first release, because the expensive mistakes at
this stage are not missing flexibility, they are **leaking fields and inventing endpoints** -
both of which are much harder to walk back than to add. Fixora's central risk is a provider's phone
number reaching someone with no order with them, and its central modelling risk is a providerId
that means two different things (D2). Both are disclosure failures. Choosing the transport whose
failure mode is a new column appearing in a public response is the conservative choice for exactly
this product, and a client-supplied selection set removes that property.**Decision: REST, and it is already made.** PR-TECH-004 specifies "REST, JSON request/response
bodies, versioned under `/v1/`". GraphQL would contradict a locked requirement. The analysis is
recorded because the decision deserves its reasoning, and because two of the three usual arguments
for GraphQL fail here for reasons worth stating.

| The usual argument | Verdict for Fixora |
|---|---|
| **Avoid over- and under-fetching.** One query, exactly the fields the client needs. | **Partly true, and it cuts both ways.** Over-fetching is real and is handled in §6 by explicit DTOs plus the cached `ratingCount`. But the deeper benefit is *client-chosen* field selection, and that is in direct tension with SEC-7: the response allowlist is a **security control**, and a client-supplied selection set is an attacker-controlled specification of what the server should disclose. A GraphQL resolver must validate every requested field against the caller's relationship anyway — at which point the flexibility buys the client a way to ask for something it should not have. Fixora's relationship-scoped fields (the provider's phone, `agreedPriceKobo`) make this concrete: a selection set would have to be intersected with an ownership check per field, and the failure mode of getting that wrong is a data leak, not a bug report. |
| **Fetch several resources in one round trip.** | **The real GraphQL win, and it is small here.** Fixora's five actions are each naturally one resource. The closest case is the search page wanting profile + distance + rating + tier — and a REST response already returns all four in one payload, because they are one coherent resource, not four. |
| **Clients evolve without waiting for a server deploy.** | **Genuine, and it argues for a specific choice of REST.** Fixora's users are on mobile data in Nigeria. A small, `ETag`-able, cacheable payload beats query flexibility: search results in particular want `Cache-Control` and conditional requests, which GraphQL gives up almost entirely in exchange for HTTP caching. The flexibility also arrives where it is worth least — Fixora has exactly one client surface per persona, all under the owner's control, so coordinated release is cheap. |

**Costs GraphQL would add here:** a gateway or server runtime as a new deployment surface; persisted
queries or an allowlist to stop arbitrary queries becoming a denial-of-service vector; a resolver
layer where an N+1 is as easy to write as it is in REST, but harder to see; loss of HTTP caching;
and a second authorisation surface, which for a system whose central risk is a provider's phone
number reaching the wrong person is the wrong trade.

**The honest counter-argument:** if Fixora later serves a genuinely different client — a provider
console, a thin third-party widget — with different field needs over the same entities, the
flexibility argument gets stronger. The response then is a **new versioned REST surface**
(`/v2`), which PR-TECH-004's own versioning anticipates, not a rewrite onto GraphQL.

---

## 8. Real-time: use case and WebSockets vs SSE

> **Per the owner's decision, this section is analysis and a recommendation. Nothing here is built
> in Task 3, and no endpoint, table, or field is proposed for v1.**

### 8.1 The use case, derived from a PRD requirement

There is no real-time requirement in the PRD. The need is pinned by a **success metric** (PRD §11):

> *Provider time-to-first-response — median time from `REQUESTED` to the provider's first
> accept/decline/propose action — **≤ 2 hours**.*

That target is met by polling, but polling has a real cost profile here: a provider's phone on a
Nigerian mobile connection polling every N seconds is a large number of radio wake-ups, and the
load scales with *provider count × poll rate* against a single-city database.

So the use case, stated as a requirement rather than a wish:

> A provider holding a session needs to learn **that a new `REQUESTED` order exists in their
> category and city** — and a customer needs to learn **that their order's status changed** —
> without polling, and in time to matter against the two-hour target.

The second half is the more valuable half and the more often forgotten: after a provider accepts,
the customer learns nothing until they refresh.

**The constraint that governs everything below.** The only PRD requirement touching notification
delivery is PR-TECH-003, and its channel is **Open Question 6** — SMS, WhatsApp, push, or email,
explicitly undecided. AGENTS rule 24 forbids building v2 work early, and no real-time transport is
a v1 requirement. So this is a decision recorded for when Open Question 6 resolves, not a v1
design.

### 8.2 The framing that matters: SMS is probably the v1 answer

**Push-style transport is the wrong first step for Fixora.** Open Question 6 lists SMS first, and
SMS needs no recipient opt-in, which matters for a Nigerian consumer marketplace onboarding people
who have never used the app. A "new job request" SMS reaches the provider's phone directly, hits
the two-hour target, and requires no new infrastructure, no always-open connection, and no
resolution of the question a persistent connection raises on metered mobile data.

**Recommendation: do not build either transport in v1.** Implement PR-TECH-003 with SMS. Revisit a
persistent connection only if SMS cost or delivery reliability becomes a visible problem, which is
a measurable trigger, not a guess.

### 8.3 If and when a push surface is authorised: SSE over WebSockets

| Dimension | Server-Sent Events | WebSockets |
|---|---|---|
| Direction | Server → client only | Bidirectional |
| Transport | Ordinary HTTP response, `text/event-stream` | HTTP `Upgrade` handshake, then a different protocol |
| Reconnection | **Built in**, with `Last-Event-ID` for replay after a drop | Must be hand-built: backoff, reconnection, and state resync |
| Auth | The **same** cookie/header as every other endpoint — no second mechanism | Needs its own handshake auth or a token in the query string, which SEC-12 would flag if it carried personal data |
| Proxy/CDN | Passes through ordinary HTTP infrastructure | Often needs explicit proxy configuration; long-lived connections are dropped by many defaults |
| Client → server | Not possible | Possible |
| Cost | Minimal — a response that stays open | A separate runtime, plus reconnection and replay logic to own |
| Two-way need here | **None.** Every action is already a REST `POST` and should stay one | — |

**Decision: SSE**, if authorised. The deciding factor is not a tiebreak on throughput — it is that
**Fixora's traffic is essentially one-directional.** Status changes, new-order alerts, and tier
changes are all server → client. Every client → server action already exists as a REST mutation
with a well-defined status code, a body, and validation, and moving them onto a socket would
replace all of that with an envelope and a bespoke error format. WebSocket's one decisive
advantage — bidirectional messaging — buys nothing here, while its costs (a second protocol, a
second auth path, reconnection logic) are real.

**Delivery mechanism, for whoever builds it.** At single-city, low-volume scale, **PostgreSQL
`LISTEN`/`NOTIFY` is sufficient** and needs no Redis, no queue, and no new infrastructure. Its
limitation must shape the design: it is in-memory and non-durable, so a notification dropped
because no client was connected is gone. Therefore the client protocol is **state-on-connect,
deltas-after** — the server sends the current relevant state the moment a stream opens, and treats
the stream as a latency optimisation, never as the source of truth. A reconnecting client that
missed three events while asleep still renders correct state.

**Residual risks, stated:** one connection per tab against the browser's six-connections-per-origin
HTTP/1.1 limit; no per-message binary framing; an idle connection must be heartbeated through
proxies that drop silent ones; and a stream must not be the only path to a state change a customer
is entitled to know about, which is why the poll endpoint must remain available.

### 8.4 What is explicitly not proposed

No WebSocket or SSE endpoint, no stream registry, no `Notification` or `DeliveryAttempt` table, no
Redis or message broker, no push registration table for a PWA the PRD never describes, and no
`EventStream` entity. Each would be a v1-and-beyond feature or a resolution of Open Question 6,
both of which require an owner instruction (AGENTS rule 24, Q7).

---

## 9. Admin operations

Designed for completeness and traceability. **Not built in Task 3**, and note the §4 caveat: DB-13
forbids a seed outside `/tests` creating an `ADMIN` user, and PR-AUTH-006 defines no path by which
one comes into existence, so Task 3 cannot exercise these end to end.

| Endpoint | Method | Auth | Body | Requirement |
|---|---|---|---|---|
| `GET /v1/admin/reviews?moderationStatus=FLAGGED` | list | `ADMIN` | — | PR-ADMIN-001 |
| `POST /v1/admin/reviews/:id/approve` | moderation | `ADMIN` | `{ note? }` | PR-ADMIN-001, PR-REVIEW-005 |
| `POST /v1/admin/reviews/:id/reject` | moderation | `ADMIN` | `{ note }` — **required** | PR-ADMIN-001, PR-REVIEW-005 |
| `GET /v1/admin/orders?status=DISPUTED` | list | `ADMIN` | — | PR-ADMIN-002 |
| `POST /v1/admin/orders/:id/resolve-dispute` | moderation | `ADMIN` | `{ resolution, note }` | PR-ADMIN-002, PR-ORDER-009 |
| `POST /v1/admin/providers/:id/subscription` | tier | `ADMIN` | `{ tier, featuredStartedAt?, featuredEndsAt? }` | PR-ADMIN-003, PR-SUB-003 |
| `GET /v1/admin/actions?targetId=…` | audit | `ADMIN` | — | PR-ADMIN-004 |

### 9.1 On "the client names a status" — and why these three are not mass assignment

SEC-6 forbids client-writable `status`, `moderationStatus` and `subscriptionTier`. These three
endpoints appear to do exactly that, so the distinction must be explicit:

- `POST /v1/admin/reviews/:id/approve` and `/reject` do **not** accept `moderationStatus`. The
  *path* is the decision. There is no way for a request to set a moderation status to a third
  value, and no request can set one on a review that is not `FLAGGED`.
- `POST /v1/admin/orders/:id/resolve-dispute` accepts `resolution: "COMPLETED" | "CANCELLED"` —
  because PR-ADMIN-002 defines the admin's job as choosing a final status, and that choice *is* the
  payload. It is bounded to two values and applies only to an order currently `DISPUTED`.
- `POST /v1/admin/providers/:id/subscription` accepts `tier: "FREE" | "FEATURED"` — PR-SUB-003
  defines the tier change as the admin's explicit action. Setting `FEATURED` requires both dates
  with the end after the start, else **422** (PR-SUB-004, MB-7).

A user-facing route accepts none of these. A provider can never upgrade themselves, and no
customer-facing endpoint accepts a status at all (MB-8, SEC-6).

**`note` is required on rejection.** A rejection a provider never sees the reason for is
unreviewable by them and untraceable for the business. The schema's `note` is nullable
(`admin_actions.note`), so this is an **API-level** requirement, not a schema one — flagged as such.

**Every admin action writes its `AdminAction` row in the same transaction as the decision**
(PR-ADMIN-004, MB-7, CS-5). An `AdminAction` is never updated or deleted; a wrong grant is
corrected with a **new** row referencing the same `targetId` (AGENTS rule 21, DB-6). So
`POST /v1/admin/providers/:id/subscription` is **not idempotent**: a retry after a timeout writes a
second row and re-applies the tier. That is correct for an append-only audit log, and the client
should not blind-retry it.

**`resolve-dispute` with `resolution: "CANCELLED"` is where the flagged contradiction bites.** It
accepts no `cancelReasonCode`, because PR-ADMIN-002 specifies only a resolution note and a final
status, while AGENTS rule 12 says a cancellation must never be accepted without a structured code.
This is why `03-design-decisions.md` §6.2 does **not** add a CHECK constraint tying
`status = 'CANCELLED'` to a non-null `cancelReasonCode`: doing so would make this endpoint
unimplementable. **Open item — owner decision required.**

### 9.2 Reading an order's admin action history

`GET /v1/admin/actions?targetId=…` is served by `admin_actions (targetId)` — the whole reason that
index exists. `targetId` is polymorphic and unvalidated (DB-10): `Review.id` for
`REVIEW_MODERATION`, `Order.id` for `DISPUTE_RESOLUTION`, and `ProviderProfile.id` for
`SUBSCRIPTION_CHANGE` — the last being an **assumption** (MB-7), since the PRD does not say. One
owner-ratified convention is needed. Flagged.

---

## 10. Idempotency, summarised

No `Idempotency-Key` header and no idempotency table exists: the PRD defines neither, and adding one
is inventing a model (AGENTS Q7). What the schema *does* provide is the real distinction, and it is
worth stating precisely, because "idempotent" is usually used loosely for both cases.

| Case | Behaviour | Why |
|---|---|---|
| **Reads** (`GET`) | Truly idempotent. | — |
| **Guarded transitions** — accept, decline, start, mark-done, confirm, cancel, dispute, resolve | **Convergent, not idempotent.** The write is `updateMany({ where: { id, <actor>, status: <legalFrom> } })`; a second call matches **0 rows** and returns **409** with the current state named in the error. The resource converges on the target state; the response is not replayed identically. | CS-4. A `findUnique` then `update` is a race and fails review. |
| **`POST /v1/orders/:id/review`** | **Convergent + protected by a constraint.** A retry hits `reviews (orderId)` unique → `P2002` → **409**. A normal rejection, never a 500. | PR-REVIEW-001, CS-4 |
| **`POST /v1/orders`** | **Not idempotent.** Two POSTs create two orders. | No idempotency key defined. **Open item.** |
| **`POST /v1/auth/otp/request`** | **Not idempotent, by design.** A new request supersedes the previous code. | PR-AUTH-002 |
| **`POST /v1/auth/otp/verify`** | **Not idempotent.** A code is single-use. | PR-AUTH-002 |
| **Admin moderation / dispute / tier** | **Not idempotent.** Each call writes a new `AdminAction`; a retry writes another. | PR-ADMIN-004, AGENTS rule 21 |
| **The 72-hour sweep** | **Idempotent.** A second run matches 0 rows and changes nothing. | PR-TECH-008, CS-14 |

---

## 11. Requirement trace and open items

### 11.1 Trace

| Requirement | Endpoints |
|---|---|
| PR-AUTH-001/002/003, PR-TECH-002, PR-TECH-002a | `POST /v1/auth/otp/request` (202), `POST /v1/auth/otp/verify` |
| PR-AUTH-004 | `verify` response surfaces the role choice and profile requirements |
| PR-AUTH-004 | `PATCH /v1/me` completes the minimal profile; `role` accepted once, never `ADMIN` (422) |
| PR-AUTH-001 | `GET /v1/me` - the caller's own account, the one place a phone number is always present |
| PR-AUTH-005/006 | Capability model in §1.2; `roleOptions` excludes `ADMIN`; `POST /v1/providers` lets a `CUSTOMER` also provide |
| PR-PROVIDER-001/002/003/004/005 | `GET /v1/providers/:id`, `GET /v1/providers`, `POST`/`PATCH /v1/providers*` |
| PR-SEARCH-001/002/003, PR-AI-001, PR-SUB-002, PR-TECH-001 | `GET /v1/providers` — one `$queryRaw`, no client `sort` |
| PR-ORDER-001/002 | `POST /v1/orders`; self-order 422, no price field |
| PR-ORDER-004/004a/005/006 | `accept`, `decline`, `propose-time`, `accept-proposal`, `decline-proposal`, `start` |
| PR-ORDER-007/007a | `mark-done`, `confirm-completion`; `autoCompleted` returned; the sweep has no endpoint |
| PR-ORDER-008 | `cancel` with a required `cancelReasonCode` |
| PR-ORDER-009/010 | `dispute`; admin `resolve-dispute`; terminal states yield 409 |
| PR-ORDER-011 | `GET /v1/orders/:id` with the customer/provider/Admin check; 403 on wrong owner |
| PR-REVIEW-001/002/003/005 | `POST /v1/orders/:id/review`, `GET /v1/providers/:id/reviews` |
| PR-REVIEW-004, PR-TECH-006 | Rating recalculation is server-side and transactional; the count comes from the cached column |
| PR-SUB-001/003/004 | `GET` returns the effective tier; admin `subscription` endpoint |
| PR-ADMIN-001/002/003/004 | §9; every action writes its audit row in the same transaction |
| PR-TECH-004 | REST, JSON, `/v1/`, server-side validation on every mutation |
| PR-TECH-005 | §1.4 — 403 for wrong role or wrong owner, never a filtered result |
| PR-TECH-007 | Money is an integer kobo field; no currency field |
| PR-TECH-008 | The sweep is a job, has no endpoint, and is idempotent |

### 11.2 Open items

Carried from `03-design-decisions.md` §11 and specific to the API surface.

1. **Session mechanism undefined** (SEC-3). Server-side session + `HttpOnly`/`Secure`/
   `SameSite=Lax` cookie with the identifier regenerated at login is the most restrictive option
   proposed. Owner must ratify before implementation.
2. **No idempotency key on `POST /v1/orders`.** A retry creates a duplicate order. Needs either an
   owner decision to add an `Idempotency-Key` header with a table, or explicit client-side
   guidance.
3. **No OTP originating-IP storage** (PR-TECH-002a, SEC-11). The 10-per-IP-per-hour limit is
   unimplementable as specified. A schema change plus a trusted-proxy configuration decision.
4. **`resolve-dispute` → `CANCELLED` has no `cancelReasonCode`** (AGENTS rule 12 vs PR-ADMIN-002).
   The owner must decide whether the admin supplies one, or rule 12 is scoped to customer- and
   provider-initiated cancellations only. This also decides whether the CHECK constraint in
   `03-design-decisions.md` §6.2 can be added.
5. **Page size and `radiusKm` cap** — 20/100 and 50 km proposed and labelled `[ASSUMPTION]`. The
   PRD specifies neither, and SEC-8 requires a radius cap.
6. **`PATCH /v1/providers/me` has no requirement ID.** PR-PROVIDER-001 defines the fields; nothing
   names the route. Flagged as inferred.
7. **Order list endpoints have no requirement ID.** `GET /v1/orders` and
   `GET /v1/providers/me/orders` are implied by PRD §3's "manage their incoming orders from a single
   place" and by PR-ORDER-004/005, which need a list to act on. Their exact filter and sort contract
   is my design, not the PRD's.
8. **`note` required on admin rejection** is an API-level decision; the schema's `admin_actions.note`
   is nullable.
9. **`agreedPriceKobo` on `accept-proposal`** has no defined writer (MB known-gap 3) — left null.
10. **Provider → customer phone visibility** is undefined (SEC-7). Default is to omit; owner should
    ratify.
11. **Real-time is not in v1** (§8). No endpoint or schema is proposed; PR-TECH-003's channel is
    Open Question 6.

12. **GET /v1/me and PATCH /v1/me have no requirement ID.** PR-AUTH-004 requires a completed
    minimal profile, which implies a write; nothing names the route. Flagged as inferred, the same
    way PATCH /v1/providers/me is in item 6.
13. **The one-shot ole window is currently unimplementable as a guard.** This document proposes
    accepting ole only on the first request after OTP verification, and rejecting ADMIN
    always. The first half cannot be enforced: no field in the schema records that the choice has
    been made, so the server has nothing to compare a second ole against. The ADMIN half is
    enforceable and is the half that matters (AGENTS rule 5). Either the one-shot window needs a
    stored marker - a DB-1 change - or the rule drops to "role is settable, but never to ADMIN".
    Owner decision required.