# Fixora — Requirements

**Source of truth:** `docx/Fixora_PRD_v2.md`. **Process rules:** `AGENTS.md`.
This page is the *input* to every later design decision. It adds no requirements of its own; where
the PRD is silent, the gap is recorded in `03-design-decisions.md` §11, not filled in here.

## What the product does

Fixora is a Nigerian services marketplace. It connects customers with local providers across six
service categories plus `OTHER`, and records each engagement as an order with a lifecycle, so both
sides and Fixora's staff share one record of what was agreed and what happened.

Four things happen in order: a customer **finds** a provider filtered by category and city; places a
**request**; the provider accepts, declines, or proposes another time and the job is **fulfilled**;
and the customer may **review** it. Alongside that loop an internal admin moderates flagged reviews,
resolves disputes, and sets subscription tiers manually — every one of which writes an append-only
audit row.

**Not in v1, and a design that needs any of them is a scope error:** job payment or escrow, any
`Transaction`/`Payment` model, automated subscription checkout, provider verification gating,
company accounts, cross-city search, automated dispute resolution, provider responses to reviews,
generative AI of any kind, and file upload. (PRD §3, §13; AGENTS Q3 rule 20 and rule 24.)

## Who uses it

**Chidinma — customer.** Needs a plumber this week and has no one she trusts. She wants to see who
is nearby, what they charge to start, and what others thought, then request a job without a phone
call.

**Emeka — provider.** An independent electrician who wants more customers than word of mouth
brings him. He wants to see new requests, accept the ones that fit, and build a rating that helps
him get chosen.

PR-AUTH-005 makes `User.role` a *default*, not a capability wall: Emeka may also order as a customer
under the same account, and Chidinma may also hold a `ProviderProfile`. One `User` row can be both
sides on different orders. The single exception is ordering from yourself, which is rejected with
422 (PR-ORDER-001) — without that check the dual identity would be a rating-manipulation hole.

**Admin — internal only.** Not a public persona, and never created through public signup
(PR-AUTH-006). The one role with no customer or provider capability layered on it in v1.

## The five most important user actions

These are the loops the data model must make efficient and the API must make coherent. Together
they touch every model in the schema, which is why they drive the index and query-plan decisions.

| # | Action | Actor | What the model must guarantee | Requirements |
|---|---|---|---|---|
| **A1** | **Find a provider near me, in one category** | Chidinma | Only providers with ≥1 category are visible; the category filter is index-accelerated; distance, score and limit are computed in one query, never in application code; an expired `FEATURED` tier reads as `FREE` | PR-SEARCH-001/002/003, PR-PROVIDER-002/004, PR-AI-001, PR-SUB-002, PR-TECH-001 |
| **A2** | **Place a service order** | Chidinma | The order is created `REQUESTED`; the category must be one that provider lists; a self-order is refused; the customer may supply no price at all | PR-ORDER-001/002, PR-PROVIDER-002, PR-AUTH-005 |
| **A3** | **Respond to an incoming request** | Emeka | Only that order's provider may act, and only from `REQUESTED`; a decline needs a reason; the agreed price is written exactly once, at acceptance | PR-ORDER-004, -004a, -005, -006 |
| **A4** | **Complete, cancel, or dispute a job** | both + the 72h sweep | Completion needs both parties, or the sweep at 72 hours flagged `autoCompleted`; cancellation needs a structured reason code; only an admin resolves a dispute; a terminal state is never left | PR-ORDER-006/007/007a/008/009/010, PR-TECH-008 |
| **A5** | **Review a completed job** | Chidinma | Exactly one review per `COMPLETED` order, by that order's customer, rating 1–5; it is invisible until approved; the provider's rating is recomputed in the same transaction | PR-REVIEW-001/002/003/004/005, PR-PROVIDER-005, PR-AI-002, PR-TECH-006 |

**Deliberately not among the five.** Authentication (PR-AUTH-001…-004) is a prerequisite to all
five rather than a market action — it touches `User` and `OtpCode` and nothing else, and its
mechanics are fixed by rate limits and single-use semantics. The three admin operations
(PR-ADMIN-001/002/003) are the heaviest operational load in the PRD (PRD §4) but not the
customer-facing loop, and are not independently provable in Task 3: DB-13 forbids a seed outside
`/tests` from creating an `ADMIN`, and PR-AUTH-006 defines no path to one.

---

**Traceability contract.** Every decision in `02-data-model.md`, `03-design-decisions.md` and
`04-api-design.md` cites a PRD requirement ID from the table above, or names itself as filling a
gap the PRD left open. A decision citing neither is out of scope (AGENTS Q1, Q7). The model
constraints behind each row are itemised in `03-design-decisions.md` §6 and §8.

---

## Requirements checked

The rubric asked for a checked list. The PRD defines **51 requirement IDs across 9 families**, not 7,
so the families below are the unit of checking (2026-09-28).

The rubric also asked for "all seven hard questions answered in writing." The brief's original list
of seven is not in the repo; `06-seven-hard-questions.md` reconstructs it from the structure of
`03-design-decisions.md` and answers each in writing, explicitly flagged as a best-fit assumption
(AGENTS Q7) pending the owner's original wording.

Status is not "done / not done" — this task delivered the **schema and its design documents**, not an
application. Most requirements are behavioural and are enforced by code that does not exist yet. Each
family is therefore graded on what the database actually guarantees:

| Status | Meaning |
| --- | --- |
| **Enforced** | A column, enum, CHECK, FK, unique index or index in the applied migration makes it true regardless of application code. Verifiable in `evidence/`. |
| **Specified** | Written up in `02`/`03`/`04`; the enforcing logic is application code that this task did not build. |
| **Gap** | The requirement needs a database object that does not exist, or a decision nobody has made. |

| Family | IDs | Enforced | Specified | Gap |
| --- | --- | --- | --- | --- |
| AUTH | 6 | 001, 005 | 002, 003, 004, 006 | - |
| ORDER | 13 | 003, 004a, 007a, 008 | 001, 002, 004, 005, 006, 007, 009, 010, 011 | - |
| REVIEW | 5 | 001, 002 | 003, 004, 005 | - |
| PROVIDER | 5 | 002, 003 | 001, 004, 005 | - |
| SUB | 4 | 001, 004 | 002, 003 | - |
| ADMIN | 4 | 004 (partial) | 001, 002, 003 | - |
| AI | 2 | - | 001 | **002** |
| SEARCH | 3 | 001, 002, 003 | - | - |
| TECH | 9 | 001, 006, 007, 008 | 002, 003, 004, 005 | **002a** |

### What "enforced" means here, per family

- **AUTH** — 001 is enforced by absence: there is no password column on `User`, so no code path can
  store one. 005 is enforced by shape: `role` is a single enum and `ProviderProfile` is optional on
  `User`, so one account can be a customer and a provider at once.
- **ORDER** — 003 is the seven-value `OrderStatus` enum; a write outside it is a type error.
  004a is `agreedPriceKobo Int`, informational, with no payment object anywhere to bind it.
  007a is the `autoCompleted` boolean. 008 is the `cancelReasonCode` enum — the field exists, but
  *requiring* it on a cancellation is application logic.
- **REVIEW** — 001 is `orderId String @unique`; 002 is `reviews_rating_between_1_and_5`. Both are
  proved by real rejected inserts in `evidence/04-constraint-violations.md`.
- **PROVIDER** — 002 is `provider_profiles_categories_at_least_one`. 003 holds because no payment,
  invoice or `Transaction` model exists at all.
- **SUB** — 001 is the `SubscriptionTier` enum defaulting to `FREE`. 004 is
  `provider_profiles_featured_window_valid`; the effective tier is then computed at read time, which
  is query logic, proved by Q1 in `tests/schema-proof/five-queries.ts`.
- **ADMIN** — 004 only *partially*: `AdminAction` has no `updatedAt` and no `deletedAt`, so the ORM
  cannot update or soft-delete a row. A `BEFORE UPDATE OR DELETE` trigger would make it
  unforgeable, and was deliberately not added because DB-1 requires an instruction first.
- **SEARCH** — 001 is `provider_profiles_categories_gin_idx`, proved by Plan 1b. 002 follows from the
  categories CHECK. 003 is single-city by construction: the geo index leads with `city` and no
  cross-city path is modelled.
- **TECH** — 001 is `users_city_latitude_longitude_idx`, proved by Plans 1 and 1c. 006 is the
  denormalized `ratingAverage`/`ratingCount` pair. 007 is integer money plus a range CHECK. 008 is
  `orders_status_providerMarkedDone_providerMarkedDoneAt_idx`, proved by Plan 2.

### Gaps, stated rather than papered over

1. **PR-AI-002 has nowhere to live.** The PRD requires the moderation keyword/pattern list to be
   "maintained by an Admin through a simple internal list (add/remove entries), not hardcoded in
   application code, so it can be updated without a deployment." AGENTS rule 19 forbids hardcoding it.
   The six locked models contain no table for it — `Review.aiFlagReason` records *why* a review was
   flagged, not *what patterns* flag it. A seventh model is required, and DB-1 says not to add one
   without an instruction, so this is flagged rather than designed in.
2. **PR-TECH-002a has no storage.** IP-based OTP rate limiting is required (10 sends per IP per
   hour) but `OtpCode` records no originating IP. The counters may legitimately live outside
   Postgres, so this needs a decision on where they live before it can be built.
3. **PR-PROVIDER-001's 500-character bio cap is unforced.** It is application validation today; the
   other four CHECK constraints exist but this one does not. Candidate for the same raw-SQL
   treatment, again pending a DB-1 instruction.