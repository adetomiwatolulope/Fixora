# Fixora - Evidence

All four artefacts are captured. Every plan and every error message below is real output from a
running PostgreSQL 16.15 instance, pasted verbatim - nothing is illustrative.

| # | Required evidence | File | Status |
|---|---|---|---|
| 1 | The diagram | `01-erd-diagram.md` | **CAPTURED** - 98 lines, Mermaid `erDiagram`, all 6 entities, 8 relationships |
| 2 | State machine drawing | `02-order-state-machine.md` | **CAPTURED** - ASCII, `Order.status`, all 7 states, legend + contested-transition table |
| 3 | Query plan output showing index use | `03-query-plans.md` | **CAPTURED** - 11/11 checks, verbatim `EXPLAIN (ANALYZE, BUFFERS)` for 4 plans |
| 4 | Screenshots of the 3 rejected invalid inserts | `04-constraint-violations.md` + `screenshots/` | **CAPTURED** - 11/11 checks, 3 real `psql` sessions rendered to PNG |

## The evidence that took real work to get honestly

Items 3 and 4 are outputs of a running server. `EXPLAIN (ANALYZE, BUFFERS)` returns whatever the
planner actually chose given real statistics, and a rejected `INSERT` returns a real constraint name
and `SQLSTATE`. Neither can be written before the server exists, so both files were left explicitly
marked as uncaptured until a live database was available. A hand-written query plan is worse than no
query plan: a fabricated one is indistinguishable from a real one until someone checks it, and
proving the indexes work is the entire point of the artefact.

## Reproducing

```powershell
$env:DATABASE_URL='postgresql://postgres:<password>@127.0.0.1:5432/fixora?schema=public'
$env:FIXORA_ALLOW_SEED_RESET='1'
npm run proof
```

`npm run proof` runs seed, fixtures, the five action queries, the query plans, and the constraint
probes in sequence. The three screenshots were captured with `psql` rather than the Node scripts, so
the images show the server's own `ERROR:` and `DETAIL:` text rather than a framework's rendering of
it; `evidence/render-terminal.ps1` turns that captured text into the PNGs.

## Defects found and fixed while assembling this folder

**Index name asserted in snake_case.** `query-plans.ts` asserted on
`orders_status_provider_marked_done_provider_marked_done_at_idx`, but Prisma names indexes after the
camelCase field names in the schema, so the real index is
`orders_status_providerMarkedDone_providerMarkedDoneAt_idx`. The plan check would have **failed with
the index working perfectly**, and the catalogue check would have reported 0 of 3 indexes found.
Exactly the failure that leads someone to "repair" a healthy index.

**State machine labelled `DISPUTED` twice.** The original drawing in `03-design-decisions.md`
labelled its bottom terminal box `DISPUTED` - but `DISPUTED` already had its own box higher up, and
the arrows landing in the bottom box were the *cancel* arrows. As drawn it implied cancelling and
disputing lead to the same state, contradicting PR-ORDER-008 against PR-ORDER-009. Redrawn with
`CANCELLED` and `DISPUTED` as separate, correctly-labelled boxes, plus a legend and a table of the
transitions that are conditional or contested.

**A `FEATURED` seed row that the database correctly refused.** The seed originally gave a `FEATURED`
provider a null `featuredEndsAt`, which CHECK constraint
`provider_profiles_featured_window_valid` rejected. The constraint was right and the seed was wrong:
"expires in the past" and "was never given a window" are different states, and only the first is a
real product state. Grace now carries an expired window, which is the genuine fail-closed case, and
`five-queries.ts` Q1 asserts against it.

**A join can only have one access path.** The first version of the plan proof asserted that the
single customer search query used *both* the GIN index and the geo composite. It cannot, and the
disproof was empirical rather than theoretical. The category filter is on `provider_profiles` and
the bounding box is on `users`, joined by `userId`; a join has exactly one access path, so the
selective side drives and the other becomes a residual filter. At a 50/50 category split the geo
index drove and GIN was never touched; at 1% the roles inverted and `users` was sequentially scanned.
Neither distribution is a schema defect, and neither proves both indexes. The fix was to measure
each index on the query shape where it is genuinely the cheapest - radius-only, category-only - and
to record Plan 1 exactly as it came out, with a note explaining why GIN is not needed there.

**Bulk data that made the index look useless.** The bulk users were all stamped `Lagos`, so
`city = 'Lagos'` matched 100% of rows, the composite's leading column did no work, and the planner
correctly fell back to a sequential scan - which would have "proved" the index was worthless. Real
providers are spread across cities, so the bulk data now spans eight.

## Files

| File | What it is |
|---|---|
| `01-erd-diagram.md` | Mermaid `erDiagram`, 6 entities, 8 relationships |
| `02-order-state-machine.md` | `Order.status` as 7 states with legal and contested transitions |
| `03-query-plans.md` | 4 `EXPLAIN (ANALYZE, BUFFERS)` plans + index catalogue, verbatim |
| `04-constraint-violations.md` | 3 rejected invalid inserts with real SQLSTATEs, verbatim |
| `screenshots/01-rating-out-of-range.png` | rating = 6 refused by `reviews_rating_between_1_and_5` |
| `screenshots/02-duplicate-review.png` | duplicate refused by `reviews_orderId_key` (SQLSTATE 23505) |
| `screenshots/03-empty-categories.png` | `categories = {}` refused by `provider_profiles_categories_at_least_one` |
| `render-terminal.ps1` | renders captured `psql` output to the PNGs above |
