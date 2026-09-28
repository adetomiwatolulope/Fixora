# Fixora - Schema Proof (Task 3, Checkpoint 5)

This document records what has been **verified** about the Fixora schema, and — just as importantly — what has **not** been verified, because those are different things and only the first is evidence.

**Read §3 before trusting §8 of `03-design-decisions.md`.** Every index claim in that document is a *design* claim until a plan file says otherwise.

---

## 1. Verification status at a glance

| Check | Status | Evidence |
| --- | --- | --- |
| Prisma schema is syntactically valid | **VERIFIED** | `npx prisma validate` -> `The schema at prisma\schema.prisma is valid` |
| TypeScript strict compiles, zero errors | **VERIFIED** | `npx tsc --noEmit` -> 0 errors |
| Prisma client generates from the schema | **VERIFIED** | `npx prisma generate` -> Prisma 6.19.3, client emitted |
| Migration SQL generates, offline | **VERIFIED** | `npx prisma migrate diff --from-empty --to-schema-datamodel` -> 6,747 bytes of DDL |
| Migration contains no destructive statement | **VERIFIED** | scanned for `DROP TABLE/COLUMN/TYPE`, `TRUNCATE`, `ALTER COLUMN ... TYPE` -> none |
| GIN index on `categories` is present in the migration | **VERIFIED** | `provider_profiles_categories_gin_idx` in `migration.sql` |
| All four CHECK constraints are present in the migration | **VERIFIED** | see §2.2 |
| Every FK is `ON DELETE RESTRICT` | **VERIFIED** | 7 FKs, all `RESTRICT`; see §2.3 |
| No money field is a float or decimal | **VERIFIED** | both money columns emit `INTEGER`; see §2.1 |
| **`Order.status` is a Postgres enum** | **VERIFIED** | `CREATE TYPE "OrderStatus" AS ENUM (...)` with exactly 7 values |
| Migration **applied** to a live database | **VERIFIED** | `npx prisma migrate deploy` against PostgreSQL 16.15; 6 domain tables + `_prisma_migrations`, 23 indexes, 7 FKs, 4 CHECKs, 1 GIN |
| Seed runs and satisfies DB-13 | **VERIFIED** | `npm run db:seed` -> exit 0; 7 users, 5 profiles, 4 OTP codes, 8 orders, no `ADMIN`, no `COMPLETED` order, no `APPROVED` review |
| Fixtures build the test world | **VERIFIED** | `npm run proof:fixtures` -> exit 0; test-only admin, completed orders, moderated reviews |
| A1-A5 execute | **VERIFIED** | `npm run proof:queries` -> **30 checks, 0 failures** |
| `EXPLAIN ANALYZE` confirms index usage | **VERIFIED** | `npm run proof:plans` -> **11 checks, 0 failures**, 4 plans, 50k users + 40k orders |
| Invalid states are rejected by the database | **VERIFIED** | `npm run proof:constraints` -> **11 checks, 0 failures**; real `SQLSTATE 23514` / `23505` / `23514` |

**All fifteen checks pass. `npm run proof` runs the whole chain and exits 0.**

Verification was done against a disposable PostgreSQL 16.15 instance on `127.0.0.1:5433` under
`%LOCALAPPDATA%\Temp\opencode\pg16`, reached through `.env.proof`. The pre-existing service on port
5432 was never touched and `.env` still holds its original `REPLACE_ME` placeholder.

### 1.1 The verification totals

| Stage | Script | Checks | Failures |
| --- | --- | --- | --- |
| Five action queries A1-A5 | `five-queries.ts` | 30 | 0 |
| Query plans | `query-plans.ts` | 11 | 0 |
| Rejected invalid states | `invalid-states.ts` | 11 | 0 |
| **Total** | | **52** | **0** |

Full verbatim output is in `evidence/03-query-plans.md` and `evidence/04-constraint-violations.md`,
with three rendered `psql` sessions in `evidence/screenshots/`.

---

## 2. What was verified, and how

### 2.1 No money field is a float or decimal

Generated directly from the DDL Prisma emits:

| Column | Emitted type | Verdict |
| --- | --- | --- |
| `provider_profiles.startingPriceKobo` | `INTEGER` | integer kobo |
| `orders.agreedPriceKobo` | `INTEGER` | integer kobo, nullable |
| `provider_profiles.ratingAverage` | `DOUBLE PRECISION` | **not money** - a 1-5 average, `Float` by design (DB-5) |
| `users.latitude` / `users.longitude` | `DOUBLE PRECISION` | **not money** - coordinates |

`DECIMAL`, `NUMERIC`, and `FLOAT` appear nowhere in any monetary column, satisfying PR-TECH-007 and AGENTS rule 22. The two `DOUBLE PRECISION` uses are the documented non-money exceptions and are called out here precisely so a future reviewer does not read them as a violation.

### 2.2 The four CHECK constraints and the GIN index

All five are present in `prisma/migrations/0_init/migration.sql` and none is expressible in Prisma's schema DSL:

| Name | Enforces | Requirement |
| --- | --- | --- |
| `provider_profiles_categories_gin_idx` | GIN index over the `categories` array | PR-SEARCH-001, AGENTS Q2, DB-4 |
| `provider_profiles_rating_bounds` | `ratingAverage BETWEEN 0 AND 5 AND ratingCount >= 0` | PR-TECH-006, D1 |
| `reviews_rating_between_1_and_5` | `rating BETWEEN 1 AND 5` | PR-REVIEW-002 |
| `provider_profiles_categories_at_least_one` | `cardinality(categories) >= 1` | PR-PROVIDER-002 |
| `provider_profiles_featured_window_valid` | `subscriptionTier <> 'FEATURED' OR featuredEndsAt IS NOT NULL` | PR-SUB-004, MB-6, D3 |

**These are verified as *present in the DDL*, not as *accepted by Postgres*.** `cardinality()` on an enum array and the `ALTER TABLE ... ADD CONSTRAINT ... CHECK` forms are both standard PostgreSQL and are expected to apply cleanly, but "expected to" is not "observed to" and this document does not pretend otherwise. That confirmation requires execution.

### 2.3 Every FK is `ON DELETE RESTRICT`

All seven, verified in the generated DDL:

| FK | References | Delete rule |
| --- | --- | --- |
| `provider_profiles_userId_fkey` | `users(id)` | RESTRICT |
| `orders_customerId_fkey` | `users(id)` | RESTRICT |
| `orders_providerId_fkey` | `users(id)` | RESTRICT |
| `reviews_orderId_fkey` | `orders(id)` | RESTRICT |
| `reviews_customerId_fkey` | `users(id)` | RESTRICT |
| `reviews_providerId_fkey` | **`provider_profiles(id)`** | RESTRICT |
| `admin_actions_adminId_fkey` | `users(id)` | RESTRICT |

No `CASCADE`, no `SET NULL` (AGENTS rules 21, 23). This is also where **D2 becomes undeniable**: `orders.providerId` references `users(id)` while `reviews.providerId` references `provider_profiles(id)`. Two columns with the same name, both non-null `TEXT`, pointing at different tables. Nothing in the type system or in a foreign key can catch a mix-up between them. See OQ-4.

### 2.4 `Order.status` cannot take an eighth value

```sql
CREATE TYPE "OrderStatus" AS ENUM (
  'REQUESTED', 'ACCEPTED', 'DECLINED', 'IN_PROGRESS',
  'COMPLETED', 'CANCELLED', 'DISPUTED'
);
```

Seven values, matching AGENTS rule 9 and PR-ORDER-003. An eighth would require a migration - a deliberate stop-and-ask, not an edit.

### 2.5 The migration is additive and non-destructive

Generated from an empty schema to the current one, then scanned. `DROP TABLE`, `DROP COLUMN`, `DROP TYPE`, `TRUNCATE`, and `ALTER COLUMN ... TYPE` all return zero matches. This satisfies the Checkpoint 5 rule that the initial migration must not drop or narrow anything.

---

## 3. What is still not verified, and why

The six obligations that were outstanding when this document was first written have all been run
against a live database. Two earlier blockers are gone: a disposable PostgreSQL 16.15 cluster on port
5433 was initialised successfully (the earlier `%LOCALAPPDATA%\Temp\opencode\fixora-pg` attempt died
with `0xC0000142`, and the Docker daemon was not running), and the migration applied cleanly.

**No credentials from any other project were used.** The temp directory contains production database
URLs belonging to unrelated applications; borrowing them would have been out of scope and potentially
destructive.

### 3.1 What a live database still cannot prove

Running the SQL proves the *schema* behaves. It does not prove the *product* works, because there is
no application. Per §6.3 of `03-design-decisions.md`, the database enforces almost none of the
AGENTS Question 3 rules — it cannot stop a provider ordering from themselves, cannot require two-party
completion, cannot check review eligibility, and cannot make `AdminAction` unforgeably append-only.
Those are module functions in `/modules`, and until they are written and tested, none of them exist.

Concretely, all of the following remain unbuilt and unproven, despite the schema supporting them:

| Still open | Why a database cannot settle it |
| --- | --- |
| PR-ORDER-001 self-order guard | enforced by a guarded write in `/modules/orders`, not by a constraint |
| PR-ORDER-006/007 two-party completion | requires the transition functions and the 72h sweep job |
| PR-REVIEW-001/003/005 review eligibility and moderation | requires `/modules/reviews`; the unique index is only the backstop |
| PR-ADMIN-004 append-only enforcement | the table has no `updatedAt`/`deletedAt`, so the ORM cannot update it, but a `BEFORE UPDATE OR DELETE` trigger was not added because DB-1 requires an instruction |
| PR-TECH-002a IP rate limiting | `OtpCode` records no originating IP; where the counter lives is undecided |
| PR-AI-002 moderation pattern list | the six locked models contain **no table** for the Admin-maintained add/remove list that the requirement and AGENTS rule 19 both demand |

The last two are genuine gaps in the schema, not deferred work. Both are flagged in
`01-requirements.md` rather than quietly designed around, because DB-1 forbids adding a model or
constraint without an explicit instruction.

### 3.2 A prediction that proved correct

`query-plans.ts` was written to assert against **expected** index names including
`orders_status_providerMarkedDone_providerMarkedDoneAt_idx`, on the reasoning that Prisma derives
index names from field names, so the generated name would carry camelCase rather than snake_case.
That prediction was right, and it mattered: an earlier revision asserted the snake_case spelling and
would have **failed with the index working perfectly**, reporting "0 of 3 indexes found". That is the
kind of failure that leads someone to "repair" a healthy index. Confirm against `pg_indexes` before
assuming an index is absent.

---

## 4. Reproducing this proof

```powershell
# 1. point DATABASE_URL at a reachable PostgreSQL 16, then:
npx prisma migrate deploy        # apply the initial migration
$env:FIXORA_ALLOW_SEED_RESET='1'
npm run proof                    # seed + fixtures + 5 actions + plans + constraints
```

`npm run proof` exits 0 on a correct schema and non-zero at the first failing check. The migration
was generated offline, so `migrate deploy` is expected to apply it without producing new SQL. If
`migrate dev` ever wants to generate a *second* migration, the schema and the committed
`migration.sql` have drifted - stop and investigate rather than accepting it.

During verification this was run against a disposable cluster rather than the pre-existing service,
whose password was never available:

```powershell
$env:DATABASE_URL='postgresql://postgres:<temp-password>@127.0.0.1:5433/fixora?schema=public'
```

---

## 5. The honest summary

**The shape of the schema is verified, and now its behaviour against real data is too.** Types,
nullability, enum membership, referential integrity, uniqueness, the four range checks, the GIN
index, the absence of anything destructive, the five action queries, the two heaviest query plans,
and three rejected invalid states — all confirmed against a running PostgreSQL 16.15. **52 checks,
0 failures.**

What that does *not* mean is that Fixora works. There is no application in this repository — no
`next` dependency, no `app/` directory, no `dev` script — so `npm run dev` has nothing to start. The
behavioural rules in AGENTS Question 3 are module functions that do not exist yet.

Two requirements have no home in the schema at all and are flagged rather than quietly fixed:
**PR-AI-002** needs a table for the Admin-maintained moderation pattern list, and **PR-TECH-002a**
needs somewhere to count OTP sends per originating IP. Both are recorded in `01-requirements.md`.

**This checkpoint is complete** for the schema and query-proof scope it was defined as. It is not a
claim about the product, and the first real application task should start by resolving those two gaps
before anything depends on them.
