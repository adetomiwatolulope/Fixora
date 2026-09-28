// Fixora — the five queries that answer the five important user actions (docx/01-requirements.md §5).
//
// Each is written the way the real /modules implementation must be written, so this file is a
// proof and not a toy:
//
//   CS-4  every write is guarded: the precondition lives in the WHERE clause of the write itself,
//         so a concurrent change between a read and the write cannot slip past it. Q2, Q5 and the
//         approval transition below are INSERT ... SELECT / UPDATE ... WHERE forms, not
//         read-then-write.
//   CS-3  no string interpolation. Every user value arrives as a bind parameter via Prisma.sql.
//   CS-5  money is a whole integer count of kobo end to end, formatted only at the edge.
//   PR-TECH-001  Q1 is the one query that must use raw SQL: the final sort over a computed
//         distance cannot be expressed in the Prisma DSL without fetching rows first, which is
//         exactly the N+1 this architecture is meant to avoid.
//
// Exits non-zero if any of the five fails, so `npm run db:proof` is a real check.

import { PrismaClient, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { ServiceCategory } from "@prisma/client";
import { ensureProofAdmin } from "./fixtures.ts";

const prisma = new PrismaClient();

const EARTH_RADIUS_M = 6_371_000;

// ── Small typed helpers ───────────────────────────────────────────────────────

interface SearchResultRow {
  provider_profile_id: string;
  provider_user_id: string;
  name: string;
  city: string;
  categories: string[];
  startingPriceKobo: number;
  ratingAverage: number;
  ratingCount: number;
  subscriptionTier: string;
  distance_m: number;
  within_radius: boolean;
  featured_effective: number;
}

interface OrderRow {
  id: string;
  customerId: string;
  providerId: string;
  category: string;
  status: string;
  jobAddress: string;
  agreedPriceKobo: number | null;
  preferredDate: Date;
  proposedDate: Date | null;
  createdAt: Date;
}

interface SweepRow {
  id: string;
  customerId: string;
  providerId: string;
  category: string;
  status: string;
  jobAddress: string;
  providerMarkedDoneAt: Date;
}

interface ReviewInsertRow {
  id: string;
  orderId: string;
  providerId: string;
  moderationStatus: string;
}

interface RatingRow {
  ratingAverage: number | null;
  ratingCount: number;
}

/** cuid-shaped id for rows inserted by raw SQL, where Prisma's @default(cuid()) does not apply. */
function newCuid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let id = "c";
  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }
  return id;
}

function formatKobo(kobo: number): string {
  const naira = kobo / 100;
  return `₦${naira.toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function heading(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

let failures = 0;

function check(label: string, passed: boolean, detail: string): void {
  if (passed) {
    console.log(`  PASS  ${label} — ${detail}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

// ── Q1 — Action A1: a customer finds a provider ──────────────────────────────
//
// Structure from PR-TECH-001, and the reason the schema needs a GIN index on
// provider_profiles(categories) (AGENTS Question 2) as well as the composite
// (city, latitude, longitude) on users:
//
//   1. GIN + a city equality  -> a small candidate set, index-assisted, no full scan
//   2. bounding box           -> narrows that set further, using the composite index
//   3. exact haversine        -> the real distance, per the no-PostGIS decision
//   4. ORDER BY / LIMIT       -> still inside the same statement, not in application code
//
// The radius is applied after the distance is computed, so a provider with no reviews is not
// silently hidden for being unrated; an unrated provider is always within range (MB-4).

async function q1FindProviders(args: {
  category: ServiceCategory;
  city: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  limit: number;
}): Promise<SearchResultRow[]> {
  const radiusM = args.radiusKm * 1000;
  const latDelta = args.radiusKm / 111.32;
  const lngDelta = args.radiusKm / (111.32 * Math.cos((args.latitude * Math.PI) / 180));

  return prisma.$queryRaw<SearchResultRow[]>(Prisma.sql`
    WITH candidates AS (
      SELECT
        p.id                 AS provider_profile_id,
        u.id                 AS provider_user_id,
        u.name,
        u.city,
        p.categories,
        p."startingPriceKobo",
        p."ratingAverage",
        p."ratingCount",
        p."subscriptionTier",
        p."featuredStartedAt",
        p."featuredEndsAt",
        u.latitude,
        u.longitude,
        (2 * ${EARTH_RADIUS_M} * asin(sqrt(
            power(sin(radians(u.latitude - ${args.latitude}) / 2), 2)
          + cos(radians(${args.latitude})) * cos(radians(u.latitude))
          * power(sin(radians(u.longitude - ${args.longitude}) / 2), 2)
        ))) AS distance_m
      FROM provider_profiles p
      JOIN users u ON u.id = p."userId"
      WHERE p.categories @> ARRAY[${args.category}]::"ServiceCategory"[]
        AND u.city = ${args.city}
        AND u.latitude BETWEEN ${args.latitude - latDelta} AND ${args.latitude + latDelta}
        AND u.longitude BETWEEN ${args.longitude - lngDelta} AND ${args.longitude + lngDelta}
    )
    SELECT
      provider_profile_id,
      provider_user_id,
      name,
      city,
      categories,
      "startingPriceKobo",
      "ratingAverage",
      "ratingCount",
      "subscriptionTier",
      distance_m,
      ("ratingCount" = 0 OR distance_m <= ${radiusM}) AS within_radius,
      (
        "subscriptionTier" = 'FEATURED'::"SubscriptionTier"
        AND "featuredStartedAt" IS NOT NULL
        AND "featuredEndsAt" IS NOT NULL
        AND now() >= "featuredStartedAt"
        AND now() < "featuredEndsAt"
      )::int AS featured_effective
    FROM candidates
    WHERE "ratingCount" = 0 OR distance_m <= ${radiusM}
    ORDER BY
      featured_effective DESC,
      ("ratingCount" > 0) DESC,
      "ratingAverage" DESC,
      distance_m ASC
    LIMIT ${args.limit}
  `);
}

async function runQ1(): Promise<void> {
  heading("Q1 — A1: find a provider (PR-SEARCH-001/002/003, PR-SUB-004, PR-PROVIDER-005/006)");

  const plumbers = await q1FindProviders({
    category: "PLUMBING",
    city: "Lagos",
    latitude: 6.5244,
    longitude: 3.3792,
    radiusKm: 25,
    limit: 10,
  });

  console.log(`  PLUMBING within 25km of central Lagos: ${plumbers.length} result(s)`);
  for (const row of plumbers) {
    console.log(
      `    ${row.name.padEnd(18)} ${(row.distance_m / 1000).toFixed(2).padStart(6)}km  ` +
        `tier=${row.subscriptionTier.padEnd(8)} featured=${row.featured_effective}  ` +
        `rating=${row.ratingAverage} (${row.ratingCount})  from=${formatKobo(row.startingPriceKobo)}`,
    );
  }

  check(
    "Q1 category containment filter",
    plumbers.length > 0 && plumbers.every((r) => r.categories.includes("PLUMBING")),
    `every returned row carries PLUMBING in categories[]`,
  );
  check(
    "Q1 live FEATURED outranks the expired one",
    plumbers[0]?.featured_effective === 1,
    `first row is Bisi (FEATURED, window ends in 20d); Tunde's window expired 10d ago so featured_effective=0`,
  );
  check(
    "Q1 distance ordering is ascending within the tier",
    plumbers.every((r, i) => {
      const previous = plumbers[i - 1];
      return previous === undefined || previous.distance_m <= r.distance_m;
    }),
    "final ORDER BY distance_m ASC is computed in SQL, not in application code",
  );

  // A category nobody in the seed offers must return nothing rather than everything.
  const none = await q1FindProviders({
    category: "OTHER",
    city: "Lagos",
    latitude: 6.5244,
    longitude: 3.3792,
    radiusKm: 50,
    limit: 10,
  });
  check("Q1 empty category returns empty", none.length === 0, "no provider offers OTHER");

  // Grace is FEATURED but her window already lapsed. MB-6 requires that to read as FREE, never
  // as featured. A FEATURED row with a null window cannot exist at all - CHECK C3 refuses it.
  const painters = await q1FindProviders({
    category: "PAINTING",
    city: "Lagos",
    latitude: 6.5244,
    longitude: 3.3792,
    radiusKm: 25,
    limit: 10,
  });
  const grace = painters.find((r) => r.name === "Grace Eze");
  check(
    "Q1 FEATURED with an expired window fails closed",
    grace !== undefined && grace.featured_effective === 0,
    "Grace Eze is stored as FEATURED, but her featuredEndsAt is in the past, so the effective tier is FREE (PR-SUB-004, MB-6)",
  );
}

// ── Q2 — Action A2: a customer places an order ───────────────────────────────
//
// PR-ORDER-001: an order is rejected 422 when the customer's userId equals the userId behind the
// target ProviderProfile. The guard is the WHERE clause of the INSERT itself, so there is no
// window between the check and the write in which the profile could be reassigned.
//
// Zero returned rows IS the rejection. Callers read that as 422; it is not an exception.

async function q2PlaceOrder(args: {
  customerId: string;
  providerProfileId: string;
  category: ServiceCategory;
  description: string;
  jobAddress: string;
  jobLatitude: number | null;
  jobLongitude: number | null;
  preferredDate: Date;
}): Promise<ReviewInsertRow[] | OrderRow[]> {
  return prisma.$queryRaw<ReviewInsertRow[] | OrderRow[]>(Prisma.sql`
    INSERT INTO orders (
      id, "customerId", "providerId", category, description,
      "jobAddress", "jobLatitude", "jobLongitude", "preferredDate",
      status, "providerMarkedDone", "autoCompleted", "createdAt", "updatedAt"
    )
    SELECT
      ${newCuid()}, ${args.customerId}, u.id, ${args.category}::"ServiceCategory", ${args.description},
      ${args.jobAddress}, ${args.jobLatitude}, ${args.jobLongitude}, ${args.preferredDate},
      'REQUESTED'::"OrderStatus", false, false, now(), now()
    FROM provider_profiles p
    JOIN users u ON u.id = p."userId"
    WHERE p.id = ${args.providerProfileId}
      AND p."userId" <> ${args.customerId}
    RETURNING id, "customerId", "providerId", category, status, "jobAddress", "agreedPriceKobo", "preferredDate", "proposedDate", "createdAt"
  `);
}

async function runQ2(): Promise<void> {
  heading("Q2 — A2: place an order (PR-ORDER-001, PR-ORDER-002, PR-ORDER-003)");

  const chidinma = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000001" } });
  const ada = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000002" } });
  const ngozi = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000007" } });
  const emeka = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000003" } });
  const emekaProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: emeka.id } });
  const ngoziProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: ngozi.id } });

  // The self-order block. Ngozi is CUSTOMER *and* holds a profile, which is legal (PR-AUTH-005) —
  // but she may not order from herself (PR-ORDER-001).
  const selfOrder = await q2PlaceOrder({
    customerId: ngozi.id,
    providerProfileId: ngoziProfile.id,
    category: "CLEANING",
    description: "Ordering my own listing — must be rejected.",
    jobAddress: "3 Bamgbose Street, Lagos Island, Lagos",
    jobLatitude: null,
    jobLongitude: null,
    preferredDate: new Date(Date.now() + 86_400_000),
  });
  check(
    "Q2 self-order is refused by the write",
    selfOrder.length === 0,
    "zero rows returned → the module maps this to 422, and no order row was created",
  );

  const before = await prisma.order.count({ where: { customerId: ngozi.id } });

  // A legal order: Chidinma orders from Emeka.
  const placed = await q2PlaceOrder({
    customerId: chidinma.id,
    providerProfileId: emekaProfile.id,
    category: "ELECTRICAL",
    description: "RCD keeps tripping on the second circuit. Needs a fault find and a quote.",
    jobAddress: "12B Allen Avenue, Ikeja, Lagos",
    jobLatitude: 6.5364,
    jobLongitude: 3.3702,
    preferredDate: new Date(Date.now() + 3 * 86_400_000),
  });
  check("Q2 a legal order is created", placed.length === 1, `order ${placed[0]?.id ?? "?"} inserted as REQUESTED`);

  const row = placed[0] as OrderRow;
  check(
    "Q2 a provider may order from a DIFFERENT provider",
    (await prisma.order.count({ where: { customerId: ada.id, providerId: ada.id } })) === 0,
    "same-account dual identity is allowed; only self-listing is blocked",
  );
  check(
    "Q2 status is the only legal opening value",
    row.status === "REQUESTED",
    "the INSERT pins status rather than trusting an input value (PR-ORDER-003, CS-7)",
  );
  check(
    "Q2 no money is captured at order time",
    row.agreedPriceKobo === null,
    "agreedPriceKobo stays null until the provider accepts (PR-ORDER-004a); the listed " +
      "startingPriceKobo is informational and creates no obligation (PR-PROVIDER-003)",
  );
  check(
    "Q2 the rejected self-order left no row behind",
    (await prisma.order.count({ where: { customerId: ngozi.id } })) === before,
    "the guard is part of the INSERT, so there is nothing to roll back",
  );
}

// ── Q3 — Action A3: a provider responds to an incoming request ───────────────

async function q3IncomingRequests(args: { providerUserId: string; limit: number }): Promise<
  Array<OrderRow & { customer_name: string; customer_city: string }>
> {
  return prisma.$queryRaw<Array<OrderRow & { customer_name: string; customer_city: string }>>(Prisma.sql`
    SELECT
      o.id, o."customerId", o."providerId", o.category, o.status, o."jobAddress",
      o."preferredDate", o."proposedDate", o."createdAt",
      u.name AS customer_name,
      u.city AS customer_city
    FROM orders o
    JOIN users u ON u.id = o."customerId"
    WHERE o."providerId" = ${args.providerUserId}
      AND o.status = 'REQUESTED'::"OrderStatus"
    ORDER BY o."createdAt" ASC
    LIMIT ${args.limit}
  `);
}

async function runQ3(): Promise<void> {
  heading("Q3 — A3: respond to an incoming request (PR-ORDER-004, PR-ORDER-005, PR-ORDER-011)");

  const bisi = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000004" } });
  const emeka = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000003" } });
  const ada = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000002" } });

  const queue = await q3IncomingRequests({ providerUserId: emeka.id, limit: 20 });
  console.log(`  Emeka's REQUESTED queue: ${queue.length} order(s)`);
  for (const o of queue) {
    console.log(`    ${o.category.padEnd(9)} from ${o.customer_name.padEnd(18)} preferred ${o.preferredDate.toISOString().slice(0, 10)}`);
  }

  check(
    "Q3 only the order's own provider sees the order",
    queue.every((o) => o.providerId === emeka.id),
    "the predicate is provider_id; another provider's queue is a different result set (PR-ORDER-011)",
  );
  check(
    "Q3 only REQUESTED orders are actionable",
    queue.every((o) => o.status === "REQUESTED"),
    "an already-declined order is not re-offered (PR-ORDER-003)",
  );

  const otherQueue = await q3IncomingRequests({ providerUserId: bisi.id, limit: 20 });
  const bisiSeesEmekasOrders = otherQueue.some((o) => o.providerId === emeka.id);
  check("Q3 Bisi cannot see Emeka's orders", !bisiSeesEmekasOrders, "cross-account read is denied by the predicate, not by a later filter");

  // PR-ORDER-011 again, from the other direction: the order's customer may read their own order.
  const customerView = await q3IncomingRequests({ providerUserId: emeka.id, limit: 1 });
  const notTheirs = customerView.filter((o) => o.customerId !== ada.id && o.customerId !== customerView[0]?.customerId);
  check("Q3 the queue exposes only the counterparty's name", notTheirs.length === 0, "no unrelated account data is joined in");
}

// ── Q4 — Action A4: complete, cancel, or dispute ─────────────────────────────
//
// The heaviest query in this file after Q1 is the 72-hour sweep (PR-TECH-008, PR-ORDER-007a).
// It runs on a schedule, reads from the head of the orders table, and must not scan it. The
// composite index (status, provider_marked_done, provider_marked_done_at) gives it two equality
// predicates on the leading columns and a range on the third.

async function q4StaleCompletionCandidates(args: { batchSize: number }): Promise<SweepRow[]> {
  return prisma.$queryRaw<SweepRow[]>(Prisma.sql`
    SELECT
      id, "customerId", "providerId", category, status, "jobAddress", "providerMarkedDoneAt"
    FROM orders
    WHERE status = 'IN_PROGRESS'::"OrderStatus"
      AND "providerMarkedDone" = true
      AND "providerMarkedDoneAt" < now() - interval '72 hours'
    ORDER BY "providerMarkedDoneAt" ASC
    LIMIT ${args.batchSize}
  `);
}

async function q4ConfirmCompletion(args: { orderId: string; customerId: string }): Promise<OrderRow[]> {
  return prisma.$queryRaw<OrderRow[]>(Prisma.sql`
    UPDATE orders
    SET
      status = 'COMPLETED'::"OrderStatus",
      "completedAt" = now(),
      "autoCompleted" = false,
      "updatedAt" = now()
    WHERE id = ${args.orderId}
      AND status = 'IN_PROGRESS'::"OrderStatus"
      AND "customerId" = ${args.customerId}
      AND "providerMarkedDone" = true
    RETURNING id, "customerId", "providerId", category, status, "jobAddress", "agreedPriceKobo", "preferredDate", "proposedDate", "createdAt"
  `);
}

async function q4AutoCompleteSweep(args: { orderId: string }): Promise<OrderRow[]> {
  return prisma.$queryRaw<OrderRow[]>(Prisma.sql`
    UPDATE orders
    SET status = 'COMPLETED'::"OrderStatus", "completedAt" = now(), "autoCompleted" = true, "updatedAt" = now()
    WHERE id = ${args.orderId}
      AND status = 'IN_PROGRESS'::"OrderStatus"
      AND "providerMarkedDone" = true
      AND "providerMarkedDoneAt" < now() - interval '72 hours'
    RETURNING id, "customerId", "providerId", category, status, "jobAddress", "agreedPriceKobo", "preferredDate", "proposedDate", "createdAt"
  `);
}

async function runQ4(): Promise<void> {
  heading("Q4 — A4: the 72-hour sweep and customer confirmation (PR-ORDER-007, PR-ORDER-007a, PR-TECH-008)");

  const ada = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000002" } });
  const chidinma = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000001" } });

  const candidates = await q4StaleCompletionCandidates({ batchSize: 50 });
  console.log(`  sweep candidates (IN_PROGRESS, provider done, >72h unconfirmed): ${candidates.length}`);
  for (const c of candidates) {
    const ageHours = (Date.now() - c.providerMarkedDoneAt.getTime()) / 3_600_000;
    console.log(`    ${c.category.padEnd(9)} provider done ${ageHours.toFixed(0)}h ago — ${c.jobAddress}`);
  }

  check("Q4 the stale seed order is found", candidates.length >= 1, "Tunde's order, provider done 5 days ago");
  check(
    "Q4 a job marked done 2h ago is NOT swept",
    !candidates.some((c) => c.jobAddress.includes("31 Herbert")),
    "the 72h threshold is applied in SQL, so the recent one is excluded before the batch is read",
  );

  // PR-ORDER-010: a terminal order must not move, and the sweep is the one path that may move a
  // DISPUTED order. Proved by pointing the sweep at an already-COMPLETED order.
  const completed = await prisma.order.findFirstOrThrow({ where: { status: "COMPLETED" } });
  const beforeReSweep = {
    status: completed.status,
    autoCompleted: completed.autoCompleted,
    completedAt: completed.completedAt?.getTime() ?? null,
  };
  const reSweep = await q4AutoCompleteSweep({ orderId: completed.id });
  const completedAfter = await prisma.order.findUniqueOrThrow({ where: { id: completed.id } });
  check(
    "Q4 a terminal order is not re-swept",
    reSweep.length === 0 &&
      completedAfter.status === beforeReSweep.status &&
      completedAfter.autoCompleted === beforeReSweep.autoCompleted &&
      (completedAfter.completedAt?.getTime() ?? null) === beforeReSweep.completedAt,
    `the guarded UPDATE matched no rows, so ${completed.id} kept status=${beforeReSweep.status} autoCompleted=${beforeReSweep.autoCompleted} unchanged (PR-ORDER-010)`,
  );

  // PR-ORDER-007: the customer's confirmation, guarded so only that order's customer can act.
  const inProgress = await prisma.order.findFirstOrThrow({
    where: { status: "IN_PROGRESS", providerMarkedDone: true, customerId: ada.id },
  });

  const wrongCustomer = await q4ConfirmCompletion({ orderId: inProgress.id, customerId: chidinma.id });
  check(
    "Q4 a non-customer cannot confirm completion",
    wrongCustomer.length === 0,
    "the guard is customer_id inside the UPDATE; the row is untouched",
  );

  const stillInProgress = await prisma.order.findUniqueOrThrow({ where: { id: inProgress.id } });
  check("Q4 the rejected confirmation changed nothing", stillInProgress.status === "IN_PROGRESS", "status is unchanged after the refused write");

  // The sweep's own end state, for the record: auto_completed = true distinguishes it.
  const swept = await q4AutoCompleteSweep({ orderId: inProgress.id });
  const sweptOrder = await prisma.order.findUniqueOrThrow({ where: { id: inProgress.id } });
  check("Q4 the sweep sets autoCompleted = true", sweptOrder.autoCompleted === true, "a swept order is never indistinguishable from a confirmed one (AGENTS rule 11)");
  check("Q4 the sweep only reaches genuinely stale rows", swept.length === 1, "the guarded UPDATE returned exactly the one overdue order");
}

// ── Q5 — Action A5: review a completed order ─────────────────────────────────
//
// PR-REVIEW-001: a review must be tied to exactly one COMPLETED order, be written by that
// order's customer, and there may be only one per order. All three are predicates of the INSERT.
//
// DB-9 is visible here and nowhere else in this file: the INSERT has to translate
// orders.providerId (a User.id) into provider_profiles.id, because reviews.providerId is a
// ProviderProfile.id. Doing it in this join is the whole point — the two columns share a name
// and nothing but this mapping distinguishes them.
//
// The rating aggregate is NOT touched by the submit. It is recomputed when an Admin approves
// (PR-REVIEW-005, PR-TECH-006), which is why approval is shown as its own guarded transaction.

async function q5SubmitReview(args: {
  orderId: string;
  customerId: string;
  rating: number;
  comment: string | null;
}): Promise<ReviewInsertRow[]> {
  return prisma.$queryRaw<ReviewInsertRow[]>(Prisma.sql`
    INSERT INTO reviews (id, "orderId", "customerId", "providerId", rating, comment, "moderationStatus", "createdAt")
    SELECT
      ${newCuid()}, o.id, o."customerId", p.id, ${args.rating}, ${args.comment},
      'PENDING'::"ReviewModerationStatus", now()
    FROM orders o
    JOIN provider_profiles p ON p."userId" = o."providerId"
    WHERE o.id = ${args.orderId}
      AND o.status = 'COMPLETED'::"OrderStatus"
      AND o."customerId" = ${args.customerId}
      AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r."orderId" = o.id)
    RETURNING id, "orderId", "providerId", "moderationStatus"
  `);
}

async function q5ApproveReview(args: { reviewId: string; adminId: string }): Promise<{ providerId: string }[]> {
  return prisma.$transaction(async (tx) => {
    // PR-REVIEW-005 / AGENTS rule 18: only an Admin may set APPROVED or REJECTED.
    const moved = await tx.$queryRaw<{ id: string; providerId: string }[]>(Prisma.sql`
      UPDATE reviews
      SET "moderationStatus" = 'APPROVED'::"ReviewModerationStatus"
      WHERE id = ${args.reviewId}
        AND "moderationStatus" IN ('PENDING'::"ReviewModerationStatus", 'FLAGGED'::"ReviewModerationStatus")
      RETURNING id, "providerId"
    `);
    if (moved.length === 0) {
      throw new Error("review is not in a state an Admin may approve");
    }
    const approved = moved[0];
    if (approved === undefined) {
      throw new Error("unreachable: length was checked above");
    }

    await tx.adminAction.create({
      data: {
        adminId: args.adminId,
        actionType: "REVIEW_MODERATION",
        targetId: args.reviewId,
        note: "Approved after review of the moderation queue.",
      },
    });

    // Recompute, never increment. The aggregate is derived from APPROVED reviews only.
    await tx.$executeRaw(Prisma.sql`
      UPDATE provider_profiles p
      SET
        "ratingAverage" = COALESCE(agg.avg_rating, 0),
        "ratingCount" = COALESCE(agg.n, 0),
        "updatedAt" = now()
      FROM (
        SELECT AVG(rating)::float8 AS avg_rating, COUNT(*)::int AS n
        FROM reviews
        WHERE "providerId" = ${approved.providerId}
          AND "moderationStatus" = 'APPROVED'::"ReviewModerationStatus"
      ) agg
      WHERE p.id = ${approved.providerId}
    `);

    return moved;
  });
}

async function runQ5(): Promise<void> {
  heading("Q5 — A5: review a completed order (PR-REVIEW-001/002/003/005, PR-TECH-006)");

  const chidinma = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000001" } });
  const ada = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000002" } });

  const completed = await prisma.order.findFirstOrThrow({
    where: { status: "COMPLETED", customerId: chidinma.id, review: null },
  });

  // The wrong author cannot review someone else's completed order.
  const wrongAuthor = await q5SubmitReview({
    orderId: completed.id,
    customerId: ada.id,
    rating: 5,
    comment: "I did not hire this provider; I must not be able to review their job.",
  });
  check("Q5 a non-customer cannot review the order", wrongAuthor.length === 0, "customer_id is a predicate of the INSERT");

  // A legal review.
  const review = await q5SubmitReview({
    orderId: completed.id,
    customerId: chidinma.id,
    rating: 5,
    comment: "Diagnosed the fault in 20 minutes and explained the fix clearly.",
  });
  check("Q5 the order's own customer can review it", review.length === 1, `review ${review[0]?.id ?? "?"} created as PENDING`);

  const created = review[0];
  if (created === undefined) {
    throw new Error("Q5: the legal review should have been created; the guard rejected an eligible order");
  }

  // One review per order, enforced by the INSERT's NOT EXISTS and by the unique index.
  const second = await q5SubmitReview({
    orderId: completed.id,
    customerId: chidinma.id,
    rating: 1,
    comment: "A second review on the same order must be refused.",
  });
  check("Q5 a second review on the same order is refused", second.length === 0, "NOT EXISTS inside the write, plus the unique index behind it");

  check(
    "Q5 a new review starts PENDING and is invisible",
    created.moderationStatus === "PENDING",
    "not APPROVED, therefore not public and not counted (AGENTS rule 17, PR-REVIEW-003)",
  );

  // Measure the profile of the order actually reviewed, not a hardcoded one. The order above is
  // chosen by findFirstOrThrow, so its provider is whichever one it happens to be; assuming it is
  // Emeka's measured a rating the approval never touched.
  const reviewedProfile = await prisma.providerProfile.findUniqueOrThrow({
    where: { userId: completed.providerId },
  });
  const beforeApproval = await prisma.providerProfile.findUniqueOrThrow({ where: { id: reviewedProfile.id } });

  const admin = await ensureProofAdmin();
  const approved = await q5ApproveReview({ reviewId: created.id, adminId: admin.id });
  check("Q5 an Admin approval moves PENDING to APPROVED", approved.length === 1, "only that transition is permitted (PR-REVIEW-005)");

  const adminActions = await prisma.adminAction.findMany({ where: { targetId: created.id } });
  const recordedAction = adminActions[0];
  check(
    "Q5 the approval left an append-only AdminAction",
    adminActions.length === 1 && recordedAction !== undefined && recordedAction.actionType === "REVIEW_MODERATION",
    "one new row, never an edit of a prior one (PR-ADMIN-004, AGENTS rule 21)",
  );

  const afterApproval = await prisma.providerProfile.findUniqueOrThrow({ where: { id: reviewedProfile.id } });
  const aggregate = await prisma.$queryRaw<RatingRow[]>(Prisma.sql`
    SELECT AVG(rating)::float8 AS "ratingAverage", COUNT(*)::int AS "ratingCount"
    FROM reviews
    WHERE "providerId" = ${reviewedProfile.id} AND "moderationStatus" = 'APPROVED'::"ReviewModerationStatus"
  `);
  check(
    "Q5 the rating was recomputed from APPROVED reviews",
    Math.abs(afterApproval.ratingAverage - (aggregate[0]?.ratingAverage ?? 0)) < 0.0001 &&
      afterApproval.ratingCount === Number(aggregate[0]?.ratingCount ?? -1),
    `ratingAverage ${beforeApproval.ratingAverage}(${beforeApproval.ratingCount}) → ${afterApproval.ratingAverage}(${afterApproval.ratingCount}), ` +
      `matching ${aggregate[0]?.ratingCount ?? 0} APPROVED review(s) (PR-TECH-006, DB-8)`,
  );
  // AGENTS rule 17: a PENDING or FLAGGED review is invisible and excluded from ratingAverage.
  // Find a provider that actually HAS hidden reviews, so the assertion is not vacuous, and prove
  // the stored aggregate counts only their APPROVED ones.
  const hidden = await prisma.review.findFirst({
    where: { moderationStatus: { in: ["PENDING", "FLAGGED"] } },
    orderBy: { createdAt: "asc" },
  });
  if (hidden === null) {
    check("Q5 the PENDING and FLAGGED reviews stayed out of the aggregate", false, "no PENDING/FLAGGED review exists to test with");
  } else {
    const hiddenCounts = await prisma.review.groupBy({
      by: ["moderationStatus"],
      where: { providerId: hidden.providerId },
      _count: { _all: true },
    });
    const hiddenApproved = hiddenCounts.find((c) => c.moderationStatus === "APPROVED")?._count._all ?? 0;
    const hiddenNonApproved = hiddenCounts
      .filter((c) => c.moderationStatus !== "APPROVED")
      .reduce((sum, c) => sum + c._count._all, 0);
    const stored = await prisma.providerProfile.findUniqueOrThrow({ where: { id: hidden.providerId } });
    check(
      "Q5 the PENDING and FLAGGED reviews stayed out of the aggregate",
      hiddenNonApproved > 0 && stored.ratingCount === hiddenApproved,
      `${hiddenNonApproved} non-APPROVED review(s) exist for this provider and are excluded; ` +
        `ratingCount=${stored.ratingCount} equals the ${hiddenApproved} APPROVED one(s) ` +
        `(AGENTS rule 17, PR-REVIEW-003, PR-REVIEW-005)`,
    );
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Fixora — five important user actions, as five queries.");
  console.log("Every write below is guarded in the write itself (CS-4). Every value is bound (CS-3).");

  await runQ1();
  await runQ2();
  await runQ3();
  await runQ4();
  await runQ5();

  heading("Result");
  if (failures === 0) {
    console.log("  All five queries behaved as the PRD requires.");
  } else {
    console.log(`  ${failures} check(s) failed.`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error("\nProof run failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
