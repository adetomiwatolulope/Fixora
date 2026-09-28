-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'PROVIDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('PLUMBING', 'ELECTRICAL', 'CLEANING', 'REPAIRS', 'PAINTING', 'PHOTOGRAPHY', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "CancelReasonCode" AS ENUM ('CUSTOMER_CHANGED_MIND', 'PROVIDER_UNAVAILABLE', 'PROVIDER_NO_SHOW', 'SCHEDULING_CONFLICT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'FLAGGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'FEATURED');

-- CreateEnum
CREATE TYPE "AdminActionType" AS ENUM ('REVIEW_MODERATION', 'DISPUTE_RESOLUTION', 'SUBSCRIPTION_CHANGE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categories" "ServiceCategory"[],
    "bio" TEXT,
    "startingPriceKobo" INTEGER NOT NULL,
    "ratingAverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'FREE',
    "featuredStartedAt" TIMESTAMP(3),
    "featuredEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "jobAddress" TEXT NOT NULL,
    "jobLatitude" DOUBLE PRECISION,
    "jobLongitude" DOUBLE PRECISION,
    "preferredDate" TIMESTAMP(3) NOT NULL,
    "proposedDate" TIMESTAMP(3),
    "status" "OrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "declineReason" TEXT,
    "agreedPriceKobo" INTEGER,
    "providerMarkedDone" BOOLEAN NOT NULL DEFAULT false,
    "providerMarkedDoneAt" TIMESTAMP(3),
    "autoCompleted" BOOLEAN NOT NULL DEFAULT false,
    "cancelledBy" TEXT,
    "cancelReasonCode" "CancelReasonCode",
    "cancelReason" TEXT,
    "disputeRaisedBy" TEXT,
    "disputeReason" TEXT,
    "disputeResolutionNote" TEXT,
    "disputeResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING',
    "aiFlagReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_actions" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "actionType" "AdminActionType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_role_city_idx" ON "users"("role", "city");

-- CreateIndex
CREATE INDEX "users_city_latitude_longitude_idx" ON "users"("city", "latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "provider_profiles_userId_key" ON "provider_profiles"("userId");

-- CreateIndex
CREATE INDEX "provider_profiles_subscriptionTier_idx" ON "provider_profiles"("subscriptionTier");

-- CreateIndex
CREATE INDEX "otp_codes_phone_consumedAt_idx" ON "otp_codes"("phone", "consumedAt");

-- CreateIndex
CREATE INDEX "orders_customerId_status_idx" ON "orders"("customerId", "status");

-- CreateIndex
CREATE INDEX "orders_providerId_status_idx" ON "orders"("providerId", "status");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_status_providerMarkedDone_providerMarkedDoneAt_idx" ON "orders"("status", "providerMarkedDone", "providerMarkedDoneAt");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_orderId_key" ON "reviews"("orderId");

-- CreateIndex
CREATE INDEX "reviews_providerId_moderationStatus_idx" ON "reviews"("providerId", "moderationStatus");

-- CreateIndex
CREATE INDEX "reviews_moderationStatus_idx" ON "reviews"("moderationStatus");

-- CreateIndex
CREATE INDEX "admin_actions_targetId_idx" ON "admin_actions"("targetId");

-- CreateIndex
CREATE INDEX "admin_actions_actionType_idx" ON "admin_actions"("actionType");

-- AddForeignKey
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "provider_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Raw SQL additions. Prisma's schema DSL cannot express CHECK constraints or
-- GIN indexes, so these are added here. Each block names the requirement it
-- serves and the design-decision section that justifies it.
-- See 03-design-decisions.md sections 6.1 and 8.1.
-- ============================================================================

-- C13 / PR-SEARCH-001 / AGENTS Q2 / DB-4
-- The GIN index is a build prerequisite for category search, not optional
-- tuning: ProviderProfile.categories is a Postgres array instead of a join
-- table (03-design-decisions.md section 1.2), and without this index the
-- category filter degrades to a sequential scan over the whole provider set.
CREATE INDEX "provider_profiles_categories_gin_idx"
    ON "provider_profiles" USING GIN ("categories");

-- C4 / PR-TECH-006 / D1
-- Guards the denormalised rating cache. A denormalised field whose failure
-- mode is "silently wrong" deserves at least a range fence. This does NOT
-- verify the cache against its source rows -- no constraint can do that --
-- it only keeps the value inside a plausible range. The single-writer rule
-- in D1 is what keeps it correct.
ALTER TABLE "provider_profiles"
    ADD CONSTRAINT "provider_profiles_rating_bounds"
    CHECK ("ratingAverage" >= 0 AND "ratingAverage" <= 5 AND "ratingCount" >= 0);

-- C5 / PR-REVIEW-002
-- A rating outside 1-5 is unrepresentable, not merely rejected by a validator.
ALTER TABLE "reviews"
    ADD CONSTRAINT "reviews_rating_between_1_and_5"
    CHECK ("rating" >= 1 AND "rating" <= 5);

-- C6 / PR-PROVIDER-002 / PR-SEARCH-001
-- A provider cannot be listed in zero categories. Without this, a profile
-- row with an empty array is invisible to every category-filtered search
-- while still existing as a "listed" provider.
ALTER TABLE "provider_profiles"
    ADD CONSTRAINT "provider_profiles_categories_at_least_one"
    CHECK (cardinality("categories") >= 1);

-- C7 / PR-SUB-004 / MB-6 / D3
-- The stored enum is overridden at read time: a provider is effectively
-- FEATURED only if the stored tier is FEATURED AND featuredEndsAt is in the
-- future. A FEATURED row with a null featuredEndsAt therefore fails closed
-- and reads as FREE. This CHECK makes that "fails closed" behaviour a
-- stored invariant rather than only a read-time convention.
ALTER TABLE "provider_profiles"
    ADD CONSTRAINT "provider_profiles_featured_window_valid"
    CHECK ("subscriptionTier" <> 'FEATURED' OR "featuredEndsAt" IS NOT NULL);

-- ============================================================================
-- Deliberately NOT added. Recorded so the omission is a decision on the
-- record rather than an oversight. See 03-design-decisions.md section 6.2.
--
--   CHECK (agreedPriceKobo > 0)
--       MB-2 puts the rule at the API boundary, and "is a zero price valid?"
--       is an explicitly unresolved question (MB known-gap 6). A CHECK here
--       would silently answer it, which AGENTS Q7 forbids.
--
--   CHECK (status IN ('REQUESTED', ...))
--       Redundant. OrderStatus is a Postgres enum; the type is the constraint.
--
--   CHECK (completedAt IS NOT NULL) WHERE status = 'COMPLETED'
--       A state-machine invariant owned by confirmCompletion() and
--       autoCompleteStale(). Expressing it as a CHECK is a DB-1 change.
--
--   CHECK (declineReason IS NOT NULL) WHERE status = 'DECLINED'
--       Same reasoning: the transition function owns the invariant.
--
--   CHECK (ratingCount <= (SELECT COUNT(*) FROM reviews ...))
--       Not expressible. CHECK cannot contain a subquery.
--
--   Any append-only enforcement on admin_actions
--       Postgres has no append-only table primitive. AdminAction being
--       append-only is currently a promise made by the absence of any code
--       path that would UPDATE or DELETE it (03-design-decisions.md 6.4).
--       Flagged as OQ-9, not solved.
-- ============================================================================
