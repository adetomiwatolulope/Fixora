---
trigger: glob
---

# money-billing.md — Build Rules: Money, Subscriptions & Billing (Flutterwave)

Scope: every money field and amount; provider tier logic (`subscriptionTier`, `featuredStartedAt`, `featuredEndsAt`); `startingPriceKobo` and `agreedPriceKobo`; any future `/modules/billing` or Flutterwave code.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Status: split.
- MB-1 to MB-8 are LIVE. Fixora v1 already has two kobo fields and a paid tier that an Admin applies by hand after an off-platform payment (PR-SUB-003).
- MB-9 to MB-18 are GATED and inactive until the owner explicitly scopes automated collection (AGENTS rule 20).
Fixora v1 processes no payment through the platform: not for jobs, not for subscriptions.
Every rule here is a failure condition, not a preference. Cite MB-n in the Question 6 checklist when touched.

## Live rules

**MB-1 Whole kobo, converted in one place.** Every amount is a whole integer in kobo (PR-TECH-007, AGENTS rule 22). The API only carries kobo integers (`startingPriceKobo`, `agreedPriceKobo`). Any naira-to-kobo or kobo-to-naira conversion (a price form, a display) lives in one shared utility in `/lib`, using integer or string arithmetic. Never `parseFloat(x) * 100`, never an inline `amount / 100`, never a round trip through a float (`1.15 * 100` is `114.99999999999999`). `ratingAverage` is a Float and is not money; do not touch it. Add no currency field: kobo implies NGN. [ASSUMPTION: NGN is the only currency in v1.]

**MB-2 Range and sign are enforced at the API boundary.** Prisma `Int` tops out at 2,147,483,647 kobo (about ₦21.47M). Reject any amount that is non-integer, negative, zero, or above that ceiling with 422, before it reaches the database. Never let an overflow surface as a 500, and never clamp a value silently. [ASSUMPTION: zero is rejected. The PRD does not say whether a zero price is valid, so this is the most restrictive reading (AGENTS Q7).] Do not change `agreedPriceKobo` to `BigInt` or any other type: PRD Section 10 flags that as an owner decision. If a task hits the ceiling, flag it.

**MB-3 Listed and agreed prices bind nothing.** `startingPriceKobo` is informational (PR-PROVIDER-003, AGENTS rule 7). `agreedPriceKobo` creates no payment obligation (PR-ORDER-004a). No code charges, holds, escrows, totals, invoices, or enforces against either field, and no "amount due" appears in any UI. No fee or commission is computed from either. Section 8's note that price history keeps a future commission model possible describes data accumulating, not permission to build one.

**MB-4 `agreedPriceKobo` has one writer and one moment.** Only the provider on the order may set it, and only as part of the accept action, inside the same guarded `acceptOrder()` transition as the status change (PR-ORDER-004a, AGENTS Q5). Never write it through a standalone update route. It is optional and stays null if not recorded. It is visible only to the order's customer, its provider, and Admin (PR-ORDER-011), never in search results or on a public provider profile. [ASSUMPTION: once written it is not edited. The PRD defines no correction path, and a price that can change silently on an order that may become `DISPUTED` stops being a record.]

**MB-5 The customer never supplies a price.** `POST /v1/orders` accepts no price field (PR-ORDER-001). If one arrives in the body, reject with 422. Do not drop it silently and do not store it.

**MB-6 Effective tier is computed at read time, from one definition.** The stored `subscriptionTier` is not authoritative (PR-SUB-004). A provider is effectively `FEATURED` only if the stored tier is `FEATURED` and `featuredEndsAt` is in the future by the server clock (UTC). Anything else is effectively `FREE`, including `FEATURED` with a null `featuredEndsAt` (fail closed).
- Every reader uses it: the search ranking boost (PR-SUB-002, PR-AI-001), the Featured badge, the tier returned by `GET /v1/providers/:id` (PR-PROVIDER-004), and the Featured-conversion metric (Section 11).
- The PRD prose says `startedAt`/`endsAt`. The locked schema names are `featuredStartedAt`/`featuredEndsAt`.
- Ranking runs in SQL via `$queryRaw` (PR-TECH-001), so the definition exists twice: a SQL expression and a TypeScript function. Define each exactly once, and ship one test that runs the same four providers through both and asserts they agree: live `FEATURED`, expired `FEATURED`, `FEATURED` with null end, `FREE`. If the two drift, expired providers keep a boost they did not pay for. The code runs and the task has failed.

**MB-7 Tier changes are Admin-only and never without their audit row.** (PR-SUB-003, PR-ADMIN-003, PR-ADMIN-004, AGENTS rule 21.)
- Setting a tier requires role `ADMIN`, verified server-side. Anyone else gets 403 (PR-TECH-005, PR-AUTH-006).
- Setting `FEATURED` requires both `featuredStartedAt` and `featuredEndsAt`, with the end after the start (PR-SUB-004).
- The tier update and a new `AdminAction` row (`SUBSCRIPTION_CHANGE`, admin id, timestamp, target) are written in one transaction. A tier change with no row, or a row with no change, is a failed task.
- `AdminAction` is append-only. A wrong grant is corrected with a new row, never an edit.
- No other code path writes these three fields. That includes any scheduled job that "resets" expired tiers to `FREE`: PR-SUB-004 says expiry is computed at read, and a reset job would be a tier change with no admin behind it.
- [ASSUMPTION: `targetId` holds the `ProviderProfile` id, since the tier lives there. The PRD does not say. Use one convention for every `SUBSCRIPTION_CHANGE` row.]

**MB-8 Tier fields are never client-writable outside the Admin action.** `subscriptionTier`, `featuredStartedAt`, and `featuredEndsAt` are excluded from signup, profile create and update, and every provider-facing route. Pick accepted fields explicitly. Never spread a request body into a Prisma write (AGENTS Q5). A provider can never upgrade themselves.

## Gated rules (inactive until the owner scopes automated collection)

**MB-9 Phase gate. This is the load-bearing rule.** Until the owner explicitly starts that work: no Flutterwave SDK, no keys, no checkout flow, no webhook handler, and no `Transaction`/`Payment` model in the codebase (AGENTS rule 20). The manual Admin flow is a real, working v1 feature. Do not "upgrade" it to an automated flow on your own initiative. A task that seems to need any of these stops and flags it. It does not build a "minimal" version to unblock itself.
- This is two gates, not one. Scoping automated subscription collection does not scope job payment (a customer paying a provider), escrow, or commission. Those stay out of v1 regardless (PRD Section 3, AGENTS rules 20 and 24).

**MB-10 Flutterwave is the only provider, and only `/modules/billing` may import it.** No Stripe, no Paystack, not even as a fallback or for testing (AGENTS Q2). `/modules/billing` does not exist yet. Only it may ever hold a Flutterwave client (AGENTS Q4).

**MB-11 The schema extension is its own approval, and it has a known hole.** No `Transaction`/`Payment` model exists (AGENTS Q2). Clearing MB-9 does not authorize the migration.
- The extension must also solve this: `AdminAction.adminId` is required, so an automated tier change cannot be recorded as an Admin action today.
- Do not create a placeholder or "system" `ADMIN` user, do not write a dummy `adminId`, and do not make the audit row optional. PR-ADMIN-004 and PR-SUB-003 exist to say who made every tier change.
- The owner decides how automated changes are recorded before any webhook code is written.

**MB-12 Price, term, and renewal are handed to you, never inferred.** The PRD defines no price for `FEATURED`, no term length, no renewal or extension behavior (extend from now, or from the current end date?), and no cancellation behavior. Section 8 leaves how providers pay undecided. Do not pick numbers or terms. The client sends a tier identifier only. The server owns the amount and currency (AGENTS rule 20).

**MB-13 Webhook order of operations. Do not reorder.**
1. Read the raw body as text before parsing anything.
2. Verify the signature using Flutterwave's documented mechanism for the API version in use, with a constant-time comparison. On failure, return 4xx and write nothing.
3. Confirm the transaction server-to-server through Flutterwave's verification endpoint. Do not trust the webhook body alone.
4. Match amount, currency, and transaction reference against a pending record the server itself created. On any mismatch, change nothing and log by reference for review.
5. Only then change the tier, through MB-15.
A client redirect or query parameter never changes a tier. Only a verified server-to-server event does.

**MB-14 Idempotent by transaction reference, durably.** A duplicate or replayed event has no second effect. Use a durable table of processed references with a unique constraint (part of the MB-11 extension). In-memory or per-instance deduplication is forbidden.

**MB-15 One tier-change function.** The automated path calls the same module function as the Admin path (MB-7). Never write a second implementation of "set `FEATURED` and its dates". Two writers is how MB-6 breaks.

**MB-16 One conversion at the Flutterwave boundary.** Flutterwave expresses amounts in major-unit decimals. Convert only through the MB-1 utility, with integer or string arithmetic. Never float equality on an amount.

**MB-17 Failure changes nothing.** A failed, abandoned, or pending payment leaves the tier unchanged. Refunds, chargebacks, proration, invoices, receipts, and tax are not in the PRD and are not built without an instruction naming them.

**MB-18 Secrets, modes, logs.** Flutterwave keys and the webhook secret are server-only environment variables. Test keys never run in production, and live keys never run in dev or CI. Never log secrets or a raw webhook payload. Log events by transaction reference and status only.

## Known gaps: flag them, do not resolve them

1. The `FEATURED` price, term length, and renewal behavior are defined nowhere (Section 8, Open Question 7).
2. Off-platform payment evidence is not modeled. The only trace of a bank transfer behind a `FEATURED` grant is the optional `AdminAction.note`. Do not add a payment table to fix this. Flag it.
3. The PRD does not say who records `agreedPriceKobo` when the customer accepts a provider's proposed date (PR-ORDER-005), since the customer triggers that transition. Leave it null and flag it.
4. `agreedPriceKobo` may outgrow `Int` (PRD Section 10 range note).
5. `AdminAction.targetId` does not say whether it holds a `User` or `ProviderProfile` id (see MB-7).
6. Whether a zero price is valid is undefined (see MB-2).