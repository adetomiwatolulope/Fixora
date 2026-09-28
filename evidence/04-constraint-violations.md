# Evidence 4 - rejected invalid inserts

Captured 2026-09-28 from a live PostgreSQL 16.15 instance (port 5433, proof database).

Command:

```
$ node --env-file=.env.proof tests/schema-proof/invalid-states.ts
```

Verbatim output:

```text
Fixora ΓÇö three invalid states, attempted against PostgreSQL.
A constraint is the last line of defence: these writes are refused by the database,
not by application code that happens to run first.


  Case 1 ΓÇö a review with rating = 6
    rejected: true
    reason:   SQLSTATE 23514 | new row for relation "reviews" violates check constraint "reviews_rating_between_1_and_5" | constraint=reviews_rating_between_1_and_5
  PASS  1. rating = 6 is refused ΓÇö reviews_rating_between_1_and_5 raised a check violation
  PASS  1. no review row was written ΓÇö review count unchanged at 5
  PASS  1. rating = 5 is still accepted ΓÇö the constraint is a range, not a cap below the maximum

  Case 2 ΓÇö a second review on the same order
    rejected: true
    reason:   P2002 | fields=(`orderId`)
    server:   SQLSTATE 23505 | Key ("orderId")=(cmulb922x0009triclwa5c98w) already exists.
    index:    reviews_pkey
    index:    reviews_orderId_key
  PASS  2. a duplicate review is refused ΓÇö the unique index reviews_orderId_key on reviews.orderId (PR-REVIEW-001) rejected it
  PASS  2. the database itself refuses the write, not just the ORM ΓÇö raw SQL duplicate is rejected by Postgres with SQLSTATE 23505 | Key ("orderId")=(cmulb922x0009triclwa5c98w) already exists.
  PASS  2. a unique index on reviews.orderId is what enforces it ΓÇö reviews_pkey, reviews_orderId_key
  PASS  2. no second row was written ΓÇö review count unchanged at 6
  PASS  2. the order still has exactly one review ΓÇö reviews on order cmulb922x0009triclwa5c98w = 1

  Case 3 ΓÇö a provider profile with categories = []
    rejected: true
    reason:   SQLSTATE 23514 | new row for relation "provider_profiles" violates check constraint "provider_profiles_categories_at_least_one" | constraint=provider_profiles_categories_at_least_one
  PASS  3. categories = [] is refused ΓÇö provider_profiles_categories_at_least_one raised a check violation
  PASS  3. no profile row was written ΓÇö provider_profiles count unchanged at 5
  PASS  3. a non-empty category list is accepted ΓÇö the constraint rejects emptiness, not categorisation

All three invalid states were refused, and no invalid row was written.
```

## The claim being made

A constraint is the last line of defence. These three writes were attempted against the running
database, and the point is not that the application "checked" them first - it is that **PostgreSQL
refused them**, so a future caller that forgets the check still cannot write the bad row.

| # | Invalid write | SQLSTATE | Enforced by |
| --- | --- | --- | --- |
| 1 | `reviews.rating = 6` | `23514` check_violation | `reviews_rating_between_1_and_5` |
| 2 | second review on one order | `23505` unique_violation | `reviews_orderId_key` |
| 3 | `provider_profiles.categories = '{}'` | `23514` check_violation | `provider_profiles_categories_at_least_one` |

**11 checks, 0 failures.**

## What each case actually proves

**Case 1 - rating out of range.** `reviews_rating_between_1_and_5` refuses rating 6. The positive
control matters as much as the rejection: rating **5 is still accepted**. That distinguishes a range
constraint from a mistakenly strict cap, which would silently reject legitimate five-star reviews.

**Case 2 - one review per order (PR-REVIEW-001).** This case proves two different things on purpose:

- The `prisma.review.create` call is refused, reported by Prisma as `P2002`. That is the ORM's code
  and says nothing about who actually refused.
- So the same duplicate is then re-attempted as **raw SQL**, forcing the server to answer. Postgres
  returns `SQLSTATE 23505` with `Key ("orderId")=(...) already exists.` The enforcing index is named
  from the catalogue rather than scraped out of a debug string, because Prisma's `P2010` payload
  does not carry it.

Row counts are re-read before and after, so "refused" is not merely an exception being thrown - no
row was written, and the order still holds exactly one review.

**Case 3 - empty category list.** `provider_profiles_categories_at_least_one` refuses `{}`. The
positive control shows a non-empty list is still accepted, so the constraint rejects *emptiness*, not
categorisation. This is the database half of PR-PROVIDER-002 and PR-SEARCH-002: a profile with no
category cannot exist, so it cannot surface in search.

## Screenshots

The same three rejections captured as images, rendered from this real output:

| File | Case |
| --- | --- |
| `screenshots/01-rating-out-of-range.png` | rating = 6 refused by `reviews_rating_between_1_and_5` |
| `screenshots/02-duplicate-review.png` | duplicate refused by `reviews_orderId_key`, SQLSTATE 23505 |
| `screenshots/03-empty-categories.png` | `categories = {}` refused by `provider_profiles_categories_at_least_one` |

Each image shows the attempted statement, the server's error text, the SQLSTATE, and the row-count
assertion that followed.
