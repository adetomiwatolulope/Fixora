-- Additive only. No table, column, enum or constraint is renamed, retyped or dropped (DB-1).
--
-- This migration exists because three requirements had no way to be satisfied by the initial
-- schema. Two of them were unimplementable rather than merely unbuilt; adding them is an explicit
-- deviation from the locked PRD section 10 base of six models, recorded in
-- docx/03-design-decisions.md section 12.
--
--   1. PR-PROVIDER-001  - the 500-character bio cap was the one field constraint from section 10
--                         that no CHECK enforced. Same raw-SQL treatment as the other four.
--   2. PR-AI-002        - the moderation keyword/pattern list must be admin-maintained and must NOT
--                         be hardcoded in application code (AGENTS rule 19). That is
--                         unimplementable with nowhere to store the entries.
--   3. PR-TECH-002a     - OTP sends must be rate-limited per originating IP. Needs a store for the
--                         counter.

-- ---------------------------------------------------------------------------
-- 1. PR-PROVIDER-001 - bio length cap
-- ---------------------------------------------------------------------------
-- NULL bio is allowed (a provider may have no bio yet); only an over-long one is refused. The cap
-- is inclusive: exactly 500 characters is valid, 501 is not.
ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "provider_profiles_bio_max_500_chars"
  CHECK ("bio" IS NULL OR char_length("bio") <= 500);

-- ---------------------------------------------------------------------------
-- 2. PR-AI-002 - admin-maintained moderation pattern list
-- ---------------------------------------------------------------------------
-- Patterns are DATA, not behaviour. This is what lets an Admin add or remove a rule through the
-- internal list without a code change or a deployment, which is the whole point of the requirement.
CREATE TYPE "ModerationPatternKind" AS ENUM ('SPAM', 'ABUSE');

CREATE TABLE "moderation_patterns" (
  "id"        TEXT                     NOT NULL,
  "kind"      "ModerationPatternKind"  NOT NULL,
  "pattern"   TEXT                     NOT NULL,
  "enabled"   BOOLEAN                  NOT NULL DEFAULT true,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3)             NOT NULL,

  CONSTRAINT "moderation_patterns_pkey" PRIMARY KEY ("id")
);

-- An Admin re-adding a pattern that is already listed is a conflict, not a second row that would
-- match twice and inflate any count of how many rules fired.
CREATE UNIQUE INDEX "moderation_patterns_kind_pattern_key"
  ON "moderation_patterns"("kind", "pattern");

-- The moderation step reads only enabled patterns, grouped by the kind of check being run.
CREATE INDEX "moderation_patterns_enabled_kind_idx"
  ON "moderation_patterns"("enabled", "kind");

-- ---------------------------------------------------------------------------
-- 3. PR-TECH-002a - per-originating-IP OTP send rate limiting
-- ---------------------------------------------------------------------------
-- Separate from otp_codes on purpose. The counter is only meaningful inside the rate-limit window,
-- whereas OTP rows persist as an audit trail; putting an IP on an OTP row would retain a caller
-- address against a phone number for far longer than the limit requires, which is an NDPR
-- liability and buys nothing. There is no foreign key because a caller issuing an OTP request is
-- not necessarily a User.
--
-- Rows are inserted per send and deleted as the window rolls forward.
CREATE TABLE "otp_send_attempts" (
  "id"           TEXT         NOT NULL,
  "requestingIp" TEXT         NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "otp_send_attempts_pkey" PRIMARY KEY ("id")
);

-- Serves both the count-inside-the-window query and the by-age cleanup, without a full scan.
CREATE INDEX "otp_send_attempts_requestingIp_createdAt_idx"
  ON "otp_send_attempts"("requestingIp", "createdAt");
