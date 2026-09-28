# Evidence 3 - query plans

Captured 2026-09-28 from a live PostgreSQL 16.15 instance (port 5433, proof database).

Command:

```
$ node --env-file=.env.proof tests/schema-proof/query-plans.ts
```

Verbatim output:

```text
Fixora ΓÇö query plan verification (Checkpoint 5, CS-10).

  Seed data alone is too small for a plan to be meaningful, so the two heaviest
  queries are measured against a temporary bulk dataset, which is then removed.


  --- catalogue verification ---
    orders_status_providerMarkedDone_providerMarkedDoneAt_idx: CREATE INDEX "orders_status_providerMarkedDone_providerMarkedDoneAt_idx" ON public.orders USING btree (status, "providerMarkedDone", "providerMarkedDoneAt")
    provider_profiles_categories_gin_idx: CREATE INDEX provider_profiles_categories_gin_idx ON public.provider_profiles USING gin (categories)
    users_city_latitude_longitude_idx: CREATE INDEX users_city_latitude_longitude_idx ON public.users USING btree (city, latitude, longitude)
  PASS  All three required indexes exist ΓÇö GIN on categories, the geo composite, and the sweep composite
    provider_profiles_categories_at_least_one: CHECK ((cardinality(categories) >= 1))
    provider_profiles_featured_window_valid: CHECK ((("subscriptionTier" <> 'FEATURED'::"SubscriptionTier") OR ("featuredEndsAt" IS NOT NULL)))
    provider_profiles_rating_bounds: CHECK ((("ratingAverage" >= (0)::double precision) AND ("ratingAverage" <= (5)::double precision) AND ("ratingCount" >= 0)))
    reviews_rating_between_1_and_5: CHECK (((rating >= 1) AND (rating <= 5)))
  PASS  All four CHECK constraints exist ΓÇö rating range, non-empty categories, featured window, rating bounds

  loading 50000 bulk users/profiles and 40000 bulk orders...


  --- Plan 1 - provider search within a radius, with a category filter ---
    Limit  (cost=1251.17..1251.18 rows=1 width=47) (actual time=67.541..67.549 rows=20 loops=1)
      Buffers: shared hit=9259
      ->  Sort  (cost=1251.17..1251.18 rows=1 width=47) (actual time=67.538..67.543 rows=20 loops=1)
            Sort Key: u.latitude
            Sort Method: top-N heapsort  Memory: 28kB
            Buffers: shared hit=9259
            ->  Nested Loop  (cost=95.36..1251.16 rows=1 width=47) (actual time=10.420..66.867 rows=72 loops=1)
                  Buffers: shared hit=9259
                  ->  Bitmap Heap Scan on users u  (cost=94.95..421.89 rows=104 width=47) (actual time=9.569..12.182 rows=1968 loops=1)
                        Recheck Cond: ((city = 'Lagos'::text) AND (latitude >= '6.299822206252245'::double precision) AND (latitude <= '6.748977793747755'::double precision) AND (longitude >= '3.153158259766128'::double precision) AND (longitude <= '3.605241740233872'::double precision))
                        Heap Blocks: exact=1344
                        Buffers: shared hit=1390
                        ->  Bitmap Index Scan on users_city_latitude_longitude_idx  (cost=0.00..94.92 rows=104 width=0) (actual time=7.081..7.082 rows=3936 loops=1)
                              Index Cond: ((city = 'Lagos'::text) AND (latitude >= '6.299822206252245'::double precision) AND (latitude <= '6.748977793747755'::double precision) AND (longitude >= '3.153158259766128'::double precision) AND (longitude <= '3.605241740233872'::double precision))
                              Buffers: shared hit=46
                  ->  Index Scan using "provider_profiles_userId_key" on provider_profiles p  (cost=0.41..7.97 rows=1 width=24) (actual time=0.026..0.026 rows=0 loops=1968)
                        Index Cond: ("userId" = u.id)
                        Filter: (categories @> '{PLUMBING}'::"ServiceCategory"[])
                        Rows Removed by Filter: 1
                        Buffers: shared hit=7869
    Planning:
      Buffers: shared hit=182
    Planning Time: 8.510 ms
    Execution Time: 67.730 ms
  PASS  Plan 1 uses users(city, latitude, longitude) ΓÇö the city prefilter plus bounding box is served by the composite index DB-4 added (PR-TECH-001)
  PASS  Plan 1 does not sequentially scan provider_profiles ΓÇö profiles are reached through the userId unique index, so the category filter is applied to bbox-narrowed rows only
  NOTE  Plan 1 does not need the GIN index: the bounding box already narrows the candidate
        set to a few thousand rows, so the planner PK-joins and filters categories inline.
        GIN is proven separately on Plan 1b, where no radius exists to do that narrowing.

  --- Plan 1b - provider search by category across the whole city (no radius, no limit) ---
    Aggregate  (cost=3274.80..3274.81 rows=1 width=8) (actual time=33.032..33.039 rows=1 loops=1)
      Buffers: shared hit=2178
      ->  Hash Join  (cost=1709.60..3274.64 rows=62 width=0) (actual time=26.092..32.867 rows=252 loops=1)
            Hash Cond: (u.id = p."userId")
            Buffers: shared hit=2178
            ->  Bitmap Heap Scan on users u  (cost=388.60..1937.33 rows=6218 width=12) (actual time=8.875..12.766 rows=6258 loops=1)
                  Recheck Cond: (city = 'Lagos'::text)
                  Heap Blocks: exact=1471
                  Buffers: shared hit=1549
                  ->  Bitmap Index Scan on users_city_latitude_longitude_idx  (cost=0.00..387.05 rows=6218 width=0) (actual time=6.261..6.261 rows=12516 loops=1)
                        Index Cond: (city = 'Lagos'::text)
                        Buffers: shared hit=78
            ->  Hash  (cost=1314.77..1314.77 rows=498 width=12) (actual time=17.132..17.136 rows=502 loops=1)
                  Buckets: 1024  Batches: 1  Memory Usage: 30kB
                  Buffers: shared hit=629
                  ->  Bitmap Heap Scan on provider_profiles p  (cost=538.01..1314.77 rows=498 width=12) (actual time=15.337..16.754 rows=502 loops=1)
                        Recheck Cond: (categories @> '{PLUMBING}'::"ServiceCategory"[])
                        Heap Blocks: exact=501
                        Buffers: shared hit=629
                        ->  Bitmap Index Scan on provider_profiles_categories_gin_idx  (cost=0.00..537.88 rows=498 width=0) (actual time=15.101..15.101 rows=502 loops=1)
                              Index Cond: (categories @> '{PLUMBING}'::"ServiceCategory"[])
                              Buffers: shared hit=128
    Planning:
      Buffers: shared hit=27
    Planning Time: 2.064 ms
    Execution Time: 34.221 ms
  PASS  Plan 1b uses the GIN index on categories ΓÇö with no radius and no early exit, @> must be served by provider_profiles_categories_gin_idx (PR-SEARCH-001, AGENTS Q2 build prerequisite)

  --- Plan 1c - provider search by radius alone (no category filter) ---
    Limit  (cost=0.83..255.57 rows=20 width=47) (actual time=0.207..0.988 rows=20 loops=1)
      Buffers: shared hit=125
      ->  Nested Loop  (cost=0.83..1325.48 rows=104 width=47) (actual time=0.203..0.976 rows=20 loops=1)
            Buffers: shared hit=125
            ->  Index Scan using users_city_latitude_longitude_idx on users u  (cost=0.41..496.50 rows=104 width=47) (actual time=0.115..0.298 rows=20 loops=1)
                  Index Cond: ((city = 'Lagos'::text) AND (latitude >= '6.299822206252245'::double precision) AND (latitude <= '6.748977793747755'::double precision) AND (longitude >= '3.153158259766128'::double precision) AND (longitude <= '3.605241740233872'::double precision))
                  Buffers: shared hit=45
            ->  Index Scan using "provider_profiles_userId_key" on provider_profiles p  (cost=0.41..7.97 rows=1 width=24) (actual time=0.030..0.030 rows=1 loops=20)
                  Index Cond: ("userId" = u.id)
                  Buffers: shared hit=80
    Planning:
      Buffers: shared hit=20
    Planning Time: 1.780 ms
    Execution Time: 1.159 ms
  PASS  Plan 1c uses users(city, latitude, longitude) ΓÇö with no competing filter the bounding box can only be served by the composite index DB-4 added (PR-TECH-001, AGENTS Q2)
  PASS  Plan 1c does not sequentially scan users ΓÇö city plus bounding box is index-assisted on the leading columns, and only one city in eight is a candidate


  --- Plan 2 ΓÇö 72-hour completion sweep ---
    Limit  (cost=0.29..172.90 rows=100 width=44) (actual time=0.152..0.352 rows=100 loops=1)
      Buffers: shared hit=10
      ->  Index Scan using "orders_status_providerMarkedDone_providerMarkedDoneAt_idx" on orders  (cost=0.29..2506.49 rows=1452 width=44) (actual time=0.146..0.315 rows=100 loops=1)
            Index Cond: ((status = 'IN_PROGRESS'::"OrderStatus") AND ("providerMarkedDone" = true) AND ("providerMarkedDoneAt" < (now() - '72:00:00'::interval)))
            Buffers: shared hit=10
    Planning:
      Buffers: shared hit=72
    Planning Time: 2.231 ms
    Execution Time: 0.425 ms
  PASS  Plan 2 uses orders(status, providerMarkedDone, providerMarkedDoneAt) ΓÇö two equality predicates then a range ΓÇö the composite index PR-TECH-008 needs (PR-ORDER-007a)
  PASS  Plan 2 does not sequentially scan orders ΓÇö a scheduled sweep that seq-scans the whole orders table is exactly the failure this index prevents
  PASS  Plan 2 reads a small fraction of the table ΓÇö the ORDER BY + LIMIT rides the index order rather than sorting every match

  removing bulk dataset...
  PASS  bulk dataset fully removed ΓÇö the database is back to the small proof seed

All plan checks passed.
```

## What this shows

- **11 checks, 0 failures.** The catalogue verification confirms all three required indexes and
  all four CHECK constraints exist *by name*, read back from `pg_indexes` and `pg_constraint` -
  not from memory of what the migration was supposed to create.
- The seed alone is far too small for a plan to mean anything: a sequential scan of ten rows is
  genuinely cheaper than any index. So the script loads 50,000 users/profiles and 40,000 orders,
  measures, then deletes every row it created.
- Bulk users are spread over **eight real Nigerian cities**, each with a local scatter. With every
  row stamped `Lagos`, `city = 'Lagos'` matches 100% of rows, the composite's leading column does
  no work, and the planner correctly falls back to a sequential scan - which would have proved
  nothing about the index.
- Bulk categories are 1% PLUMBING / 99% ELECTRICAL, so the containment filter is selective. That is
  what makes the GIN index the *cheaper* plan rather than a forced one.

### Why four plans for two queries

The two filters in provider search live on **different tables** - `provider_profiles.categories` and
`users.latitude`, joined by `userId`. A join has exactly **one** access path: whichever side is more
selective drives, and the other becomes a residual filter. Which side that is depends on the data,
not on the schema.

This was observed directly rather than assumed. At a 50/50 category split the geo index drove and
GIN was never touched; at 1% the roles inverted and `users` was sequentially scanned. Rather than
pick a distribution that flattered one index and hid the other, each index is measured on the shape
where it is genuinely the cheapest:

| Plan | Shape | Proves |
| --- | --- | --- |
| 1 | radius + category + LIMIT - the real customer query | geo composite drives; profiles reached by PK, never seq-scanned |
| 1b | category only, no radius, no LIMIT | `provider_profiles_categories_gin_idx` |
| 1c | radius only, no category | geo composite, no seq scan on `users` |
| 2 | the 72-hour sweep | `orders_status_providerMarkedDone_providerMarkedDoneAt_idx` |

Plan 1 is recorded as it actually came out. The bounding box narrows the candidate set enough that
the planner never needs GIN there, so the script prints a NOTE saying exactly that rather than
quietly omitting it. The 1b shape exists because a `LIMIT` lets the planner walk in latitude order
and stop early without ever touching GIN; removing both the radius and the limit is what forces the
containment index to answer.

## Indexes verified, as read back from the catalogue

| Index | Definition | Requirement |
| --- | --- | --- |
| `provider_profiles_categories_gin_idx` | `GIN (categories)` | PR-SEARCH-001, AGENTS Q2 build prerequisite |
| `users_city_latitude_longitude_idx` | `btree (city, latitude, longitude)` | PR-TECH-001, PR-SEARCH-003 |
| `orders_status_providerMarkedDone_providerMarkedDoneAt_idx` | `btree (status, providerMarkedDone, providerMarkedDoneAt)` | PR-TECH-008, PR-ORDER-007a |

The sweep composite leads with two equality columns and ranges on the third, so the `ORDER BY
providerMarkedDoneAt ... LIMIT` rides the index's own ordering and reads a small fraction of the
table - which is exactly what an hourly sweep needs, and the opposite of a full scan.
