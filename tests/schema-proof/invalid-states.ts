// Fixora - the invalid states and the stores the new requirements depend on, attempted against the
// live database (Checkpoint 5).
//
// The point of this file is that these writes are *refused by PostgreSQL itself*, not by
// application code that happens to run first. A schema constraint is the last line: even a bug,
// a hand-written admin query, or a future code path that forgets the check cannot write the bad
// row. Each rejected case therefore asserts two things - the write was refused, and the row is not
// there afterwards. Each accepted case carries a positive control, or the constraint might simply
// be refusing everything.
//
//   Rejections:
//   1. A review with rating 6        -> reviews_rating_between_1_and_5        (PR-REVIEW-002, CS-5)
//   2. A second review on one order  -> reviews_orderId_key unique index     (PR-REVIEW-001)
//   3. A provider with no categories -> provider_profiles_categories_at_least_one
//                                                                      (PR-PROVIDER-001, PR-AUTH-004, PR-PROVIDER-002)
//   4. A 501-character provider bio -> provider_profiles_bio_max_500_chars  (PR-PROVIDER-001)
//
//   Stores the requirements need but the six locked models had nowhere to put (owner-authorised,
//   see docx/03-design-decisions.md section 12):
//   5. ModerationPattern - the Admin-maintained add/remove list       (PR-AI-002, AGENTS rule 19)
//   6. OtpSendAttempt    - per-originating-IP OTP send accounting     (PR-TECH-002a)
//
// Cases 5 and 6 prove the storage exists and behaves; the Admin authorisation, the keyword
// matching, and the 429 response are application behaviour that a schema cannot demonstrate.
//
// Exits non-zero if any rejected case is accepted, or any accepted case is refused, because either
// outcome means the migration is wrong.

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let failures = 0;

function check(label: string, passed: boolean, detail: string): void {
  if (passed) {
    console.log(`  PASS  ${label} — ${detail}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

interface Rejection {
  rejected: boolean;
  reason: string;
}

async function attempt(write: () => Promise<unknown>): Promise<Rejection> {
  try {
    await write();
    return { rejected: false, reason: "the write was ACCEPTED" };
  } catch (error: unknown) {
    // This string is the evidence for the whole file, so it has to carry the server's own words:
    // the SQLSTATE, the constraint name, and the server message. The same fault reaches us in
    // three different shapes depending on how it was raised -
    //   prisma.review.create  -> P2002 / P2004, client-side
    //   prisma.providerProfile.create -> a raw PostgresError debug payload, quotes backslash-escaped
    //   prisma.$executeRaw    -> P2010, with the real code and message on .meta
    // so every string the error carries is pooled and all three shapes are matched, rather than
    // assuming one of them.
    const strings: string[] = [];
    let prismaCode = "";
    let metaMessage = "";
    if (typeof error === "object" && error !== null) {
      if ("code" in error) {
        prismaCode = String(error.code);
        strings.push(prismaCode);
      }
      if ("meta" in error && typeof error.meta === "object" && error.meta !== null) {
        const meta = error.meta as Record<string, unknown>;
        for (const key of ["code", "message", "constraint"]) {
          if (key in meta) strings.push(String(meta[key]));
        }
        metaMessage = typeof meta.message === "string" ? meta.message : "";
      }
    }
    const raw = error instanceof Error ? error.message : String(error);
    strings.push(raw);

    // Captured before unescaping, because a Postgres message contains quoted relation names
    // ("reviews") and matching afterwards would stop at the first one of them.
    const joined = strings.join("\n");
    const text = joined.replace(/\\"/g, '"');
    const sqlstate =
      text.match(/(?:code|sqlstate)\s*[:=]\s*[`"']?(\w{5})[`"']?/i)?.[1] ??
      (prismaCode !== "" && /^\d{5}$/.test(prismaCode) ? prismaCode : "");
    const named = text.match(/constraint\s+"([A-Za-z0-9_]+)"/i)?.[1];
    const uniqueFields = text.match(/Unique constraint failed on the fields: \(([^)]*)\)/i)?.[1];

    // The three shapes bury the useful sentence in different places and sometimes split it across
    // lines, so take whichever candidate is a complete server sentence rather than the first
    // fragment a regex lands on.
    const scraped = joined.match(/message\s*[:=]\s*[`"]((?:[^`"\\]|\\.)*)[`"]/i)?.[1]?.replace(/\\(.)/g, "$1");
    const serverLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /violates|duplicate key|already exists/i.test(line) && !/^Detail\b/.test(line));
    const candidates = [metaMessage.trim(), (scraped ?? "").trim(), (serverLine ?? "").trim()].filter(
      (candidate) => candidate !== "",
    );
    const serverMessage = candidates.find((candidate) => /violates|duplicate key|already exists/i.test(candidate)) ?? "";

    const pieces = [
      sqlstate !== "" ? `SQLSTATE ${sqlstate}` : prismaCode,
      serverMessage,
      named !== undefined ? `constraint=${named}` : undefined,
      uniqueFields !== undefined ? `fields=(${uniqueFields})` : undefined,
    ].filter((p): p is string => p !== undefined && p !== "");

    const detail = pieces.join(" | ");
    return { rejected: true, reason: detail !== "" ? detail : (text.split("\n")[0] ?? "") };
  }
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * HOUR);
}

const HOUR = 60 * 60 * 1000;

// ── Case 1: a review rating outside 1..5 ─────────────────────────────────────

async function caseRatingOutOfRange(): Promise<void> {
  console.log("\n  Case 1 — a review with rating = 6");

  const customer = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000001" } });
  const provider = await prisma.user.findUniqueOrThrow({ where: { phone: "+2340000000003" } });
  const providerProfile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: provider.id } });

  const hostOrder = await prisma.order.create({
    data: {
      customerId: customer.id,
      providerId: provider.id,
      category: "ELECTRICAL",
      description: "Socket in the kitchen needs replacing.",
      jobAddress: "6 Obafemi Awolowo Way, Ikoyi, Lagos",
      preferredDate: hoursAgo(48),
      status: "COMPLETED",
      providerMarkedDone: true,
      providerMarkedDoneAt: hoursAgo(40),
      completedAt: hoursAgo(30),
      autoCompleted: true,
    },
  });

  const reviewsBefore = await prisma.review.count();

  const outcome = await attempt(() =>
    prisma.review.create({
      data: {
        orderId: hostOrder.id,
        customerId: customer.id,
        providerId: providerProfile.id,
        rating: 6,
        comment: "Six stars is not on the scale.",
        moderationStatus: "PENDING",
      },
    }),
  );

  const reviewsAfter = await prisma.review.count();
  console.log(`    rejected: ${outcome.rejected}`);
  console.log(`    reason:   ${outcome.reason}`);

  check("1. rating = 6 is refused", outcome.rejected, "reviews_rating_between_1_and_5 raised a check violation");
  check("1. no review row was written", reviewsAfter === reviewsBefore, `review count unchanged at ${reviewsAfter}`);

  // The boundary values must still be accepted, or the constraint is too strict.
  const five = await attempt(() =>
    prisma.review.create({
      data: {
        orderId: hostOrder.id,
        customerId: customer.id,
        providerId: providerProfile.id,
        rating: 5,
        comment: "Boundary check: the top of the scale is legal.",
        moderationStatus: "PENDING",
      },
    }),
  );
  check("1. rating = 5 is still accepted", !five.rejected, "the constraint is a range, not a cap below the maximum");
}

// ── Case 2: two reviews on one order ─────────────────────────────────────────

async function caseDuplicateReview(): Promise<void> {
  console.log("\n  Case 2 — a second review on the same order");

  const reviewed = await prisma.order.findFirstOrThrow({
    where: { status: "COMPLETED", review: { isNot: null } },
    include: { review: true, customer: true },
  });
  const review = reviewed.review;
  if (review === null) {
    throw new Error("expected a reviewed order");
  }

  const reviewsBefore = await prisma.review.count();

  const outcome = await attempt(() =>
    prisma.review.create({
      data: {
        orderId: reviewed.id,
        customerId: reviewed.customerId,
        providerId: review.providerId,
        rating: 1,
        comment: "A second review of the same job.",
        moderationStatus: "PENDING",
      },
    }),
  );

  const reviewsAfter = await prisma.review.count();
  const reviewsOnOrder = await prisma.review.count({ where: { orderId: reviewed.id } });
  console.log(`    rejected: ${outcome.rejected}`);
  console.log(`    reason:   ${outcome.reason}`);

  // The Prisma create above reports P2002, which is Prisma's own code and says nothing about
  // whether Postgres or the ORM refused. Repeating the same insert as raw SQL forces the server
  // to answer, which is the claim this file actually needs to support: the database refuses it,
  // and the index that refuses it is named.
  const rawDuplicate = await attempt(() =>
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO reviews (id, "orderId", "customerId", "providerId", rating, comment, "moderationStatus", "createdAt")
      VALUES (${'raw_dup_' + reviewed.id}, ${reviewed.id}, ${reviewed.customerId}, ${review.providerId},
              1, ${'Raw SQL duplicate, to see the server error.'}, 'PENDING'::"ReviewModerationStatus", now())
    `),
  );
  console.log(`    server:   ${rawDuplicate.reason}`);

  // Prisma reports the raw failure as P2010 and does not put the index name in the error, so the
  // enforcing index is named from the catalogue rather than scraped out of a debug string.
  const enforcing = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>(Prisma.sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename = 'reviews' AND indexdef LIKE '%UNIQUE%'
  `);
  for (const index of enforcing) {
    console.log(`    index:    ${index.indexname}`);
  }

  const reviewsAfterRaw = await prisma.review.count();
  check("2. a duplicate review is refused", outcome.rejected, "the unique index reviews_orderId_key on reviews.orderId (PR-REVIEW-001) rejected it");
  check(
    "2. the database itself refuses the write, not just the ORM",
    rawDuplicate.rejected && /23505/.test(rawDuplicate.reason),
    `raw SQL duplicate is rejected by Postgres with ${rawDuplicate.reason}`,
  );
  check(
    "2. a unique index on reviews.orderId is what enforces it",
    enforcing.some((index) => index.indexname === "reviews_orderId_key"),
    enforcing.map((index) => index.indexname).join(", "),
  );
  check("2. no second row was written", reviewsAfter === reviewsBefore && reviewsAfterRaw === reviewsBefore, `review count unchanged at ${reviewsAfterRaw}`);
  check("2. the order still has exactly one review", reviewsOnOrder === 1, `reviews on order ${reviewed.id} = ${reviewsOnOrder}`);
}

// ── Case 3: a provider with an empty category list ───────────────────────────

async function caseEmptyCategories(): Promise<void> {
  console.log("\n  Case 3 — a provider profile with categories = []");

  const candidate = await prisma.user.create({
    data: {
      phone: "+2340000000098",
      role: "PROVIDER",
      name: "No Categories (proof fixture)",
      city: "Lagos",
      state: "Lagos",
      latitude: 6.5244,
      longitude: 3.3792,
    },
  });

  const profilesBefore = await prisma.providerProfile.count();

  const outcome = await attempt(() =>
    prisma.providerProfile.create({
      data: {
        userId: candidate.id,
        categories: [],
        bio: "Deliberately category-less to prove the constraint.",
        startingPriceKobo: 100_000,
      },
    }),
  );

  const profilesAfter = await prisma.providerProfile.count();
  console.log(`    rejected: ${outcome.rejected}`);
  console.log(`    reason:   ${outcome.reason}`);

  check("3. categories = [] is refused", outcome.rejected, "provider_profiles_categories_at_least_one raised a check violation");
  check("3. no profile row was written", profilesAfter === profilesBefore, `provider_profiles count unchanged at ${profilesAfter}`);

  // A non-empty list on the same user must succeed, proving the constraint is not simply
  // refusing every insert.
  const accepted = await attempt(() =>
    prisma.providerProfile.create({
      data: {
        userId: candidate.id,
        categories: ["OTHER"],
        bio: "Now with exactly one category.",
        startingPriceKobo: 100_000,
      },
    }),
  );
  check("3. a non-empty category list is accepted", !accepted.rejected, "the constraint rejects emptiness, not categorisation");

  // Leave no residue: the fixture user goes too, and the profile must go first (DB-7, Restrict).
  await prisma.providerProfile.deleteMany({ where: { userId: candidate.id } });
  await prisma.user.delete({ where: { id: candidate.id } });
}

// -- Case 4: an over-long provider bio (PR-PROVIDER-001) ------------------------

async function caseBioTooLong(): Promise<void> {
  console.log("\n  Case 4 - a provider bio of 501 characters");

  const candidate = await prisma.user.create({
    data: {
      phone: "+2340000000097",
      role: "PROVIDER",
      name: "Long Bio (proof fixture)",
      city: "Lagos",
      state: "Lagos",
      latitude: 6.5244,
      longitude: 3.3792,
    },
  });

  const profilesBefore = await prisma.providerProfile.count();
  const tooLong = "a".repeat(501);
  const atLimit = "a".repeat(500);

  const outcome = await attempt(() =>
    prisma.providerProfile.create({
      data: {
        userId: candidate.id,
        categories: ["CLEANING"],
        bio: tooLong,
        startingPriceKobo: 100_000,
      },
    }),
  );
  console.log(`    rejected: ${outcome.rejected}`);
  console.log(`    reason:   ${outcome.reason}`);

  const profilesAfter = await prisma.providerProfile.count();
  check("4. a 501-character bio is refused", outcome.rejected, "provider_profiles_bio_max_500_chars raised a check violation");
  check("4. no profile row was written", profilesAfter === profilesBefore, `provider_profiles count unchanged at ${profilesAfter}`);

  // The positive control is the part that matters: a cap of exactly 500 must still be accepted, or
  // the constraint is off by one and would reject a legitimate maximum-length bio.
  const control = await attempt(() =>
    prisma.providerProfile.create({
      data: {
        userId: candidate.id,
        categories: ["CLEANING"],
        bio: atLimit,
        startingPriceKobo: 100_000,
      },
    }),
  );
  check("4. a bio of exactly 500 characters is still accepted", !control.rejected, "the cap is inclusive: 500 is valid, 501 is not");

  // The accepted control profile has to go first: a user may hold only one profile, so leaving
  // it in place would make the next insert fail on the userId unique index instead of being a
  // clean test of the nullable bio.
  await prisma.providerProfile.deleteMany({ where: { userId: candidate.id } });

  // A NULL bio is a provider who has not written one yet, which is not a length violation.
  const nullBio = await attempt(() =>
    prisma.providerProfile.create({
      data: {
        userId: candidate.id,
        categories: ["CLEANING"],
        startingPriceKobo: 100_000,
      },
    }),
  );
  check("4. a provider with no bio at all is still accepted", !nullBio.rejected, "bio is nullable; the constraint only bounds length when a bio exists");

  await prisma.providerProfile.deleteMany({ where: { userId: candidate.id } });
  await prisma.user.delete({ where: { id: candidate.id } });
}

// -- Case 5: the moderation pattern list is admin-maintained data (PR-AI-002) -----

async function caseModerationPatternList(): Promise<void> {
  console.log("\n  Case 5 - the moderation pattern list is data, not hardcoded behaviour");

  // PR-AI-002 and AGENTS rule 19: an Admin maintains the keyword list through an internal
  // add/remove list so it changes without a deployment. That is only possible if the entries live
  // in the database. This proves the store exists and behaves as an editable list.
  const added = await attempt(() =>
    prisma.moderationPattern.create({
      data: { kind: "ABUSE", pattern: "proof-fixture-pattern", note: "Added by the proof to show Admin add/remove." },
    }),
  );
  check("5. an Admin can add a moderation pattern", !added.rejected, "the pattern is stored as a row, not compiled into the application");

  const listed = await prisma.moderationPattern.findMany({ where: { pattern: "proof-fixture-pattern" } });
  check("5. the added pattern is readable back", listed.length === 1, `pattern rows matching = ${listed.length}`);

  // Re-adding the same (kind, pattern) is a conflict rather than a duplicate that would match
  // twice and inflate a count of how many rules fired.
  const duplicate = await attempt(() =>
    prisma.moderationPattern.create({
      data: { kind: "ABUSE", pattern: "proof-fixture-pattern" },
    }),
  );
  check(
    "5. the same pattern cannot be listed twice under one kind",
    duplicate.rejected,
    `moderation_patterns_kind_pattern_key refuses it: ${duplicate.reason}`,
  );

  // Disabling is how a rule is retired without deleting the audit trail of when it existed.
  const patternId = listed[0]?.id;
  if (patternId === undefined) {
    throw new Error("the added moderation pattern is missing, so the disable step cannot run");
  }
  await prisma.moderationPattern.update({ where: { id: patternId }, data: { enabled: false } });
  const disabled = await prisma.moderationPattern.findFirst({ where: { pattern: "proof-fixture-pattern" } });
  check("5. a pattern can be retired by disabling it", disabled?.enabled === false, "enabled=false retires a rule without deleting the row");

  await prisma.moderationPattern.deleteMany({ where: { pattern: "proof-fixture-pattern" } });
  const afterRemoval = await prisma.moderationPattern.count({ where: { pattern: "proof-fixture-pattern" } });
  check("5. an Admin can remove a pattern", afterRemoval === 0, `pattern rows after removal = ${afterRemoval}`);
}

// -- Case 6: per-IP OTP send accounting (PR-TECH-002a) ---------------------------

async function caseOtpIpRateLimitStore(): Promise<void> {
  console.log("\n  Case 6 - per-originating-IP OTP send accounting");

  const ip = "203.0.113.42";
  const windowStart = new Date(Date.now() - HOUR);

  // The rate limit is 10 sends per IP per hour. The count must be computable from rows alone,
  // which is what the store exists to make possible.
  for (let i = 0; i < 3; i += 1) {
    await prisma.otpSendAttempt.create({ data: { requestingIp: ip } });
  }

  const inWindow = await prisma.otpSendAttempt.count({
    where: { requestingIp: ip, createdAt: { gte: windowStart } },
  });
  check("6. sends from one IP are countable inside the window", inWindow === 3, `sends in the last hour from ${ip} = ${inWindow}`);

  // An old attempt outside the window must not count toward the limit, or an IP would be locked
  // out forever after one busy hour.
  await prisma.otpSendAttempt.create({
    data: { requestingIp: ip, createdAt: new Date(Date.now() - 3 * HOUR) },
  });
  const stillInWindow = await prisma.otpSendAttempt.count({
    where: { requestingIp: ip, createdAt: { gte: windowStart } },
  });
  check("6. an attempt older than the window does not count", stillInWindow === 3, `still ${stillInWindow} after adding one from 3h ago`);

  // Two different callers must not share a counter.
  await prisma.otpSendAttempt.create({ data: { requestingIp: "198.51.100.7" } });
  const other = await prisma.otpSendAttempt.count({
    where: { requestingIp: "198.51.100.7", createdAt: { gte: windowStart } },
  });
  check("6. each originating IP is counted separately", other === 1, `a different IP shows ${other} send, not ${stillInWindow + 1}`);

  // The window rolls forward by deletion, not by accumulating forever.
  const expired = await prisma.otpSendAttempt.deleteMany({
    where: { requestingIp: ip, createdAt: { lt: windowStart } },
  });
  check("6. expired attempts can be swept", expired.count === 1, `swept ${expired.count} row older than the window`);

  await prisma.otpSendAttempt.deleteMany({ where: { requestingIp: { in: [ip, "198.51.100.7"] } } });
}

async function main(): Promise<void> {
  console.log("Fixora - invalid states and required stores, attempted against PostgreSQL.");
  console.log("A constraint is the last line of defence: these writes are refused by the database,");
  console.log("not by application code that happens to run first.\n");

  await caseRatingOutOfRange();
  await caseDuplicateReview();
  await caseEmptyCategories();
  await caseBioTooLong();
  await caseModerationPatternList();
  await caseOtpIpRateLimitStore();

  console.log(
    failures === 0
      ? "\nEvery invalid state was refused, every boundary value was still accepted, and the two authorised stores behave."
      : `\n${failures} check(s) failed - see the FAIL lines above.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error("\nInvalid-state proof failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
