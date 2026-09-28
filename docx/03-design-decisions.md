# Fixora - Hard Design Decisions (Task 3, Checkpoint 3)

Each decision states the requirement it serves, the alternative that was rejected, and what the decision costs. Where the PRD is silent or self-contradictory, the decision is **flagged, not resolved** (AGENTS Q7), and appears again in §11.

> **Formatting note:** paragraphs are single-line rather than hard-wrapped, and all diagrams are pure ASCII. A previous revision of this file was destroyed by a lossy text round-trip that ate line breaks and multi-byte characters; hard wrapping is what turns a dropped line break into a dropped space and then into a corrupted word. Neither failure mode can recur with this layout.

---

## 1. Normalisation

### 1.1 What form the schema holds

| Normal form | Status | Note |
| --- | --- | --- |
| 1NF | **Compromised in one place** | `ProviderProfile.categories` is a Postgres array, not an atomic column. Deliberate — see §1.2. |
| 2NF | Holds | Every table has a single-column surrogate primary key, so no non-key attribute can depend on part of a composite key. This is the justification for synthetic ids rather than natural keys: `User.phone` is a unique natural key, but it is personal data and must never appear in a URL (SEC-12), so it cannot be the identifier. |
| 3NF | **Broken deliberately in three places** | See §3. |

### 1.2 The one repeating group: `categories`

`ServiceCategory` membership is a genuine many-to-many, modelled as a native Postgres array rather than a `ProviderProfileCategory` join table.

**Why:** PRD §10 locks the array, and the index that makes it viable is explicitly required — `CREATE INDEX ... ON provider_profiles USING GIN (categories)` (AGENTS Q2, DB-4, PR-SEARCH-001). A join table would satisfy the relationship but not the stated index requirement, and replacing the column type is a DB-1 change requiring an explicit instruction.

**What it costs:** no per-category attributes (a provider cannot have a different starting price per category), and no referential integrity on the elements themselves. The moment a provider needs per-category pricing, a bio, or a per-category rating, this must become a join table. Flagged.

---

## 2. Money

### 2.1 Representation: whole kobo integers

Every monetary field is `Int`, holding a whole number of kobo, Nigeria's smallest currency unit. 100 kobo = N1. So `agreedPriceKobo = 150000` is N1,500.00.

| Field | Type | Requirement |
| --- | --- | --- |
| `ProviderProfile.startingPriceKobo` | `Int` | PR-PROVIDER-001, PR-TECH-007 |
| `Order.agreedPriceKobo` | `Int?` | PR-ORDER-004a, PR-TECH-007 |

No `Float`, no `Decimal`, no `numeric`, anywhere (PR-TECH-007, AGENTS rule 22, DB-5). This is not stylistic: `1.15 * 100` in IEEE-754 double precision is `114.99999999999999`, so a float kobo amount is already wrong before any rounding is applied. Storing the minor unit as an integer removes the conversion from the data layer entirely. The API carries kobo integers only, and any naira/kobo conversion lives in exactly one shared utility in `/lib` using integer or string arithmetic (MB-1).

Two fields that are **not** money and must never be treated as money: `latitude`, `longitude`, `jobLatitude`, `jobLongitude` and `ratingAverage` are `Float` by design (DB-5). `ratingAverage` is an average of 1-5 ratings, not an amount.

### 2.2 No currency column - explicit decision

**The task brief asked for a currency column beside every amount. This schema has none, and that is deliberate.**

`money-billing.md` **MB-1** states: *"Every amount is a whole integer in kobo... Add no currency field: kobo implies NGN. [ASSUMPTION: NGN is the only currency in v1.]"*

Adding a `currency` column would contradict a live rule and would also add a field PRD §10 does not define (AGENTS Q7, DB-1). The brief's phrasing also reads as template boilerplate — the same brief asks this model to support "a rider with two active trips", which is not a Fixora concept at all — so it is not treated as an intentional override.

Consequence accepted: Fixora is a single-currency product in v1. If a second currency were ever needed, this is a **breaking** change — the column is not nullable-by-default, and every existing row would need a value. That is the correct cost of a single-currency assumption, and it is the assumption MB-1 makes explicitly. MB known-gap 6 and Open Question 7 both hang off this.

**To reverse this decision requires an explicit instruction naming the change as a DB-1 exception.** It is not mine to make (AGENTS Q2, DB-1).

### 2.3 Range

Prisma `Int` maps to Postgres `integer`: -2,147,483,648 to 2,147,483,647. The **positive** ceiling is **2,147,483,647 kobo (about N21,474,836.47)**. Negative values are not meaningful amounts.

`startingPriceKobo` sits comfortably inside this - it is a starting or hourly figure. `agreedPriceKobo` is less certain: PRD §10's own range note warns that a large job total or a multi-day photography contract approaches the ceiling. Widening to `BigInt` is a **type change** and needs an explicit instruction (DB-5, MB-2). Flagged, not changed.

### 2.4 Where money is validated, and what is *not* enforced in the database

MB-2 places range and sign enforcement at the **API boundary** with a 422: reject any amount that is non-integer, negative, zero, or above the ceiling, before it reaches the database. Never let an overflow surface as a 500; never clamp silently.

Therefore there is **no CHECK constraint on any money column**. Three reasons, each load-bearing:

1. MB-2 puts the rule at the boundary, and a CHECK would be a second, silently-different implementation of the same rule.
2. "Is a zero price valid?" is an **explicit unresolved question** (MB known-gap 6). A `CHECK (x > 0)` would resolve it, and resolving an open question is exactly what AGENTS Q7 forbids. MB-2's `[ASSUMPTION]` that zero is rejected is stated as the most restrictive reading, pending an answer.
3. The `integer` column type already rejects non-integers and overflows at the storage layer. That is a type guarantee, not a business rule, and it is not a substitute for MB-2.

The one money-adjacent constraint that *is* in the database is structural, not semantic: the `integer` type itself.

### 2.5 Money binds nothing

`startingPriceKobo` is informational (PR-PROVIDER-003). `agreedPriceKobo` is informational and creates no payment obligation (PR-ORDER-004a, MB-3). No code charges, holds, escrows, totals, invoices, or enforces either field, and no "amount due" appears anywhere.

`agreedPriceKobo` is written at exactly one moment, by exactly one actor - the order's provider, inside `acceptOrder()` (MB-4) - and is never edited afterwards. It is visible only to the order's customer, its provider, and Admin (PR-ORDER-011), never in search results or on a public provider profile.

Its purpose is accumulation: real pricing history from v1 onward keeps a future pivot to commission pricing possible (PRD §8). That describes data accumulating, not permission to build billing.

---

## 3. Deliberate denormalisation

Five places where the model stores something derivable. Three are load-bearing; all five are PRD-mandated and none may be removed without a DB-1 instruction.

### D1 - `ProviderProfile.ratingAverage` and `ratingCount` (aggregate cache)

**The dependency:** `ratingAverage` is a function of `Review.rating`, and every review is many rows away. This is a textbook 3NF violation.

**Why denormalise:** PRD PR-TECH-006 requires it directly - stored as a computed field, not recalculated from `Review` rows on every read. Search ranks by rating (PR-AI-001) across the whole matching candidate set; computing a mean per provider in application code would mean either N+1 queries or loading every review row for every provider on every search.

**The cost, stated plainly:** the cached value can disagree with the source rows. The mitigation is a *single-writer* rule, not a periodic repair job (DB-8):

- One function writes `ratingAverage` and `ratingCount`, and it is the only writer.
- It recomputes from the actual `APPROVED` reviews - `AVG(rating)` and `COUNT(*)` - never `+= 1`, because an increment cannot be undone correctly if a review is later un-approved.
- It runs inside the same transaction as the moderation-status change (PR-REVIEW-004, CS-5).
- A `PENDING` or `FLAGGED` review contributes nothing; a `REJECTED` review contributes nothing (PR-REVIEW-003, PR-REVIEW-005).

**Guard:** a CHECK constraint keeps the cached value inside `[0, 5]` and `ratingCount >= 0` (§6, C4). A denormalised field whose failure mode is "silently wrong" deserves at least a range fence.

### D2 - `Review.providerId` points at `ProviderProfile.id`, not derivable from the order

**The dependency:** a review's provider is fully derivable - `Review.orderId` -> `Order.providerId` -> `User.id` -> `ProviderProfile.id`.

**Why denormalise:** two read paths that run constantly would otherwise each pay a three-hop join. The rating recalculation groups by provider over `APPROVED` reviews, and the public approved-reviews list on a provider profile filters by provider and status - both are exactly what `@@index([providerId, moderationStatus])` serves. Materialising the provider makes both single-hop.

**The cost, and this is the model's sharpest edge:** it creates the `providerId` collision described in `02-data-model.md` §4.1. `Order.providerId` -> `User.id` while `Review.providerId` -> `ProviderProfile.id`, both as non-null `String`. **Nothing in the type system or in a foreign key catches a mix-up.** DB-9 requires a single conversion function in `/modules/providers` and an owner decision; that function is module code and out of Task 3's scope, so it is flagged here and in §11 as the highest-risk item in the model.

### D3 - `ProviderProfile.subscriptionTier` is stored but not authoritative

**The shape:** the stored enum is *overridden at read time*. A provider is effectively `FEATURED` only if the stored tier is `FEATURED` **and** `featuredEndsAt` is in the future by the server clock (UTC). Everything else is effectively `FREE` - including a `FEATURED` row with a null `featuredEndsAt`, which fails closed (PR-SUB-004, CS-8, MB-6).

**Why store it at all:** it is the admin's explicit decision (PR-SUB-003) and the audit trail records it, so the grant is a durable fact rather than a computation.

**The cost, and it is a serious one:** the definition now exists **twice** - once as a TypeScript function and once as a SQL expression, because ranking must run entirely in `$queryRaw` (PR-TECH-001, CS-10). If the two drift, expired providers keep a ranking boost they did not pay for. MB-6 requires a single test that runs the same four providers - live `FEATURED`, expired `FEATURED`, `FEATURED` with null end, `FREE` - through both and asserts they agree. That test is module code and is not built in Task 3. **Flagged as a required follow-up before search ships.**

Critically, expiry is **read-time only**. No scheduled job resets an expired tier to `FREE` (MB-7): such a reset would be a tier change with no admin behind it, which PR-ADMIN-004 exists to prevent.

### D4 - `Order.providerMarkedDone` is redundant with `Order.providerMarkedDoneAt`

Given DB-8 (only the mark-done function writes either) and CS-5 (it writes both in one operation), `providerMarkedDone = true` **iff** `providerMarkedDoneAt IS NOT NULL`. One of the two is derivable from the other.

It is kept anyway: PRD §10 requires the composite index `[status, providerMarkedDone, providerMarkedDoneAt]` for the sweep, and a boolean predicate is index-friendly in a way an `IS NOT NULL` test on the same column is not. Not removed - DB-1.

### D5 - `Order.autoCompleted` records something nothing else records

`autoCompleted` is not derivable from any other field. There is **no `customerConfirmedAt` column**, so the only durable record of *how* an order reached `COMPLETED` - customer confirmation, or the 72-hour sweep - is this one boolean.

That makes it load-bearing rather than redundant: AGENTS rule 11 and the UI skill both require an auto-completed order to be visibly distinguished from a customer-confirmed one, and `autoCompleted` is the only field that can do it. It is true **only** when the sweep set it (DB-8).

---

## 4. State machines

### 4.1 `Order.status` - the primary machine

Seven values, and only these seven (PR-ORDER-003, DB-2). Implemented as a Postgres enum, so an eighth value is a compile error, a migration, and a stop-and-ask.

```
                    POST /v1/orders
                           |
                           v
                   +---------------+
                   |   REQUESTED   |<-----------------+
                   +--+-------+----+                  |
                      |       |                        |
       accept         |       |  decline              | propose-time
       (provider)     |       |  (reason required)    | (status unchanged)
       or customer    |       |                        |
       accepts a      v       v                        |
       proposal  +-----------+ +-----------+          |
                  |  ACCEPTED | | DECLINED |          |
                  +--+-----+--+ +-----------+          |
                     |     |        terminal          |
        start job     |     |                           |
                     |     | cancel (either party)     |
                     v     +--------------+            |
              +-------------+             |            |
              | IN_PROGRESS |              |            |
              +--+-------+--+              |            |
                 |       |                 |            |
   mark done     |       |  cancel         |            |
   (status       |       |  (either party) |            |
    unchanged)   |       +-----------------+            |
                 |                                      |
                 |  confirm: customer, requires         |
                 |  providerMarkedDone = true           |
                 |                                      |
                 |  OR 72h sweep, autoCompleted = true  |
                 |                                      |
                 v                                      |
         +------------------+                           |
         |    COMPLETED     |                           |
         +--------+---------+                           |
                  |                                      |
      dispute     |  dispute (either party)              |
      (either)    |                                      |
                  v                                      |
         +------------------+   admin resolve           |
         |    DISPUTED      |   (note required)         |
         +------------------+--------------+            |
                                               |  back to COMPLETED
                                               |
                  +------------------+          |
                  |    CANCELLED     |<---------+
                  +------------------+
                    terminal
                    PR-ORDER-008
```

#### 4.1.1 Allowed transitions

| From | To | Actor | Side effects | Requirement |
| --- | --- | --- | --- | --- |
| - | `REQUESTED` | Customer | `status` defaulted; no price accepted | PR-ORDER-001, PR-ORDER-002 |
| `REQUESTED` | `REQUESTED` | Provider | `proposedDate` set; `status` unchanged | PR-ORDER-005 |
| `REQUESTED` | `ACCEPTED` | **Provider only** | optional `agreedPriceKobo`, written here and nowhere else | PR-ORDER-004, PR-ORDER-004a, MB-4 |
| `REQUESTED` | `ACCEPTED` | **Customer only** | `preferredDate <- proposedDate` (customer accepting a proposal) | PR-ORDER-005 |
| `REQUESTED` | `DECLINED` | Provider | `declineReason` required, <=300 chars | PR-ORDER-004 |
| `REQUESTED` | `DECLINED` | **Customer only** | customer declining a proposal | PR-ORDER-005 |
| `ACCEPTED` | `IN_PROGRESS` | **Provider only** | job started | PR-ORDER-006 |
| `ACCEPTED` | `CANCELLED` | Customer **or** Provider | `cancelReasonCode` required; `cancelledBy` set | PR-ORDER-008 |
| `IN_PROGRESS` | `CANCELLED` | Customer **or** Provider | as above | PR-ORDER-008 |
| `IN_PROGRESS` | `IN_PROGRESS` | **Provider only** | `providerMarkedDone = true`, `providerMarkedDoneAt = now()` - **both in one write** (DB-8, CS-5) | PR-ORDER-007 |
| `IN_PROGRESS` | `COMPLETED` | **Customer only**, and only if `providerMarkedDone` | `completedAt = now()`, `autoCompleted = false` | PR-ORDER-007 |
| `IN_PROGRESS` | `COMPLETED` | **Scheduled sweep only**: `providerMarkedDone = true` and `providerMarkedDoneAt < now() - 72h` | `completedAt = now()`, **`autoCompleted = true`** | PR-ORDER-007a, PR-TECH-008 |
| `IN_PROGRESS` | `DISPUTED` | Customer **or** Provider | `disputeReason` required <=1000 chars, `disputeRaisedBy` set | PR-ORDER-009 |
| `COMPLETED` | `DISPUTED` | Customer **or** Provider | as above - **disputed requirement, see §4.1.3** | PR-ORDER-009 |
| `DISPUTED` | `COMPLETED` | **Admin only** | `disputeResolutionNote` + `disputeResolvedAt` set once; new `AdminAction` row in the same transaction | PR-ORDER-009, PR-ADMIN-002, PR-ADMIN-004 |

#### 4.1.2 Forbidden transitions

These are not merely "not implemented" - each is an explicit rejection with a status code, and each is a Question 3 rule.

| Attempted | Rejected with | Rule |
| --- | --- | --- |
| Any move out of `COMPLETED`, `DECLINED`, or `CANCELLED` | 422 | AGENTS rule 14, PR-ORDER-010 - **except** the Admin dispute path from `DISPUTED` only |
| `IN_PROGRESS` -> `COMPLETED` by the **provider** | 422 | AGENTS rule 11, PR-ORDER-007 - completion is never one-sided |
| `IN_PROGRESS` -> `COMPLETED` by the **customer** when `providerMarkedDone = false` | 422 | PR-ORDER-007 |
| `IN_PROGRESS` -> `COMPLETED` by anyone, before 72h has elapsed, other than the sweep | 422 | PR-ORDER-007a, PR-TECH-008 |
| Any transition to a value outside the seven | impossible at the type level | PR-ORDER-003 - Postgres enum |
| `accept` / `decline` / `propose` by anyone but the order's provider | 403 | AGENTS rule 10, PR-ORDER-004, PR-ORDER-005 |
| Customer ordering from themselves (`Order.customerId` resolves to the same user as the target `ProviderProfile.userId`) | 422 | AGENTS rule 6, PR-ORDER-001 |
| `cancelledBy` set without a valid `CancelReasonCode` | 422 | AGENTS rule 12, PR-ORDER-008 |
| Any `DISPUTED` -> terminal move without an Admin action carrying a resolution note | 422 | AGENTS rule 13, PR-ORDER-009 |
| Reading an order that belongs to neither the customer, the provider, nor an Admin | 403 | AGENTS rule 15, PR-ORDER-011 |
| Writing `agreedPriceKobo` anywhere other than `acceptOrder()` | impossible by construction - no other module writes the column | MB-4 |
| Updating or deleting an `AdminAction` row | impossible by construction - no code path issues UPDATE or DELETE | AGENTS rule 21, PR-ADMIN-004 |

#### 4.1.3 A genuine PRD contradiction, carried forward unresolved

**PR-ORDER-009** lists `COMPLETED` -> `DISPUTED` as a transition a customer or provider may make, and the row appears in §4.1.1 above. **PR-ORDER-010** and AGENTS rule 14 say an order must never move out of a terminal status, and `COMPLETED` is named as terminal.

Both are in the PRD. They cannot both be enforced.

**The decision made here: the `COMPLETED` -> `DISPUTED` transition is included in the table above as written, because PR-ORDER-009 is the more specific requirement and it explicitly enumerates the transition.** It is *not* marked resolved, because the alternative reading - that `COMPLETED` is terminal and no dispute can follow it - is equally well-supported by the text.

What this costs: a provider who completes a job is exposed to a dispute window that the terminal-status rule was presumably written to prevent. If the owner intends `COMPLETED` to be genuinely terminal, then the dispute window closes at customer confirmation and §4.1.1 needs one row removed. **This needs an owner decision (AGENTS Q7).** Recorded in §11.

### 4.2 `Review.moderationStatus`

```
        submit review
   (only if order.status = COMPLETED,
    only by that order's customer)
              |
              v
      +----------------+
      |    PENDING     |  <-- set at INSERT; default in the database
      +-------+--------+
              |
              | automated rule-based scan
              | (deterministic, no LLM - AGENTS rule 24)
              |
      +-------+-------+-------------------+
      |                               |
      v                               v
  no keywords                    keyword/pattern match
  (automated)                    (Admin-maintained list - never
      |                           hardcoded, AGENTS rule 19)
      |                               |
      |                               v
      |                       +----------------+
      |                       |   FLAGGED     |
      |                       +-------+--------+
      |                               |
      |                      Admin reviews it
      |                               |
      |            +------------------+------------------+
      |            |                                     |
      v            v                                     v
  +----------------+  (Admin only, PR-ADMIN-001)  +----------------+
  |    APPROVED    |<------------------------------|    REJECTED    |
  +-------+--------+                               +----------------+
          |
          | side effect, same transaction (PR-REVIEW-004, CS-5):
          | recompute ProviderProfile.ratingAverage / ratingCount
          | from APPROVED reviews only
          v
  public + provider rating
```

| From | To | Who | Rule |
| --- | --- | --- | --- |
| - | `PENDING` | Customer, at INSERT | PR-REVIEW-001 - default value, not a client choice |
| `PENDING` | `FLAGGED` | Automated scan only | PR-REVIEW-002, PR-AI-002 - rule-based flagging only |
| `FLAGGED` | `APPROVED` | **Admin only** | PR-ADMIN-001, PR-REVIEW-005 |
| `FLAGGED` | `REJECTED` | **Admin only** | PR-REVIEW-005 |
| `PENDING` | `APPROVED` | **Nobody** | PR-REVIEW-005 - the automated step may only produce `PENDING` or `FLAGGED`, never an approval |
| `APPROVED` | `FLAGGED` / `REJECTED` | Admin, as a **new** decision | PR-REVIEW-005 - permitted for moderation, but the rating cache is recomputed, never decremented by hand |

Two properties that are not visible in the diagram and must not be lost: an `APPROVED` review is the only kind that appears publicly or affects the rating, and `PENDING`/`FLAGGED`/`REJECTED` contribute nothing to `ratingAverage` (PR-REVIEW-003, D1).

### 4.3 `ProviderProfile.subscriptionTier`

The stored column is **not** the effective tier. Effective tier is a read-time function (D3, MB-6, PR-SUB-004).

```
   storedTier = FREE                     storedTier = FEATURED
          |                                       |
          |                                       |
          +------------------+--------------------+
                             |
                             |  Admin grants tier
                             |  (PR-SUB-003: manual,
                             |   off-platform payment,
                             |   an AdminAction row is written)
                             v
                     +---------------+
                     |   FEATURED    |  storedTier
                     +-------+-------+
                             |
                             |  effectiveTier is computed at read time:
                             |
        +--------------------+--------------------+
        |                                         |
   featuredEndsAt IS NULL                  featuredEndsAt > now() (server clock, UTC)
        |                                         |
        v                                         v
   effectiveTier = FREE                     effectiveTier = FEATURED
   (fails closed)                            (search boost applies)
        |                                         |
        +--------------------+--------------------+
                             |
                             v
              No scheduled job resets an expired tier to FREE (MB-7).
              A reset would be a tier change with no Admin behind it,
              which is exactly what PR-ADMIN-004 exists to prevent.
```

There is no `FEATURED -> FREE` transition in the data. Expiry is expressed by `featuredEndsAt` moving into the past, and that is a read-time conclusion, never a write. CS-8 is the proof obligation: the same four fixture providers must yield the same effective tier through both the TypeScript function and the SQL expression.

### 4.4 `OtpCode`

```
   POST /v1/auth/otp/request   (max 3 per phone per hour, max 10 per IP per hour)
              |
              v
   any prior UNCONSUMED code for this phone is INVALIDATED
   (PR-AUTH-002 - requesting a new one kills the old one; not optional)
              |
              v
      +----------------+
      |    ISSUED      |  expiresAt = now() + 5 minutes
      +-------+--------+
              |
      +-------+-------------------+
      |                               |
      | 5 verification attempts     | now() > expiresAt
      | exhausted, or 5 min elapsed |
      |                               |
      v                               v
   429 LOCKED                     410 EXPIRED
              |
              |  correct code, attempts remaining, within window
              v
      +----------------+
      |  CONSUMED      |  single-use; a replayed code is rejected,
      +----------------+  not re-consumable
```

| From | To | Who | Rule |
| --- | --- | --- | --- |
| - | `ISSUED` | System, on request | PR-AUTH-002, PR-TECH-002 |
| `ISSUED` | `CONSUMED` | The user, with the correct code | PR-AUTH-002 |
| `ISSUED` | expired | Time, or 5 failed attempts | PR-AUTH-003 - 429, never a silent retry |
| any | any | Replay of a consumed code | AGENTS rule 2 - a code is single-use |
| any | any | Returned in an API response outside development | AGENTS rule 4 - SMS is the only channel |

The model stores `attempts` as a counter precisely so that "max 5 attempts" is enforceable as data rather than as an in-memory guess that resets on redeploy.

### 4.5 `AdminAction`

Append-only. There is no state machine because there are no transitions - a row is written once and never updated or deleted (AGENTS rule 21, PR-ADMIN-004).

```
   an Admin takes a consequential action
   (moderates a flagged review, resolves a dispute,
    changes a subscription tier)
              |
              v
   +----------------------------------------+
   |  INSERT one AdminAction row            |
   |  adminUserId, actionType, targetType,  |
   |  targetId, note, createdAt              |
   |                                         |
   |  same transaction as the change it      |
   |  describes (PR-ADMIN-002, CS-5)         |
   +----------------------------------------+
              |
              |  no UPDATE path exists
              |  no DELETE path exists
              v
   a later correction is a NEW row with the same targetId
   and a note that references the row it corrects
```

`targetId` is deliberately **not** a foreign key. It is polymorphic: the same column holds a `Review.id`, an `Order.id`, or a `ProviderProfile.id` depending on `actionType`. A foreign key is impossible, and a `targetType` discriminator is the only thing that makes the column interpretable. **The database cannot enforce that `targetId` points at a row of the type `targetType` claims** - see §6.3.

### 4.6 `User`

**There is no state machine for `User`, and inventing one would be the wrong answer.** `role` is a capability label, not a lifecycle stage: a user does not progress from one role to another, and there is no transition to guard.

The two properties that could be mistaken for a state machine, and what actually holds them:

| Property | Is it a state? | What actually holds it |
| --- | --- | --- |
| `role` (`CUSTOMER` / `PROVIDER` / `ADMIN`) | No | Set at account creation; **never** reachable through public signup for `ADMIN`, and no `CUSTOMER` or `PROVIDER` path exists to become `ADMIN` (AGENTS rule 5, PR-AUTH-006) |
| Having a `ProviderProfile` | No | Independent of `role` - a `CUSTOMER` may hold one, and a `PROVIDER` may place orders as a customer under the same account (PR-AUTH-005) |

This is why role is a capability hint and not a wall, and simultaneously why an order is still rejected with 422 when the customer and the target provider are the same user (AGENTS rule 6, PR-ORDER-001). The first rule without the second is a rating-manipulation hole.

---

## 5. `createdAt`, `updatedAt`, `deletedAt`

### 5.1 `createdAt` - on every model, without exception

All six models carry `createdAt DateTime @default(now())`. This is not a style preference: `AdminAction` rows and `Order` rows are the evidence base for disputes and for rating recomputation, and both are reasoned about in time order. A row without a creation timestamp cannot be ordered against another row reliably.

`ProviderProfile.ratingCount` and `ratingAverage` are the only *derived* values in the schema, and neither carries its own timestamp - the timestamp of the change is the timestamp of the `AdminAction` / moderation that caused it (D1, PR-REVIEW-004).

### 5.2 `updatedAt` - on exactly two models, and that is a decision, not an omission

Only `ProviderProfile` and `Order` carry `updatedAt`, because those are the only two entities with a legitimate reason to be *edited in place* after creation:

- `Order.proposedDate` changes when the provider proposes an alternate time (PR-ORDER-005), and `status` / `providerMarkedDone` / `agreedPriceKobo` change across the lifecycle.
- `ProviderProfile` is editable: bio, categories, starting price, and the admin-set subscription fields.

`Review`, `OtpCode`, `AdminAction`, and `User` have no `updatedAt` **on purpose**: none of them is edited after creation. A review is moderated by writing a new moderation decision, not by mutating the review; an OTP is consumed or expires; an `AdminAction` is append-only. An `updatedAt` on any of them would be a column that is *expected* to move and must not - a quiet invitation to a future `UPDATE` that the rules forbid.

### 5.3 `deletedAt` - no model has one, and that is the decision

No model carries `deletedAt`. There is no soft delete in v1.

**Why:** PRD §10 defines no such column on any of the six models, and AGENTS rule 23 forbids switching an `onDelete: Restrict` relation to `Cascade` or `SetNull` to make deletion work. Every relation in this schema is `Restrict`, which means an account with order or review history **cannot be deleted at all** today. That is a real limitation, not an oversight, and it is the flagged NDPR-relevant open question (PRD Open Question 11).

Adding `deletedAt` to every model "to fix" this would be the wrong fix twice over: it would be a DB-1 change to six models that PRD §10 does not license, and it would create the false impression that deletion is solved. Account deletion needs a product decision on what happens to a user's orders, reviews, and ratings - and to a provider's public rating history, which is other customers' data. **Not resolved here. Recorded in §11.**

---

## 6. Constraints

### 6.1 Complete constraint inventory

Everything the database itself enforces, and where each one comes from. Anything not on this list is not guaranteed by Postgres - it is module behaviour, and §6.3 says which.

| # | Constraint | Enforced by | What it guarantees | Requirement |
| --- | --- | --- | --- | --- |
| C1 | `User.phone` UNIQUE | unique index | one account per phone number | PR-AUTH-001, SEC-1 |
| C2 | `OtpCode.phone` + expiry + attempt counters | columns + module logic | single-use, 5-minute window, max 5 attempts | PR-AUTH-002, PR-AUTH-003 |
| C3 | `Order.customerId` -> `User.id`, `ON DELETE RESTRICT` | FK | an order always has a real customer; users with history cannot be deleted | AGENTS rule 23 |
| C4 | `ProviderProfile.ratingAverage BETWEEN 0 AND 5`, `ratingCount >= 0` | **CHECK (added in migration)** | the D1 cache cannot drift outside a plausible range | PR-TECH-006, D1 |
| C5 | `Review.rating BETWEEN 1 AND 5` | **CHECK (added in migration)** | a rating outside 1-5 is unrepresentable | PR-REVIEW-002 |
| C6 | `ProviderProfile.categories` non-empty | **CHECK (added in migration)** | a provider cannot be listed in zero categories | PR-PROVIDER-002, PR-SEARCH-001 |
| C7 | Featured window is coherent: `FEATURED` implies `featuredEndsAt IS NOT NULL` | **CHECK (added in migration)** | D3's "null end fails closed" is a stored invariant, not only a read-time convention | PR-SUB-004, MB-6 |
| C8 | `Review.orderId` UNIQUE | unique index | **one review per order**, enforced by the database | PR-REVIEW-001 |
| C9 | `Review.providerId` -> `ProviderProfile.id`, `ON DELETE RESTRICT` | FK | a review always points at a real profile | PR-REVIEW-001 |
| C10 | `Order.agreedPriceKobo`, `ProviderProfile.startingPriceKobo` are `integer` | column type | no float, no decimal, no overflow below the type ceiling | PR-TECH-007, AGENTS rule 22 |
| C11 | `latitude` / `longitude` bounds (implicit in `Float` + module validation) | module, not DB | coordinate validity | PR-TECH-001 |
| C12 | All seven enum types (`UserRole`, `ServiceCategory`, `OrderStatus`, `CancelReasonCode`, `ReviewModerationStatus`, `SubscriptionTier`, `AdminActionType`) | Postgres `ENUM` | **an eighth `OrderStatus` cannot exist at all** | PR-ORDER-003, AGENTS rule 9 |
| C13 | `categories` GIN index | **index (added in migration)** | the array is filterable without a join table | PR-SEARCH-001, AGENTS Q2 |
| C14 | Every FK is `ON DELETE RESTRICT`, none is `CASCADE` or `SET NULL` | FK definitions | no silent cascade can destroy order or review history | AGENTS rules 23, 21 |
| C15 | `ProviderProfile.userId` UNIQUE | unique index | one profile per user; a `PROVIDER` role is backed by exactly one profile | PR-AUTH-005 |

The four **CHECK constraints (C4, C5, C6, C7) and the GIN index (C13) are not expressible in Prisma's schema DSL** and are added as raw SQL in the migration, with a comment naming the requirement each one serves.

### 6.2 Proposed check constraints that are deliberately **not** added

Each of these is a constraint that *could* be written and is intentionally absent. Recording the refusals matters as much as recording the additions, because the next person to read the schema will have the same idea.

| Candidate | Why not | Rule |
| --- | --- | --- |
| `CHECK (agreedPriceKobo > 0)` | MB-2 places the rule at the API boundary, and "is zero valid?" is an explicitly unresolved question. A CHECK would silently answer it. | §2.4, MB-2, MB known-gap 6 |
| `CHECK (status IN ('REQUESTED', ...))` | Redundant. `OrderStatus` is a Postgres enum; the type is the constraint. | PR-ORDER-003 |
| `CHECK (completedAt IS NOT NULL) WHERE status = 'COMPLETED'` | Tempting, and it would hold. But `completedAt` is written exclusively by `confirmCompletion()` and `autoCompleteStale()` (CS-5), and adding a state-machine invariant as a CHECK is a DB-1 change. Deferred until someone asks, not silently added. | AGENTS rule 11, CS-5 |
| `CHECK (declineReason IS NOT NULL) WHERE status = 'DECLINED'` | Same reasoning as above: a transition function owns the invariant. | PR-ORDER-004 |
| `CHECK (ratingCount <= (SELECT COUNT(*) FROM review ...))` | Not expressible. CHECK cannot contain a subquery, and it could not be written without referring to another table by name. | PR-TECH-006 |
| `CHECK (disputeResolvedAt IS NOT NULL) WHERE status = 'COMPLETED'` | Would encode one side of the unresolved §4.1.3 contradiction. | §4.1.3 |
| `CHECK (deletedAt IS NULL)` | No `deletedAt` exists. | §5.3, AGENTS rule 23 |

### 6.3 What no constraint can enforce, and where the work moves to `/modules`

This is the most important section in the document. The schema is structurally sound and enforces almost none of the Question 3 rules. Every rule below is module behaviour, and a reviewer should assume it is **not** implemented until they see the function and its test.

| Rule | Why the database cannot do it | Where it lives |
| --- | --- | --- |
| A provider can never order from themselves (AGENTS rule 6) | Requires comparing `Order.customerId` against the *resolved* `User.id` behind a `ProviderProfile`. The FK cannot see through the join. | `/modules/orders` - guarded write |
| Only the order's provider may accept, decline, or propose (AGENTS rule 10) | The database has no concept of "the caller". | `/modules/orders` - `acceptOrder()`, `declineOrder()` |
| Completion is never one-sided (AGENTS rule 11) | Requires knowing both that the provider marked done **and** that the customer is the one confirming. | `/modules/orders` - `markProviderDone()`, `confirmCompletion()` |
| A review needs a `COMPLETED` order, from that order's customer, once (AGENTS rule 16) | A CHECK cannot reference another table. The unique index gives "once" but not "only after completion" or "by the customer". | `/modules/reviews` - guarded INSERT |
| A review affects nothing until `APPROVED` (AGENTS rule 17) | `moderationStatus` is a column any writer could set. Only code decides. | `/modules/reviews` |
| Moderation never auto-rejects (AGENTS rule 18) | The automated step is code. | `/modules/reviews` |
| The keyword list is Admin-maintained, never hardcoded (AGENTS rule 19) | It is configuration, not structure. | `/modules/reviews` + Admin table |
| `AdminAction` is append-only (AGENTS rule 21) | **Postgres cannot make a table append-only.** There is no constraint, trigger, or rule that prevents `UPDATE` or `DELETE`. It is a promise made by the absence of code that would do it, backed by audit. | `/modules/admin` - no writer but `INSERT` |
| `cancelReasonCode` is required, not free text (AGENTS rule 12) | The enum makes the *value* valid; nothing makes it *present*. | `/modules/orders` - `cancelOrder()` |
| A `DISPUTED` order never resolves itself (AGENTS rule 13) | Requires a scheduled job to deliberately *not* act. | `/jobs` + `/modules/admin` |
| Terminal statuses never move (AGENTS rule 14) | A CHECK cannot express "this row's previous value". | `/modules/orders` - every transition function |
| Order reads are limited to customer, provider, Admin (AGENTS rule 15) | The row has no idea who is asking. | `/modules/orders` - `getOrder()` |
| The `FEATURED` definition in TS and in SQL agree (D3) | Two implementations of one rule. | `/modules/search` - the MB-6 test |
| `ratingAverage` matches its source rows (D1) | A cached aggregate cannot self-verify. | `/modules/reviews` - single-writer recompute |
| `Review.providerId` and `Order.providerId` refer to different kinds of id (D2) | Both are non-null `String` with different FK targets. A value is type-correct either way. | `/modules/providers` - DB-9 conversion function |

**Guarded writes, not read-then-write.** Every check above depends on current state, so it is expressed as part of the write - `updateMany` with the expected `status` in the `where` clause, asserting exactly one row changed - rather than a `findUnique` followed by an `update`. A provider cannot accept an order that was cancelled between the read and the write, because the read is not what authorises the write.

### 6.4 A note on the append-only guarantee

`AdminAction` being append-only is the one Question 3 rule with **no structural defence at all**. The rows are plain table rows; any migration, script, or future feature that issues `UPDATE admin_actions` or `DELETE FROM admin_actions` will succeed, and nothing in the schema will object.

This is worth stating plainly rather than presenting as "enforced". The mitigation is threefold and entirely procedural: no module in the codebase issues an `UPDATE` or `DELETE` against the table; the correction path is a new row referencing the same `targetId`; and a correct change is distinguishable from its correction by reading the trail. If append-only ever needs to be structural, it requires a rule or a trigger, which is a DB-1 change and an owner decision. Recorded in §11.

---

## 7. Identifiers

Every primary key is `String @id @default(cuid())`.

**Why a synthetic, non-sequential id:**

- **`User.phone` cannot be the key.** It is a unique natural key, but it is personal data and must never appear in a URL, a log line, or a referrer header (SEC-12). Using it as an identifier would leak the account's phone number to anyone holding a link.
- **Sequential integers leak volume.** An auto-increment reveals how many users, orders, and reviews exist, and it makes enumeration trivial - `GET /v1/orders/1041` would let a stranger walk the whole table. AGENTS rule 15 is about *authorisation*; non-sequential ids are what make authorisation failures non-trivial to exploit.
- **`cuid()` is URL-safe and short enough** to sit in a path segment without a second encoding layer.

**What is deliberately not an identifier:** no composite keys, no natural keys anywhere, no hash of a phone number. Every foreign key in the schema is a `cuid()` referencing another `cuid()`, which keeps the join graph uniform and makes the D2 collision (§3) the single place where a `providerId` means something other than what its name suggests.

---

## 8. Indexes for the five most important user actions

The five actions are defined in `01-requirements.md`: **A1** find a provider, **A2** place an order, **A3** respond to a request, **A4** complete / cancel / dispute, **A5** review a completed order.

### 8.1 The audit

| Index | Columns | Serves | Requirement | In schema? |
| --- | --- | --- | --- | --- |
| `users_city_latitude_longitude_idx` | `city, latitude, longitude` | A1 - bounding-box prefilter before haversine | PR-TECH-001 | yes, via Prisma |
| `provider_profiles_categories_gin_idx` | `categories` (GIN) | A1 - category filter without a join table | PR-SEARCH-001, AGENTS Q2 | **no - raw SQL in migration** |
| `orders_status_providerMarkedDone_providerMarkedDoneAt_idx` | `status, providerMarkedDone, providerMarkedDoneAt` | A4 - the 72-hour sweep's predicate | PR-TECH-008, PR-ORDER-007a | yes, via Prisma |
| `orders_customerId_status_idx` | `customerId, status` | A2, A4 - "my orders" | PR-ORDER-011 | yes, via Prisma |
| `orders_providerId_status_idx` | `providerId, status` | A3, A4 - the provider's incoming queue | PR-ORDER-004 | yes, via Prisma |
| `reviews_orderId_key` (unique) | `orderId` | A5 - one review per order | PR-REVIEW-001 | yes, via Prisma |
| `reviews_providerId_moderationStatus_idx` | `providerId, moderationStatus` | A5 - approved-reviews list; D1 rating recompute | PR-TECH-006, D2 | yes, via Prisma |
| `reviews_moderationStatus_idx` | `moderationStatus` | Admin moderation queue | PR-ADMIN-001 | yes, via Prisma |
| `provider_profiles_subscriptionTier_featuredEndsAt_idx` | `subscriptionTier, featuredEndsAt` | A1 - featured boost window (D3) | PR-SUB-004 | yes, via Prisma |
| `otp_codes_phone_idx`, `otp_codes_expiresAt_idx` | `phone`, `expiresAt` | OTP lookup and expiry sweep | PR-AUTH-002, PR-AUTH-003 | yes, via Prisma |
| `admin_actions_targetId_idx` | `targetId` | audit trail for one entity | PR-ADMIN-004 | yes, via Prisma |
| `ProviderProfile.userId` (unique) | `userId` | one profile per user | PR-AUTH-005 | yes, via Prisma |

**Twelve indexes serve the five actions; one of them cannot be expressed in Prisma's DSL and must be added as raw SQL.** That is the GIN index on `categories`, and per AGENTS Q2 it is a build prerequisite for `PR-SEARCH-001`, not an optional tuning step.

### 8.2 Per action

```
A1  find a provider
    |
    +-- city + bounding box   -> users_city_latitude_longitude_idx
    |                            (prefilter only; exact haversine distance
    |                             and the final sort/limit are computed in
    |                             the SAME $queryRaw, never in app code)
    +-- category filter       -> provider_profiles_categories_gin_idx   [raw SQL]
    +-- featured boost        -> provider_profiles_subscriptionTier_featuredEndsAt_idx
    |                            (D3: effective tier, read-time)
    +-- rating sort           -> ratingAverage, denormalised (D1) so no
    |                            per-provider aggregate is needed at sort time

A2  place an order
    |
    +-- self-order check      -> NOT an index; a guarded write in
    |                            /modules/orders (AGENTS rule 6)
    +-- customer's order list -> orders_customerId_status_idx

A3  respond to a request
    |
    +-- provider queue        -> orders_providerId_status_idx
    +-- accept / decline      -> NOT an index; transition functions
                                 (AGENTS rule 10)

A4  complete / cancel / dispute
    |
    +-- 72h sweep              -> orders_status_providerMarkedDone_providerMarkedDoneAt_idx
    |                            (exactly the sweep predicate; PR-TECH-008)
    +-- order read            -> orders_customerId_status_idx / orders_providerId_status_idx
    +-- dispute resolution    -> admin_actions_targetId_idx

A5  review a completed order
    |
    +-- one review per order  -> reviews_orderId_key  (UNIQUE - the database
    |                            itself refuses the second review)
    +-- eligibility check     -> NOT an index; a guarded INSERT against
    |                            order.status = COMPLETED and order.customerId
    +-- approved list         -> reviews_providerId_moderationStatus_idx
    +-- rating recompute      -> reviews_providerId_moderationStatus_idx (D1)
```

### 8.3 Net result

Of the five actions, **A1, A2, A4, and A5 each have at least one index whose leading columns match the query predicate exactly.** A3 is the exception and is deliberate: the provider's queue is a small, per-user list read on every dashboard load, and `orders_providerId_status_idx` covers it — but the *authorisation* half of A3 is a function call, not an index, and no index can supply it.

The critical property is that **the 72-hour sweep and the one-review-per-order rule are the two places where the index and the constraint do structural work**: the sweep's predicate is a prefix match on a three-column composite index, and the unique index on `Review.orderId` makes a duplicate review impossible at the storage layer rather than merely rejected by application code.

### 8.4 A gap in the list endpoints, flagged

Both "my orders" and "my reviews" lists will eventually be paginated by `(createdAt, id)`. Neither `orders_customerId_status_idx` nor `reviews_providerId_moderationStatus_idx` serves a `WHERE customerId = $1 ORDER BY createdAt DESC` efficiently once a customer has more than a few hundred orders - the index is ordered by `status`, so the sort is still a sort.

The fix is a `@@index([customerId, createdAt])`, and it is **not** added here. Task 3 covers the five actions as defined, and this index serves a pagination concern that `01-requirements.md` does not yet state. Flagged in §11 rather than added on my own initiative, because adding an index is cheap but the decision of what the list endpoint's default ordering should be is a product decision.

---

## 9. Summary of what the database guarantees, and what it cannot

**The database guarantees** (structurally, today, with no application code running):

- Types and nullability. No `Float` or `Decimal` money, ever (C10). No eighth `OrderStatus` (C12).
- Referential integrity. Every FK is `Restrict` (C14); no cascade can destroy history.
- Uniqueness where it is a correctness rule: one account per phone (C1), one profile per user (C15), **one review per order** (C8).
- Bounded values: rating in 1-5 (C5), rating cache in 0-5 (C4), a non-empty category list (C6), a coherent featured window (C7).
- That a category filter and a proximity search are indexable at all (C13, `users_city_latitude_longitude_idx`).
- That the 72-hour sweep's predicate is a prefix match rather than a full scan (PR-TECH-008 index).

**The database cannot guarantee, and does not attempt to guarantee:**

- That a provider did not order from themselves. That nobody but the provider accepted. That completion was two-sided.
- That a review came from a completed order, or that it was submitted by that order's customer.
- That a review is invisible until `APPROVED`, or that moderation never auto-rejects.
- That `AdminAction` rows are append-only. **There is no structural defence whatsoever** (§6.4).
- That the TypeScript and SQL definitions of "effectively `FEATURED`" agree (D3), or that `ratingAverage` matches its source rows (D1), or that the two different `providerId` columns are not confused (D2).
- That an order which is `DISPUTED` will ever be resolved, or that a stale `DISPUTED` order is not simply abandoned (AGENTS rule 13 - there is no auto-resolution path, and inventing one is forbidden).

**The one-line version:** this schema guarantees the *shape* of the data and almost none of the *rules*. The rules live in `/modules`, and the gap between those two sentences is the whole of §6.3.

---

## 10. Requirement trace for this checkpoint

The **Action** column is the link back to `01-requirements.md`. A requirement with no action is either infrastructure (`PR-TECH-*`, `SEC-*`, `DB-*`) or an admin capability that exists to serve one.

| Requirement | Action | Where it is satisfied in this document |
| --- | --- | --- |
| PR-AUTH-001 | - | §4.4 (OTP lifecycle); phone is PII, so it is never an id (§7) |
| PR-AUTH-002 | - | §4.4 - single-use, 5-minute window, new request invalidates the old code |
| PR-AUTH-003 | - | §4.4 - max 5 attempts, 429 not a silent retry |
| PR-AUTH-005 | A2 | §4.6, §6.1 C15 - one profile per user; role is not a capability wall |
| PR-AUTH-006 | - | §4.6 - `ADMIN` is not reachable from public signup |
| PR-PROVIDER-001 | A1 | §2.1 - `startingPriceKobo` is an integer kobo amount |
| PR-PROVIDER-002 | A1 | §6.1 C6 - a listed provider has at least one category |
| PR-PROVIDER-003 | A1 | §2.5 - the starting price binds nothing |
| PR-PROVIDER-004 | - | §6.3 - phone revealed only through an order relationship (module) |
| PR-SEARCH-001 | A1 | §1.2, §6.1 C13, §8.1 - GIN index on the array is a build prerequisite |
| PR-AI-001 | A1 | §3 D1 - rating stored so the sort needs no per-provider aggregate |
| PR-AI-002 | A1 | §4.2 - rule-based flagging only, never an LLM |
| PR-ORDER-001 | A2 | §4.1.2, §6.3 - self-order rejected with 422 |
| PR-ORDER-002 | A2 | §4.1.1 - status defaulted at creation |
| PR-ORDER-003 | A2, A3, A4 | §4.1, §6.1 C12 - seven values, Postgres enum |
| PR-ORDER-004 | A3 | §4.1.1, §4.1.2 - provider only |
| PR-ORDER-004a | A3 | §2.1, §2.5 - `agreedPriceKobo` written once, by one actor, binding nothing |
| PR-ORDER-005 | A3 | §4.1.1 - proposal is a self-transition; either party may respond |
| PR-ORDER-006 | A4 | §4.1.1 - provider only starts the job |
| PR-ORDER-007 | A4 | §4.1.1, §4.1.2 - completion is never one-sided |
| PR-ORDER-007a | A4 | §4.1.1 - sweep sets `autoCompleted = true`; §3 D5 |
| PR-ORDER-008 | A4 | §4.1.1, §6.3 - `cancelReasonCode` is required, not free text |
| PR-ORDER-009 | A4 | §4.1.3 - resolution is Admin-only, with a note; **contradiction flagged** |
| PR-ORDER-010 | A4 | §4.1.2 - terminal statuses do not move |
| PR-ORDER-011 | A4 | §4.1.2, §8.1 - read access is customer, provider, or Admin |
| PR-REVIEW-001 | A5 | §6.1 C8 - one review per order, unique index |
| PR-REVIEW-002 | A5 | §6.1 C5 - rating bounded 1-5 |
| PR-REVIEW-003 | A5 | §4.2 - non-`APPROVED` reviews are invisible and uncounted |
| PR-REVIEW-004 | A5 | §3 D1 - recompute in the same transaction as moderation |
| PR-REVIEW-005 | A5 | §4.2 - only an Admin sets `APPROVED` or `REJECTED` |
| PR-ADMIN-001 | A5 | §4.2 - the Admin moderation queue |
| PR-ADMIN-002 | A4 | §4.5 - AdminAction written in the same transaction as the change |
| PR-ADMIN-004 | A4, A5 | §4.5, §6.4 - append-only, and the lack of structural defence stated plainly |
| PR-SUB-003 | - | §4.3 - manual Admin grant, no automated billing |
| PR-SUB-004 | A1 | §4.3, §6.1 C7 - effective tier computed at read time, fails closed |
| PR-TECH-001 | A1 | §8.1, §8.2 - bounding-box prefilter, exact distance in the same query |
| PR-TECH-006 | A1, A5 | §3 D1 - denormalised rating cache, single writer |
| PR-TECH-007 | A1, A2, A3 | §2.1 - integer kobo everywhere, no float |
| PR-TECH-008 | A4 | §4.1.1, §8.1 - the sweep's predicate is an index prefix match |
| PR-TECH-002 | - | §4.4 - SMS is the only delivery channel |

---

## 11. Open items - flagged, not resolved

None of these is mine to decide. Each one is a question with a live PRD dependency, and each is recorded here rather than answered with a convenient guess (AGENTS Q7).

| # | Open item | Why it is not resolved here | Reference |
| --- | --- | --- | --- |
| OQ-1 | Is a zero price valid? | MB-2 assumes rejected, as the most restrictive reading. A `CHECK (x > 0)` would silently settle it. | MB known-gap 6, §2.4 |
| OQ-2 | Does a second currency ever appear? | MB-1 assumes NGN-only in v1. The cost of being wrong is a breaking migration. | §2.2, Open Question 7 |
| OQ-3 | Can a `COMPLETED` order be disputed? | PR-ORDER-009 and PR-ORDER-010 contradict each other. Both readings are well-supported. | §4.1.3 |
| OQ-4 | `Order.providerId` -> `User.id` but `Review.providerId` -> `ProviderProfile.id` | No type system or foreign key can catch the mix-up. Needs one conversion function and an owner decision. | §3 D2, DB-9 |
| OQ-5 | What does account deletion do to orders, reviews, and public rating history? | `Restrict` makes deletion impossible today. This is an NDPR-relevant question, and a provider's rating history is other customers' data. | §5.3, AGENTS rule 23, Open Question 11 |
| OQ-6 | How is the TypeScript/SQL `FEATURED` definition kept in agreement? | MB-6 requires one test; it is module code and out of Task 3's scope. **Required before search ships.** | §3 D3, MB-6 |
| OQ-7 | What is the default ordering for "my orders" and "my reviews"? | Determines whether a `(customerId, createdAt)` index is needed. A product decision, not a schema one. | §8.4 |
| OQ-8 | Should `ProviderProfile` carry a city, or only coordinates? | PRD §10 defines `latitude`/`longitude` but no city, while `users.city` exists. This changes whether a city filter is a join or a column. | §8.1, PRD §10 |
| OQ-9 | `AdminAction` append-only has no structural enforcement | Postgres offers no append-only table. A trigger or a rule is a DB-1 change. | §6.4 |
| OQ-10 | **The migration has never been applied.** | The generated SQL has been reviewed statically, but no database has ever run it, and no query plan, seed run, or invalid-state rejection has been observed. Every "index serves this query" claim in §8 is a *design* claim until `05-schema-proof.md` records an `EXPLAIN ANALYZE`. | §8, `05-schema-proof.md` |
