// Fixora — schema proof fixtures.
//
// This file lives INSIDE /tests, which is where DB-13 permits a COMPLETED order and an APPROVED
// review to be created. Every one is built in its rule-satisfying end state rather than as a
// bare flag:
//
//   - a COMPLETED order carries providerMarkedDone, providerMarkedDoneAt, completedAt, and the
//     correct autoCompleted value, because status alone would not describe how it completed
//     (PR-ORDER-007, PR-ORDER-007a);
//   - an APPROVED review is tied to that order, authored by that order's customer, and is the
//     only review on the order (PR-REVIEW-001);
//   - ratingAverage and ratingCount are RECOMPUTED from the actual APPROVED reviews, never
//     incremented blindly (DB-8, PR-TECH-006).
//
// The recomputation below is deliberately written the way the one production function in
// /modules/reviews must be written, so the proof and the eventual implementation cannot drift.

import { PrismaClient, ReviewModerationStatus, ServiceCategory } from "@prisma/client";

const prisma = new PrismaClient();

const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

/** The single writer for ratingAverage / ratingCount. Recompute, never increment (DB-8). */
async function recalculateProviderRating(providerProfileId: string): Promise<{ ratingAverage: number; ratingCount: number }> {
  const aggregate = await prisma.review.aggregate({
    where: { providerId: providerProfileId, moderationStatus: ReviewModerationStatus.APPROVED },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const ratingAverage = aggregate._avg.rating ?? 0;
  const ratingCount = aggregate._count.rating;

  await prisma.providerProfile.update({
    where: { id: providerProfileId },
    data: { ratingAverage, ratingCount },
  });

  return { ratingAverage, ratingCount };
}

export async function buildProofFixtures(): Promise<void> {
  const chidinma = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000001" } });
  const ada = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000002" } });
  const emeka = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000003" } });
  const bisi = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000004" } });
  const ngozi = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000007" } });

  const emekaProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: emeka.id } });
  const bisiProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: bisi.id } });
  const ngoziProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: ngozi.id } });

  // ── 1. A customer-CONFIRMED completion ──────────────────────────────────────
  // Chidinma's ACCEPTED plumbing order from the seed, carried to its legal terminal state.
  const accepted = await prisma.order.findFirstOrThrow({
    where: { customerId: chidinma.id, status: "ACCEPTED" },
  });

  const confirmedOrder = await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: bisi.id,
      category: ServiceCategory.CLEANING,
      description: "Post-construction clean of a two-bedroom flat.",
      jobAddress: "5 Kakawa Street, Lekki Phase 1, Lagos",
      preferredDate: hoursAgo(24 * 9),
      status: "COMPLETED",
      // The provider's side, then the customer's confirmation. Both timestamps are part of the
      // end state; a COMPLETED order with neither would not describe how it completed.
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 4),
      completedAt: hoursAgo(24 * 3),
      autoCompleted: false,
    },
  });

  // Park the seed's ACCEPTED order in a terminal, rule-satisfying state so it is not a second
  // live ACCEPTED order competing with the fixtures.
  await prisma.order.update({
    where: { id: accepted.id },
    data: {
      status: "COMPLETED",
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 2),
      completedAt: hoursAgo(24 * 1),
      autoCompleted: false,
    },
  });

  // ── 2. An AUTO-COMPLETED order (the 72h sweep's end state) ──────────────────
  // Distinct from the confirmed one in exactly one field, which is what rule 11 requires any
  // history view to render differently.
  const autoCompletedOrder = await prisma.order.create({
    data: {
      customerId: ada.id,
      providerId: ngozi.id,
      category: ServiceCategory.CLEANING,
      description: "Weekly office clean; provider finished, customer went quiet.",
      jobAddress: "14 Adeola Odeku Street, Victoria Island, Lagos",
      preferredDate: hoursAgo(24 * 7),
      status: "COMPLETED",
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 5),
      completedAt: hoursAgo(24 * 3),
      autoCompleted: true,
    },
  });

  // ── 3. Reviews, one per order, each by that order's customer ────────────────
  // Approved: visible, and counted in the rating aggregate.
  await prisma.review.create({
    data: {
      orderId: confirmedOrder.id,
      customerId: chidinma.id,
      providerId: bisiProfile.id,
      rating: 5,
      comment: "Arrived on time, brought her own supplies, left the place spotless.",
      moderationStatus: ReviewModerationStatus.APPROVED,
    },
  });

  // Approved: the same author reviewing a different provider, so the aggregate has a count
  // worth reading.
  await prisma.review.create({
    data: {
      orderId: autoCompletedOrder.id,
      customerId: ada.id,
      providerId: ngoziProfile.id,
      rating: 4,
      comment: "Good work. Booked days late so I could not confirm it myself.",
      moderationStatus: ReviewModerationStatus.APPROVED,
    },
  });

  // PENDING: invisible, excluded from the aggregate (PR-REVIEW-003, AGENTS rule 17).
  const pendingHostOrder = await prisma.order.create({
    data: {
      customerId: chidinma.id,
      providerId: emeka.id,
      category: ServiceCategory.ELECTRICAL,
      description: "Install two ceiling fans in the bedrooms.",
      jobAddress: "8 Awolowo Avenue, Ikeja, Lagos",
      preferredDate: hoursAgo(24 * 12),
      status: "COMPLETED",
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 11),
      completedAt: hoursAgo(24 * 10),
      autoCompleted: true,
    },
  });

  await prisma.review.create({
    data: {
      orderId: pendingHostOrder.id,
      customerId: chidinma.id,
      providerId: emekaProfile.id,
      rating: 1,
      comment: "Did not show up at all. Still waiting three days later.",
      moderationStatus: ReviewModerationStatus.PENDING,
    },
  });

  // FLAGGED: awaiting an Admin decision, and equally excluded from the aggregate
  // (PR-REVIEW-005). aiFlagReason holds a closed-set reason code, never raw model text (AI-7).
  const flaggedHostOrder = await prisma.order.create({
    data: {
      customerId: ada.id,
      providerId: emeka.id,
      category: ServiceCategory.REPAIRS,
      description: "Replace a bathroom extractor motor.",
      jobAddress: "40 Awolowo Road, Ikoyi, Lagos",
      preferredDate: hoursAgo(24 * 6),
      status: "COMPLETED",
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(24 * 5),
      completedAt: hoursAgo(24 * 4),
      autoCompleted: true,
    },
  });

  await prisma.review.create({
    data: {
      orderId: flaggedHostOrder.id,
      customerId: ada.id,
      providerId: emekaProfile.id,
      rating: 1,
      comment: "Call me on 0803 555 0199 to arrange, or see www.fixspam.example — terrible service",
      moderationStatus: ReviewModerationStatus.FLAGGED,
      aiFlagReason: "EMBEDDED_CONTACT_DETAILS",
    },
  });

  // ── 4. Recompute every affected rating aggregate from APPROVED reviews only ──
  const summaries = [] as Array<{ provider: string; ratingAverage: number; ratingCount: number }>;

  for (const [label, profile] of [
    ["Bisi", bisiProfile],
    ["Ngozi", ngoziProfile],
    ["Emeka", emekaProfile],
  ] as const) {
    const summary = await recalculateProviderRating(profile.id);
    summaries.push({ provider: label, ...summary });
  }

  console.log("Proof fixtures built (DB-13 permits COMPLETED orders and APPROVED reviews inside /tests):");
  console.log(`  customer-confirmed completion  ${confirmedOrder.id}  autoCompleted=false`);
  console.log(`  sweep auto-completion          ${autoCompletedOrder.id}  autoCompleted=true`);
  console.log("  reviews: 2 APPROVED (counted), 1 PENDING (hidden), 1 FLAGGED (awaiting Admin)");
  console.log("  rating aggregates recomputed from APPROVED reviews only:");
  for (const s of summaries) {
    console.log(`    ${s.provider.padEnd(6)} ratingAverage=${s.ratingAverage} ratingCount=${s.ratingCount}`);
  }
}

export { recalculateProviderRating };

/**
 * The one place an ADMIN account comes into existence, and it lives inside /tests for the reason
 * DB-13 gives: prisma/seed.ts may not create one, and PR-AUTH-006 defines no public path by which
 * one appears. This is a proof fixture standing in for an operator with console access — it is
 * not an account that could be registered.
 */
export async function ensureProofAdmin(): Promise<{ id: string }> {
  const existing = await prisma.user.findUnique({ where: { phone: "+2340000000099" } });
  if (existing !== null) {
    return existing;
  }
  return prisma.user.create({
    data: {
      phone: "+2340000000099",
      role: "ADMIN",
      name: "Internal Operator (proof fixture)",
      city: "Lagos",
      state: "Lagos",
      latitude: 6.5244,
      longitude: 3.3792,
    },
  });
}

// This module is imported by five-queries.ts as well as runnable on its own, so it must not
// execute on import. It only runs when node invokes it directly.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  buildProofFixtures()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error("\nFixture build failed:", error);
      process.exitCode = 1;
    });
}
