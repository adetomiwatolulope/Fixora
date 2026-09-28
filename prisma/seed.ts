// Fixora — schema proof seed (PRD §10, synthetic data only).
//
// DB-13 restricts this file because it lives OUTSIDE /tests. It therefore creates:
//
//   - only CUSTOMER and PROVIDER accounts. Never an ADMIN: PR-AUTH-006 defines no path by which
//     one comes into existence, and DB-13 forbids a seed outside /tests from creating one.
//   - no COMPLETED order and no APPROVED review. Those belong to tests/schema-proof/fixtures.ts,
//     which is inside /tests and is where DB-13 permits them.
//
// Everything here is legal, reachable state: order profiles, a provider queue, and one stale
// IN_PROGRESS order for the PR-TECH-008 sweep to find.
//
// GIT-2: no real personal data. Every phone number below is in the +234 000 000 0000 block,
// which is not an assignable Nigerian mobile range and cannot be dialled.

import { PrismaClient, SubscriptionTier, UserRole, ServiceCategory, OrderStatus, CancelReasonCode } from "@prisma/client";
import { createHmac } from "node:crypto";

const prisma = new PrismaClient();

const HOUR = 60 * 60 * 1000;

// Reference point: central Lagos. Providers are clustered within a few kilometres so the
// bounding-box prefilter and the haversine ordering are both meaningful at seed size.
const LAGOS = { latitude: 6.5244, longitude: 3.3792 };

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

function fakeOtpHash(phone: string, code: string): string {
  return createHmac("sha256", "task-3-proof-not-a-real-secret").update(`${phone}:${code}`).digest("hex");
}

/**
 * The seed deletes every row in every table, so it must never be triggerable by accident.
 * GIT-4 requires an explicit instruction before a destructive command, and pointing .env at a
 * real database then running `npm run proof` would otherwise wipe it silently. The opt-in below
 * makes that a decision rather than a side effect.
 */
function assertExplicitlyAuthorisedToReset(): void {
  if (process.env.FIXORA_ALLOW_SEED_RESET !== "1") {
    throw new Error(
      "Refusing to run: the seed deletes all rows in reviews, admin_actions, orders, otp_codes, " +
        "provider_profiles and users. Set FIXORA_ALLOW_SEED_RESET=1 in .env to confirm this is a " +
        "disposable proof database (GIT-4).",
    );
  }

  const url = process.env.DATABASE_URL;
  if (url === undefined || !url.startsWith("postgresql://")) {
    throw new Error("Refusing to run: DATABASE_URL is missing or is not a PostgreSQL connection string.");
  }

  const target = new URL(url).pathname.replace(/^\//, "");
  console.log(`  authorised reset of database "${target}" (FIXORA_ALLOW_SEED_RESET=1)`);
}

async function reset(): Promise<void> {
  assertExplicitlyAuthorisedToReset();
  // Child rows first. Every relation is onDelete: Restrict (DB-7), so the order of these
  // deletes is the reverse of the FK graph and deleting a parent with children would fail.
  await prisma.review.deleteMany();
  await prisma.adminAction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.providerProfile.deleteMany();
  await prisma.user.deleteMany();
}

async function main(): Promise<void> {
  await reset();

  // ── Accounts ────────────────────────────────────────────────────────────────
  // u_ngozi is the PR-AUTH-005 case: role CUSTOMER *and* a ProviderProfile, under one account.
  const chidinma = await prisma.user.create({
    data: {
      phone: "+2340000000001",
      role: UserRole.CUSTOMER,
      name: "Chidinma Adeyemi",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude + 0.012,
      longitude: LAGOS.longitude - 0.009,
    },
  });

  const ada = await prisma.user.create({
    data: {
      phone: "+2340000000002",
      role: UserRole.CUSTOMER,
      name: "Ada Nwachukwu",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude - 0.021,
      longitude: LAGOS.longitude + 0.017,
    },
  });

  const emeka = await prisma.user.create({
    data: {
      phone: "+2340000000003",
      role: UserRole.PROVIDER,
      name: "Emeka Obi",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude + 0.031,
      longitude: LAGOS.longitude + 0.026,
    },
  });

  const bisi = await prisma.user.create({
    data: {
      phone: "+2340000000004",
      role: UserRole.PROVIDER,
      name: "Bisi Afolabi",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude - 0.038,
      longitude: LAGOS.longitude + 0.034,
    },
  });

  const tunde = await prisma.user.create({
    data: {
      phone: "+2340000000005",
      role: UserRole.PROVIDER,
      name: "Tunde Balogun",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude + 0.058,
      longitude: LAGOS.longitude - 0.044,
    },
  });

  const grace = await prisma.user.create({
    data: {
      phone: "+2340000000006",
      role: UserRole.PROVIDER,
      name: "Grace Eze",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude - 0.004,
      longitude: LAGOS.longitude - 0.051,
    },
  });

  // CUSTOMER who also provides — PR-AUTH-005, and the account shape the self-order guard
  // (PR-ORDER-001) exists to protect.
  const ngozi = await prisma.user.create({
    data: {
      phone: "+2340000000007",
      role: UserRole.CUSTOMER,
      name: "Ngozi Okonkwo",
      city: "Lagos",
      state: "Lagos",
      latitude: LAGOS.latitude + 0.006,
      longitude: LAGOS.longitude + 0.011,
    },
  });

  // ── Provider profiles ───────────────────────────────────────────────────────
  // Subscription tiers cover the three reachable cases MB-6 needs one test to agree on:
  // live FEATURED, expired FEATURED (the fail-closed case), and FREE.
  // A fourth case - FEATURED with a null window - is deliberately absent: CHECK C3 refuses to
  // store it, so it cannot be seeded. It is instead proven as a rejection in invalid-states.ts.
  await prisma.providerProfile.create({
    data: {
      userId: emeka.id,
      categories: [ServiceCategory.ELECTRICAL, ServiceCategory.REPAIRS],
      bio: "Electrician, 8 years. Consumer and small commercial work.",
      startingPriceKobo: 1_500_000,
    },
  });

  await prisma.providerProfile.create({
    data: {
      userId: bisi.id,
      categories: [ServiceCategory.PLUMBING, ServiceCategory.CLEANING],
      bio: "Plumbing and deep cleaning across Lagos mainland.",
      startingPriceKobo: 800_000,
      subscriptionTier: SubscriptionTier.FEATURED,
      featuredStartedAt: hoursAgo(24 * 10),
      featuredEndsAt: hoursFromNow(24 * 20),
    },
  });

  await prisma.providerProfile.create({
    data: {
      userId: tunde.id,
      categories: [ServiceCategory.PLUMBING],
      bio: "Plumbing repairs and installations.",
      startingPriceKobo: 950_000,
      subscriptionTier: SubscriptionTier.FEATURED,
      featuredStartedAt: hoursAgo(24 * 40),
      featuredEndsAt: hoursAgo(24 * 10),
    },
  });

  await prisma.providerProfile.create({
    data: {
      userId: grace.id,
      categories: [ServiceCategory.PAINTING, ServiceCategory.PHOTOGRAPHY],
      bio: "Interior painting and event photography.",
      startingPriceKobo: 2_000_000,
      // FEATURED whose window has already EXPIRED: the fail-closed case. The stored tier still
      // says FEATURED, but the effective tier must read as FREE (PR-SUB-002, PR-SUB-004, MB-6).
      //
      // The window must be present, not null. CHECK constraint C3 is
      //   subscriptionTier <> 'FEATURED' OR featuredEndsAt IS NOT NULL
      // so a FEATURED row with a null window is refused outright. That is deliberate: "expires in
      // the past" and "was never given a window" are different states, and only the first one is
      // a real product state. A FEATURED row with no window at all is a bug, not an expiry.
      subscriptionTier: SubscriptionTier.FEATURED,
      featuredStartedAt: hoursAgo(24 * 40),
      featuredEndsAt: hoursAgo(24 * 10),
    },
  });

  await prisma.providerProfile.create({
    data: {
      userId: ngozi.id,
      categories: [ServiceCategory.CLEANING],
      bio: "Deep cleaning, part-time alongside a full-time role.",
      startingPriceKobo: 600_000,
    },
  });

  // ── OTP codes ───────────────────────────────────────────────────────────────
  // codeHash holds an HMAC, never a code (SEC-1). No originating-IP column exists — SEC-11
  // requires that gap to be flagged, not filled with a per-instance counter.
  await prisma.otpCode.createMany({
    data: [
      { phone: "+2340000000001", codeHash: fakeOtpHash("+2340000000001", "482913"), expiresAt: hoursFromNow(0.08), attempts: 0 },
      { phone: "+2340000000001", codeHash: fakeOtpHash("+2340000000001", "771204"), expiresAt: hoursFromNow(0.05), attempts: 2 },
      { phone: "+2340000000002", codeHash: fakeOtpHash("+2340000000002", "339087"), expiresAt: hoursFromNow(0.02), attempts: 5, consumedAt: hoursAgo(0.01) },
      { phone: "+2340000000003", codeHash: fakeOtpHash("+2340000000003", "615528"), expiresAt: hoursAgo(3), attempts: 1 },
    ],
  });

  // ── Orders ──────────────────────────────────────────────────────────────────
  // Emeka's incoming queue: two REQUESTED orders, which is what A3 acts on.
  await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: emeka.id,
      category: ServiceCategory.ELECTRICAL,
      description: "Consumer unit trips whenever the kettle and the AC run together. Needs a fault find.",
      jobAddress: "12B Allen Avenue, Ikeja, Lagos",
      jobLatitude: LAGOS.latitude + 0.012,
      jobLongitude: LAGOS.longitude - 0.009,
      preferredDate: hoursFromNow(24 * 2),
    },
  });

  await prisma.order.create({
    data: {
      customerId: ada.id,
      providerId: emeka.id,
      category: ServiceCategory.REPAIRS,
      description: "Two ceiling fans need new capacitors and blades balanced.",
      jobAddress: "4 Awolowo Road, Ikoyi, Lagos",
      jobLatitude: LAGOS.latitude - 0.021,
      jobLongitude: LAGOS.longitude + 0.017,
      preferredDate: hoursFromNow(24 * 4),
      proposedDate: hoursFromNow(24 * 6),
    },
  });

  // Accepted, with the provider's optional informational agreed price (PR-ORDER-004a).
  await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: bisi.id,
      category: ServiceCategory.PLUMBING,
      description: "Kitchen tap dripping constantly and the shut-off valve has seized.",
      jobAddress: "22 Opebi Road, Victoria Island, Lagos",
      preferredDate: hoursFromNow(24 * 1),
      status: OrderStatus.ACCEPTED,
      agreedPriceKobo: 450_000,
    },
  });

  // The PR-TECH-008 sweep candidate: provider marked done 5 days ago, customer never confirmed.
  await prisma.order.create({
    data: {
      customerId: ada.id,
      providerId: tunde.id,
      category: ServiceCategory.PLUMBING,
      description: "Bathroom cistern replaced; flushing cleanly since.",
      jobAddress: "9 Herbert Macaulay Way, Yaba, Lagos",
      preferredDate: hoursAgo(24 * 6),
      status: OrderStatus.IN_PROGRESS,
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 5),
    },
  });

  // A second IN_PROGRESS order that is NOT stale — the sweep must leave it alone.
  await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: tunde.id,
      category: ServiceCategory.PLUMBING,
      description: "Bathroom extractor fan replacement, part ordered.",
      jobAddress: "31 Herbert Macaulay Way, Yaba, Lagos",
      preferredDate: hoursAgo(6),
      status: OrderStatus.IN_PROGRESS,
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(2),
    },
  });

  // Cancelled with a structured code (AGENTS rule 12) — PROVIDER_NO_SHOW is the value that
  // makes a repeat-offender pattern queryable rather than buried in free text.
  await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: grace.id,
      category: ServiceCategory.PAINTING,
      description: "Repaint a two-bedroom flat, walls and ceiling.",
      jobAddress: "7 Bourdillon Road, Ikoyi, Lagos",
      preferredDate: hoursAgo(24 * 8),
      status: OrderStatus.CANCELLED,
      cancelledBy: grace.id,
      cancelReasonCode: CancelReasonCode.PROVIDER_NO_SHOW,
      cancelReason: "Did not arrive during the agreed three-hour window; no contact.",
    },
  });

  await prisma.order.create({
    data: {
      customerId: ada.id,
      providerId: emeka.id,
      category: ServiceCategory.REPAIRS,
      description: "Replace a failed washing machine door interlock.",
      jobAddress: "18 Sani Abacha Road, Lagos",
      preferredDate: hoursFromNow(24 * 3),
      status: OrderStatus.DECLINED,
      declineReason: "No interlock parts in stock before the requested date.",
    },
  });

  // PR-AUTH-005: a provider-role-capable account placing an order as a customer, against a
  // *different* provider. This is legal and is the exact case that PR-ORDER-001's 422 protects
  // the boundary of — ngozi ordering from ngoziProfile would be rejected, this one is not.
  await prisma.order.create({
    data: {
      customerId: ngozi.id,
      providerId: bisi.id,
      category: ServiceCategory.CLEANING,
      description: "Two-bedroom deep clean before tenants move in.",
      jobAddress: "3 Bamgbose Street, Lagos Island, Lagos",
      preferredDate: hoursFromNow(24 * 5),
    },
  });

  const counts = {
    users: await prisma.user.count(),
    providerProfiles: await prisma.providerProfile.count(),
    otpCodes: await prisma.otpCode.count(),
    orders: await prisma.order.count(),
    reviews: await prisma.review.count(),
    adminActions: await prisma.adminAction.count(),
  };

  console.log("Seed complete (synthetic data only, DB-13 compliant):");
  console.log(`  users             ${counts.users}   (0 ADMIN — PR-AUTH-006, DB-13)`);
  console.log(`  provider_profiles ${counts.providerProfiles}`);
  console.log(`  otp_codes         ${counts.otpCodes}`);
  console.log(`  orders            ${counts.orders}    (0 COMPLETED — created by tests/schema-proof)`);
  console.log(`  reviews           ${counts.reviews}    (0 APPROVED — created by tests/schema-proof)`);
  console.log(`  admin_actions     ${counts.adminActions}    (append-only, and no ADMIN exists to write one)`);
  console.log(`  featured tiers    live=Bisi  expired=Tunde,Grace  free=Emeka,Ngozi`);
  console.log(`                    (no FEATURED row has a null window: CHECK C3 forbids it)`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
