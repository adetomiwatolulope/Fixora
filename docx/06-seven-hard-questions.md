# Fixora — the Seven Hard Questions (Task 3, Checkpoint 3 addendum)

## 0. How this document came to exist — read this first

The checkpoint rubric asked for "all seven hard questions answered in writing." The original
brief's list of the seven questions is **not present in this repository** — it existed only in the
brief itself. What *is* here is `03-design-decisions.md`, which was written to answer exactly that
set of questions, and whose chapter structure is the only surviving record of what the seven were:

| # | Decision area | In `03-design-decisions.md` |
| --- | --- | --- |
| Q1 | Normalisation — what form, and how to model the repeating group | §1 |
| Q2 | Money — representation and currency | §2 |
| Q3 | Denormalisation — which derivable values are stored | §3 |
| Q4 | State — which entities carry lifecycle state, and its exact shape | §4 |
| Q5 | Time — `createdAt` / `updatedAt` / `deletedAt` on which models | §5 |
| Q6 | Constraints — what the database itself enforces, and what it must not | §6 |
| Q7 | Identifiers — natural or synthetic keys | §7 |

§8 (indexes) is excluded from the questions: it is an *implementation consequence* of Q1–Q7, not a
design question in its own right. The indexes that came out of it are delivered as rubric item 5 and
proved in `evidence/03-query-plans.md`.

**Every pairing below is an assumption, not the brief's wording (AGENTS Q7).** If the owner's
original seven questions differ, these mappings are rebased against the brief, but the answers do
not change — each answer is the decision the repo already made and committed, and each traces to its
requirement IDs. Nothing in this document invents a new decision.

---

## Q1 — What normal form does the schema hold, and how is the one repeating group modelled?

**Answer (decided in `03-design-decisions.md` §1).** 1NF is compromised in exactly one place:
`ProviderProfile.categories` is a native Postgres array, not a set of atomic rows. That is deliberate
and PRD-locked (PRD §10), and the index that makes it viable is a build prerequisite
(PR-SEARCH-001, AGENTS Q2). Every other table is atomic. 2NF holds throughout: every entity has a
single-column surrogate key, so no non-key attribute depends on part of a composite key. 3NF is
broken deliberately in three places, each named and costed in Q3 (D1–D3).

The cost of the array, stated plainly: no per-category attributes (a provider cannot carry a
different starting price, bio, or rating per category) and no referential integrity on the array
elements. The moment per-category attributes appear, the array becomes a `ProviderProfileCategory`
join table — flagged, not silently converted (DB-1).

## Q2 — How is money stored, and what currency does a column imply?

**Answer (decided in `03-design-decisions.md` §2).** Every monetary field is `Int`, a whole number
of kobo (100 kobo = N1): `ProviderProfile.startingPriceKobo` and `Order.agreedPriceKobo`
(PR-PROVIDER-001, PR-ORDER-004a). No `Float`, `Decimal`, or `numeric` anywhere — a float kobo amount
is already wrong before rounding (PR-TECH-007, AGENTS rule 22). The API carries kobo integers only.

There is **no currency column**, and that is this checkpoint's most deliberate refusal: the brief
asked for one beside every amount, but `money-billing.md` MB-1 fixes kobo to mean NGN for v1, so a
currency column would add a field PRD §10 does not define. Consequence accepted: if a second
currency ever appears, it is a breaking migration (MB known-gap 6, PRD Open Question 7).

Money validation lives at the API boundary (422 for non-integer, negative, zero, or over-ceiling —
MB-2), not in a CHECK constraint, because "is a zero price valid?" is explicitly unresolved
(OQ-1). Money binds nothing: both amounts are informational (PR-PROVIDER-003, PR-ORDER-004a), and
no payment object exists anywhere.

## Q3 — Which derivable values are stored even though they can be computed?

**Answer (decided in `03-design-decisions.md` §3).** Five, of which three are load-bearing and all
five are PRD-mandated (removal of any requires a DB-1 instruction):

- **D1 — `ratingAverage` / `ratingCount`.** PRD-mandated denormalisation (PR-TECH-006). The cache
  is written by exactly one function, recomputed from the actual `APPROVED` reviews (`AVG`/`COUNT`,
  never `+= 1`), inside the same transaction as the moderation-status change (PR-REVIEW-004). A
  `PENDING`/`FLAGGED`/`REJECTED` review contributes nothing (PR-REVIEW-003/005). A CHECK keeps the
  cache inside `[0, 5]` and `ratingCount >= 0`.
- **D2 — `Review.providerId` points at `ProviderProfile.id`.** Materialised so the rating recompute
  and the approved-reviews list are single-hop. This is the model's sharpest edge: `Order.providerId`
  → `User.id` while `Review.providerId` → `ProviderProfile.id`, both non-null `String`, and nothing
  in the type system or a foreign key catches a mix-up. Needs the DB-9 conversion function in
  `/modules/providers` — flagged as the highest-risk item in the model (OQ-4).
- **D3 — `ProviderProfile.subscriptionTier` stored but not authoritative.** Effective tier is
  computed at read time: `FEATURED` only if the stored tier is `FEATURED` **and** `featuredEndsAt`
  is in the future; a null end fails closed to `FREE` (PR-SUB-004). No scheduled job resets an
  expired tier (MB-7). The cost is that the rule now exists twice — in TypeScript and in SQL — and
  MB-6's agreement test is required before search ships.
- **D4 — `Order.providerMarkedDone` is redundant with `providerMarkedDoneAt`.** Kept because the
  PRD requires the sweep index `[status, providerMarkedDone, providerMarkedDoneAt]`, and a boolean
  predicate is index-friendlier than `IS NOT NULL` (PR-TECH-008).
- **D5 — `Order.autoCompleted` records what nothing else records.** There is no
  `customerConfirmedAt` column, so this boolean is the only durable answer to *how* an order became
  `COMPLETED`, which AGENTS rule 11 requires to be visibly distinguished (PR-ORDER-007a).

## Q4 — Which entities carry lifecycle state, and what is the exact shape of each?

**Answer (decided in `03-design-decisions.md` §4).** Five entities carry or refuse state:

- **`Order.status`** — the primary machine: a seven-value Postgres enum (`REQUESTED`, `ACCEPTED`,
  `DECLINED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `DISPUTED`), so an eighth value is a type
  error and a stop-and-ask (PR-ORDER-003, AGENTS rule 9). Every allowed and forbidden transition is
  tabulated in §4.1.1–4.1.2. One genuine PRD contradiction is carried forward unresolved —
  `COMPLETED → DISPUTED` (PR-ORDER-009) against terminal-status (PR-ORDER-010) — and both readings
  are documented (OQ-3, §4.1.3).
- **`Review.moderationStatus`** — starts `PENDING` by database default; the automated scan may only
  produce `PENDING` or `FLAGGED`, never an approval (PR-REVIEW-005); only an Admin sets `APPROVED`
  or `REJECTED` (PR-ADMIN-001). Nothing public and nothing in the rating until `APPROVED`
  (PR-REVIEW-003).
- **`ProviderProfile.subscriptionTier`** — no transition exists in the data; expiry is a read-time
  conclusion, never a write (D3, PR-SUB-004).
- **`OtpCode`** — issued → consumed, or expired / locked after 5 failed attempts; `attempts` is a
  stored counter precisely so the limit is data, not an in-memory guess (PR-AUTH-002/003).
- **`AdminAction`** — append-only; deliberately not a state machine because there are no
  transitions (PR-ADMIN-004, AGENTS rule 21).
- **`User`** — explicitly *not* a state machine. `role` is a capability label, not a lifecycle
  stage (PR-AUTH-005/006).

## Q5 — Which models carry `createdAt`, `updatedAt`, and `deletedAt`?

**Answer (decided in `03-design-decisions.md` §5).** `createdAt` on all six models, without
exception — the dispute and rating-recomputation evidence base is reasoned about in time order.
`updatedAt` on exactly two and deliberately not the rest: only `ProviderProfile` and `Order` are
legitimately edited in place after creation. `Review`, `OtpCode`, `AdminAction`, and `User` carry no
`updatedAt` by design — an `updatedAt` on a table nothing may update is an invitation to the UPDATE
the rules forbid. No `deletedAt` anywhere: there is no soft delete in v1, every FK is
`ON DELETE RESTRICT`, and an account with history cannot be deleted today. That is the flagged
NDPR-relevant open question (PRD Open Question 11, AGENTS rule 23), not a bug to patch.

## Q6 — What does the database itself enforce, and what must stay in application code?

**Answer (decided in `03-design-decisions.md` §6).** The full inventory is C1–C15 in §6.1,
including four CHECK constraints added as raw SQL in the migration — rating cache bounds (`[0, 5]`,
`ratingCount >= 0`), `rating BETWEEN 1 AND 5`, `categories` non-empty, and a coherent featured
window (`FEATURED` implies `featuredEndsAt IS NOT NULL`) — plus the GIN index on `categories` and
`Review.orderId` unique. §6.2 records the constraints that are *deliberately absent* (e.g. no
`CHECK (agreedPriceKobo > 0)`, no state-machine invariants as CHECKs) so the next reader does not
re-add them. §6.3 is the most important table in the document: it lists every Question 3 rule the
database cannot enforce (self-order, two-party completion, review eligibility, moderation state,
append-only) and where each moves — `/modules`. One rule has **no structural defence at all**:
append-only `AdminAction` is a promise backed by the absence of UPDATE/DELETE code, not by Postgres
(OQ-9, §6.4).

## Q7 — Are primary keys natural or synthetic?

**Answer (decided in `03-design-decisions.md` §7).** Synthetic, everywhere: every primary key is
`String @id @default(cuid())`, and every foreign key is a `cuid()` referencing another `cuid()`.
`User.phone` is a unique natural key but never the identifier — it is personal data and must never
appear in a URL, log line, or referrer header (SEC-12). No sequential integers: auto-increment leaks
volume and makes enumeration trivial. No composite or natural keys, no hash of a phone number. The
uniform cuid() join graph is what makes the D2 collision the single place where a `providerId`
means something other than its name suggests.

---

## What stays open

None of the seven answers resolves an open question — each was *supposed* to keep the ones it touches
open. They are itemised in `03-design-decisions.md` §11 (OQ-1…OQ-10) and include: zero-price
validity, a second currency, the `COMPLETED → DISPUTED` contradiction, the `providerId` collision,
account deletion/NDPR, the TS-vs-SQL `FEATURED` agreement test, list-endpoint default ordering,
city on profile vs on user, and structural append-only enforcement. Two have no home in the schema
at all (**PR-AI-002** moderation list, **PR-TECH-002a** per-IP counters), recorded in
`01-requirements.md` rather than quietly designed in (DB-1).

## Correction procedure

The owner holds the brief. If the seven questions here are not the brief's seven, rebase the pairing
below against the brief — do not redebate the answers. The answers stand on their worksheets
(`03-design-decisions.md`) and their requirement IDs; a mismatch in the *question wording* changes
only the mapping, not the decision.