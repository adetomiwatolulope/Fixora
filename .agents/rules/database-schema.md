---
trigger: always_on
---

# database-schema.md — Build Rules: Data Model & Migrations

Scope: prisma/schema.prisma, migrations, seeds, and every Prisma query.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition. Cite DB-n in the Question 6 checklist when touched.

## Rules

**DB-1 The PRD §10 schema is the base; changes are additive.** No rename, removal, or type change of any model, enum, or field, even one that looks unused (`autoCompleted`, `providerMarkedDoneAt`, `featuredEndsAt`, `agreedPriceKobo` exist to enforce PRD rules). A destructive change needs an explicit instruction that names it.

**DB-2 Enums are closed.** A new value in `OrderStatus`, `ReviewModerationStatus`, `SubscriptionTier`, `CancelReasonCode`, `UserRole`, `ServiceCategory`, or `AdminActionType` is a new business state. Stop and ask (AGENTS Q7).

**DB-3 Migration discipline.** Every schema change ships as a committed Prisma migration. Never run `prisma db push` or `migrate reset` outside a disposable local database. Never edit a migration that has been applied or merged; fix forward with a new one. Generate with `--create-only`, read the SQL, and stop on any `DROP` or lossy `ALTER`.

**DB-4 An index ships with its query.** For every new query pattern, the same migration adds the matching index or the report names the existing one that serves it:
- Category filter: a GIN index on `provider_profiles.categories`, added by hand in the migration SQL because Prisma cannot generate it. Required before category search ships (PR-SEARCH-001).
- Proximity: the PRD requires "indexed latitude/longitude columns" (PR-TECH-001), but §10 defines none. The index ships with the search query.
- The 72-hour sweep uses `[status, providerMarkedDone, providerMarkedDoneAt]`.
- Order lists use `[customerId, status]` and `[providerId, status]`. Rating recalculation and the moderation queue use `[providerId, moderationStatus]` and `[moderationStatus]`.

**DB-5 Money is a whole integer in kobo.** `startingPriceKobo`, `agreedPriceKobo`, and any future amount are `Int`, never `Float` or `Decimal` (AGENTS Q3 rule 22). Coordinates and `ratingAverage` are `Float` and are not money. `Int` tops out near ₦21.4M in kobo; widening to `BigInt` is a type change that needs an instruction.

**DB-6 Decided records are immutable.**
- `AdminAction` rows are never updated or deleted. A correction is a new row (PR-ADMIN-004).
- An order in `COMPLETED`, `DECLINED`, or `CANCELLED` is never changed except through the admin dispute-resolution path (PR-ORDER-010).
- `disputeResolutionNote` and `disputeResolvedAt` are never edited once set.
- A review's `rating` and `comment` are never edited or deleted after creation. The PRD defines no edit or delete path, so do not build one.

**DB-7 No cascading deletes.** Every relation stays `onDelete: Restrict`. Never switch one to `Cascade` or `SetNull`, even to "fix" account deletion, which has no defined meaning yet (PRD Open Question 11, AGENTS rule 23). If a task seems to require deleting a User with history, stop and flag it.

**DB-8 Derived fields have exactly one writer.**
- `ratingAverage` and `ratingCount` are written only by one recalculation function, recomputed from the actual APPROVED reviews, never incremented blindly, in the same transaction as the review's status change (PR-TECH-006).
- `autoCompleted` is true only when the scheduled sweep completed the order.
- `providerMarkedDone` and `providerMarkedDoneAt` are written only by the mark-done function.

**DB-9 One provider identity mapping.** `Order.providerId` points at `User.id`. `Review.providerId` points at `ProviderProfile.id`. Never mix them, and never convert one silently. Keep a single lookup function that maps between them, in `/modules/providers`, and flag the mismatch as an open item for the owner to settle.

**DB-10 Unenforced references are validated in the module.** `cancelledBy`, `disputeRaisedBy`, and `AdminAction.targetId` are plain strings; the database will not catch a bad value. Validate them in the module before writing.

**DB-11 Unique constraints stay.** Never drop or loosen `User.phone`, `ProviderProfile.userId`, or `Review.orderId` uniqueness. They enforce one account per phone, one profile per user, and one review per order.

**DB-12 Raw SQL.** `$queryRaw` tagged templates only, with parameters. Never `$queryRawUnsafe` or `$executeRawUnsafe`; never string-built SQL.

**DB-13 Seeds and scripts respect the gates.** No seed or script outside `/tests` creates an `ADMIN` user, or a COMPLETED order or APPROVED review that skipped its rules. How admin accounts get created is undefined in the PRD (PR-AUTH-006); do not invent a path. Seeds use synthetic data only.

**DB-14 Billing schema is gated.** Adding a payment or transaction model, or a price for the FEATURED tier, needs its own approval on top of DB-1 (AGENTS rule 20).