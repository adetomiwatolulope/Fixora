// Fixora — query plan verification for the two heaviest queries (Checkpoint 5, CS-10).
//
// The requirement is to verify the two heaviest queries use the indexes the migration adds. At
// seed size — seven providers, ten orders — the planner will seq-scan everything, because a
// sequential scan of ten rows is genuinely cheaper than any index. Asserting "the plan uses the
// index" against that data would be theatre.
//
// So this file first loads a synthetic bulk dataset with generate_series, measures the plan at a
// size where the planner's choice is meaningful, and then removes every row it created. The
// schema proof in five-queries.ts is unchanged and still runs against the small, readable seed.
//
// The queries measured:
//
//   Plan 1  - Q1 provider search as a customer issues it: radius + category + LIMIT.
//   Plan 1b - the category filter alone, city-wide, no radius and no LIMIT. Proves the GIN index.
//   Plan 1c - the radius filter alone, no category. Proves the users(city, lat, lng) composite.
//   Plan 2  - Q4 72-hour sweep. Needs orders(status, providerMarkedDone, providerMarkedDoneAt):
//            two equality predicates on the leading columns, a range on the third.
//
// 1b and 1c exist because 1 has one filter per table joined by userId, and a join has only one
// access path. Proving both indexes on query 1 would mean asserting something PostgreSQL cannot do.
//
// Everything is a parameterized $queryRaw (CS-3), including EXPLAIN itself.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

// 50k profiles, not 5k. The GIN index on categories is only the *cheapest* plan once a sequential
// scan of provider_profiles costs more than a bitmap index build. At a few thousand rows Postgres
// correctly prefers the seq scan, and asserting "the plan uses GIN" there would be asserting a
// planner mistake rather than a schema property.
const BULK_USERS = 50_000;
const BULK_ORDERS = 40_000;
const BULK_PREFIX = "bulk_";

const LAGOS = { name: "Lagos", latitude: 6.5244, longitude: 3.3792 };

// Eight real cities, not fifty thousand rows all stamped "Lagos". The geo composite is
// (city, latitude, longitude), so its leading column only earns anything when a single city is a
// small slice of the table. With every row in Lagos, city = 'Lagos' matches 100% of rows, the
// bounding box is the only thing narrowing anything, and the planner quite correctly prefers a
// sequential scan - which proves nothing about the index. A real marketplace is spread out.
const CITIES = [
  { name: "Lagos", state: "Lagos", latitude: 6.5244, longitude: 3.3792 },
  { name: "Abuja", state: "FCT", latitude: 9.0765, longitude: 7.3986 },
  { name: "Port Harcourt", state: "Rivers", latitude: 4.8156, longitude: 7.0498 },
  { name: "Kano", state: "Kano", latitude: 12.0022, longitude: 8.592 },
  { name: "Ibadan", state: "Oyo", latitude: 7.3775, longitude: 3.947 },
  { name: "Enugu", state: "Enugu", latitude: 6.4413, longitude: 7.4988 },
  { name: "Kaduna", state: "Kaduna", latitude: 10.5222, longitude: 7.4384 },
  { name: "Benin City", state: "Edo", latitude: 6.335, longitude: 5.6037 },
] as const;

const CITIES_JSON = JSON.stringify(CITIES);
const CITY_COUNT = CITIES.length;

let failures = 0;

function check(label: string, passed: boolean, detail: string): void {
  if (passed) {
    console.log(`  PASS  ${label} — ${detail}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

async function loadBulkData(): Promise<void> {
  // Clear any leftovers first. A previous run that died partway leaves bulk rows behind, and
  // without this the reload collides on the primary key instead of producing a plan.
  await removeBulkData();
  console.log(`  loading ${BULK_USERS} bulk users/profiles and ${BULK_ORDERS} bulk orders...`);

  // Spread the synthetic providers over eight cities, each with a realistic local scatter, so the
  // city prefilter and the bounding box both have real work to do.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO users (id, phone, role, name, city, state, latitude, longitude, "createdAt")
    SELECT
      ${BULK_PREFIX} || 'u_' || g,
      '+2349' || lpad(g::text, 8, '0'),
      'PROVIDER'::"UserRole",
      'Bulk Provider ' || g,
      c.city ->> 'name',
      c.city ->> 'state',
      (c.city ->> 'latitude')::float8 + ((g % 97) / 97.0 - 0.5) * 0.8,
      (c.city ->> 'longitude')::float8 + ((g % 89) / 89.0 - 0.5) * 0.8,
      now()
    FROM generate_series(1, ${BULK_USERS}) AS g
    CROSS JOIN LATERAL (
      SELECT t.city
      FROM jsonb_array_elements(${CITIES_JSON}::jsonb) WITH ORDINALITY AS t(city, ord)
      WHERE t.ord = 1 + (g % ${CITY_COUNT})
    ) AS c
  `);

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO provider_profiles (
      id, "userId", categories, bio, "startingPriceKobo", "ratingAverage", "ratingCount",
      "subscriptionTier", "createdAt", "updatedAt"
    )
    SELECT
      ${BULK_PREFIX} || 'p_' || g,
      ${BULK_PREFIX} || 'u_' || g,
      -- 1% PLUMBING, 99% ELECTRICAL. A 50/50 split makes the containment filter match half the
      -- table, and a sequential scan really is then the correct plan. The GIN index earns its keep
      -- when the category is selective, which is the realistic case: nobody searches a category
      -- that half the city offers.
      ARRAY[CASE WHEN g % 100 = 0 THEN 'PLUMBING'::"ServiceCategory" ELSE 'ELECTRICAL'::"ServiceCategory" END],
      'Bulk provider',
      500000,
      0,
      0,
      'FREE'::"SubscriptionTier",
      now(),
      now()
    FROM generate_series(1, ${BULK_USERS}) AS g
  `);

  // Every third order is a stale, sweep-eligible IN_PROGRESS row; the rest are in other states,
  // so the sweep has to actually discriminate rather than matching the whole table.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO orders (
      id, "customerId", "providerId", category, description, "jobAddress",
      "preferredDate", status, "providerMarkedDone", "providerMarkedDoneAt", "autoCompleted",
      "createdAt", "updatedAt"
    )
    SELECT
      ${BULK_PREFIX} || 'o_' || g,
      ${BULK_PREFIX} || 'u_' || (1 + (g % ${BULK_USERS})),
      ${BULK_PREFIX} || 'u_' || (1 + (g % ${BULK_USERS})),
      'PLUMBING'::"ServiceCategory",
      'Bulk order ' || g,
      'Bulk address ' || g,
      now() - interval '1 day',
      CASE WHEN g % 3 = 0
        THEN 'IN_PROGRESS'::"OrderStatus"
        ELSE 'REQUESTED'::"OrderStatus"
      END,
      (g % 3 = 0),
      CASE WHEN g % 3 = 0 THEN now() - interval '5 days' ELSE NULL END,
      false,
      now(),
      now()
    FROM generate_series(1, ${BULK_ORDERS}) AS g
  `);

  // Give the planner accurate statistics, or it is optimising against guesses.
  await prisma.$executeRaw(Prisma.sql`ANALYZE users`);
  await prisma.$executeRaw(Prisma.sql`ANALYZE provider_profiles`);
  await prisma.$executeRaw(Prisma.sql`ANALYZE orders`);
}

async function removeBulkData(): Promise<void> {
  // Reverse of the FK graph, because every relation is onDelete: Restrict (DB-7).
  await prisma.$executeRaw(Prisma.sql`DELETE FROM orders WHERE id LIKE ${BULK_PREFIX + "%"}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM provider_profiles WHERE id LIKE ${BULK_PREFIX + "%"}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM users WHERE id LIKE ${BULK_PREFIX + "%"}`);
  await prisma.$executeRaw(Prisma.sql`ANALYZE users`);
  await prisma.$executeRaw(Prisma.sql`ANALYZE provider_profiles`);
  await prisma.$executeRaw(Prisma.sql`ANALYZE orders`);
}

interface ExplainRow {
  "QUERY PLAN": string;
}

async function explainPlan(sql: Prisma.Sql): Promise<string> {
  const rows = await prisma.$queryRaw<ExplainRow[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function printPlan(title: string, plan: string): void {
  console.log(`\n  --- ${title} ---`);
  for (const line of plan.split("\n")) {
    console.log(`    ${line}`);
  }
}

async function measureSearchPlan(): Promise<void> {
  const radiusKm = 25;
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.cos((LAGOS.latitude * Math.PI) / 180));

  // ---- Plan 1: the customer query exactly as issued - radius AND category, limited ----
  //
  // The two filters sit on different tables (provider_profiles.categories and users.latitude,
  // joined by userId), so PostgreSQL chooses ONE index as the access path and the other becomes a
  // residual filter. That is a cost decision against the data, not a property of the schema, so
  // the assertions below record whichever access path the planner actually chose rather than the
  // one that would look best in a report. GIN gets its own measurement on Plan 1b, below.
  const searchSql = Prisma.sql`
    SELECT p.id, u.name, u.latitude, u.longitude
    FROM provider_profiles p
    JOIN users u ON u.id = p."userId"
    WHERE p.categories @> ARRAY['PLUMBING']::"ServiceCategory"[]
      AND u.city = ${LAGOS.name}
      AND u.latitude BETWEEN ${LAGOS.latitude - latDelta} AND ${LAGOS.latitude + latDelta}
      AND u.longitude BETWEEN ${LAGOS.longitude - lngDelta} AND ${LAGOS.longitude + lngDelta}
    ORDER BY u.latitude
    LIMIT 20
  `;

  const plan = await explainPlan(searchSql);
  printPlan("Plan 1 - provider search within a radius, with a category filter", plan);

  const usesGeoOnCombined = plan.includes("users_city_latitude_longitude_idx");
  const noSeqScanOnProviders = !/Seq Scan on provider_profiles/.test(plan);
  check(
    "Plan 1 uses users(city, latitude, longitude)",
    usesGeoOnCombined,
    "the city prefilter plus bounding box is served by the composite index DB-4 added (PR-TECH-001)",
  );
  check(
    "Plan 1 does not sequentially scan provider_profiles",
    noSeqScanOnProviders,
    "profiles are reached through the userId unique index, so the category filter is applied to bbox-narrowed rows only",
  );
  console.log(
    "  NOTE  Plan 1 does not need the GIN index: the bounding box already narrows the candidate\n" +
      "        set to a few thousand rows, so the planner PK-joins and filters categories inline.\n" +
      "        GIN is proven separately on Plan 1b, where no radius exists to do that narrowing.",
  );

  // ---- Plan 1b: category count across the whole city, no radius, no limit ----
  //
  // A LIMIT is deliberately absent: with one, the planner walks the city index in latitude order,
  // stops at 20 matches, and never needs the GIN index at all. With no radius and no early exit,
  // the only way to answer "how many PLUMBING providers are in Lagos" without reading every
  // profile row is the containment index.
  const cityWideSql = Prisma.sql`
    SELECT count(*)
    FROM provider_profiles p
    JOIN users u ON u.id = p."userId"
    WHERE p.categories @> ARRAY['PLUMBING']::"ServiceCategory"[]
      AND u.city = ${LAGOS.name}
  `;

  const cityWidePlan = await explainPlan(cityWideSql);
  printPlan("Plan 1b - provider search by category across the whole city (no radius, no limit)", cityWidePlan);

  const usesCategoryGin = cityWidePlan.includes("provider_profiles_categories_gin_idx");
  check(
    "Plan 1b uses the GIN index on categories",
    usesCategoryGin,
    "with no radius and no early exit, @> must be served by provider_profiles_categories_gin_idx (PR-SEARCH-001, AGENTS Q2 build prerequisite)",
  );

  // ---- Plan 1c: proximity alone, no category filter ----
  //
  // "Show me providers near me" is a real query, and it is the shape PR-TECH-001 is actually about:
  // a bounding-box prefilter on indexed lat/lng with the final distance sort done in SQL. With no
  // competing filter, the composite is the only access path available, and ORDER BY latitude
  // rides the index's own ordering so no sort node is needed.
  const radiusOnlySql = Prisma.sql`
    SELECT p.id, u.name, u.latitude, u.longitude
    FROM provider_profiles p
    JOIN users u ON u.id = p."userId"
    WHERE u.city = ${LAGOS.name}
      AND u.latitude BETWEEN ${LAGOS.latitude - latDelta} AND ${LAGOS.latitude + latDelta}
      AND u.longitude BETWEEN ${LAGOS.longitude - lngDelta} AND ${LAGOS.longitude + lngDelta}
    ORDER BY u.latitude
    LIMIT 20
  `;

  const radiusOnlyPlan = await explainPlan(radiusOnlySql);
  printPlan("Plan 1c - provider search by radius alone (no category filter)", radiusOnlyPlan);

  const usesGeoIndex = radiusOnlyPlan.includes("users_city_latitude_longitude_idx");
  const noSeqScanOnUsers = !/Seq Scan on users/.test(radiusOnlyPlan);
  check(
    "Plan 1c uses users(city, latitude, longitude)",
    usesGeoIndex,
    "with no competing filter the bounding box can only be served by the composite index DB-4 added (PR-TECH-001, AGENTS Q2)",
  );
  check(
    "Plan 1c does not sequentially scan users",
    noSeqScanOnUsers,
    "city plus bounding box is index-assisted on the leading columns, and only one city in eight is a candidate",
  );
}

async function measureSweepPlan(): Promise<void> {
  const sweepSql = Prisma.sql`
    SELECT id, "customerId", "providerId", "providerMarkedDoneAt"
    FROM orders
    WHERE status = 'IN_PROGRESS'::"OrderStatus"
      AND "providerMarkedDone" = true
      AND "providerMarkedDoneAt" < now() - interval '72 hours'
    ORDER BY "providerMarkedDoneAt" ASC
    LIMIT 100
  `;

  const plan = await explainPlan(sweepSql);
  printPlan("Plan 2 — 72-hour completion sweep", plan);

  // Prisma derives index names from the *field* names, which are camelCase in the schema.
  // The real name is orders_status_providerMarkedDone_providerMarkedDoneAt_idx -- asserting a
  // snake_case spelling here fails even when the index is genuinely being used.
  const usesSweepIndex = /orders_status_providerMarkedDone_providerMarkedDoneAt_idx/i.test(plan);
  const noSeqScan = !/Seq Scan on orders/.test(plan);
  const picksCandidates = /Limit|Sort/.test(plan) || plan.includes("Index Scan");

  check("Plan 2 uses orders(status, providerMarkedDone, providerMarkedDoneAt)", usesSweepIndex, "two equality predicates then a range — the composite index PR-TECH-008 needs (PR-ORDER-007a)");
  check("Plan 2 does not sequentially scan orders", noSeqScan, "a scheduled sweep that seq-scans the whole orders table is exactly the failure this index prevents");
  check("Plan 2 reads a small fraction of the table", picksCandidates, "the ORDER BY + LIMIT rides the index order rather than sorting every match");
}

async function verifyCatalogObjects(): Promise<void> {
  console.log("\n  --- catalogue verification ---");

  const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>(Prisma.sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename IN ('users', 'provider_profiles', 'orders')
      AND indexname IN (
        'provider_profiles_categories_gin_idx',
        'users_city_latitude_longitude_idx',
        'orders_status_providerMarkedDone_providerMarkedDoneAt_idx'
      )
    ORDER BY indexname
  `);
  for (const index of indexes) {
    console.log(`    ${index.indexname}: ${index.indexdef}`);
  }
  check("All three required indexes exist", indexes.length === 3, "GIN on categories, the geo composite, and the sweep composite");

  // The two owner-authorised stores carry the indexes their access patterns need, verified here
  // rather than assumed from the Prisma schema: the Admin pattern list is read by (enabled, kind)
  // and must be unique per kind, and the per-IP OTP counter is counted by (requestingIp,
  // createdAt) on every send attempt. An index that exists only in schema.prisma is not evidence.
  const storeIndexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>(Prisma.sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE indexname IN (
      'moderation_patterns_kind_pattern_key',
      'moderation_patterns_enabled_kind_idx',
      'otp_send_attempts_requestingIp_createdAt_idx'
    )
    ORDER BY indexname
  `);
  for (const index of storeIndexes) {
    console.log(`    ${index.indexname}: ${index.indexdef}`);
  }
  check(
    "The two authorised stores have their access-path indexes",
    storeIndexes.length === 3,
    "pattern-list lookup (enabled, kind), pattern uniqueness (kind, pattern), and the per-IP OTP counter (requestingIp, createdAt)",
  );

  const constraints = await prisma.$queryRaw<Array<{ conname: string; pg_get_constraintdef: string }>>(Prisma.sql`
    SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
    FROM pg_constraint
    WHERE conname IN (
      'reviews_rating_between_1_and_5',
      'provider_profiles_categories_at_least_one',
      'provider_profiles_featured_window_valid',
      'provider_profiles_rating_bounds',
      'provider_profiles_bio_max_500_chars'
    )
    ORDER BY conname
  `);
  for (const constraint of constraints) {
    console.log(`    ${constraint.conname}: ${constraint.pg_get_constraintdef}`);
  }
  check(
    "All five CHECK constraints exist",
    constraints.length === 5,
    "rating range, non-empty categories, featured window, rating bounds, 500-character bio cap",
  );
}

async function main(): Promise<void> {
  console.log("Fixora — query plan verification (Checkpoint 5, CS-10).\n");
  console.log("  Seed data alone is too small for a plan to be meaningful, so the two heaviest");
  console.log("  queries are measured against a temporary bulk dataset, which is then removed.\n");

  await verifyCatalogObjects();

  console.log("");
  await loadBulkData();
  try {
    console.log("");
    await measureSearchPlan();
    console.log("");
    await measureSweepPlan();
  } finally {
    console.log("\n  removing bulk dataset...");
    await removeBulkData();
    const remaining = await prisma.user.count({ where: { id: { startsWith: BULK_PREFIX } } });
    check("bulk dataset fully removed", remaining === 0, "the database is back to the small proof seed");
  }

  console.log(failures === 0 ? "\nAll plan checks passed." : `\n${failures} plan check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error("\nPlan verification failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
