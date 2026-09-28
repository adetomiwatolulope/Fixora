# AGENTS.md — Fixora Build Agent Rules

## Question 1 — What is this project?

Fixora is a Nigerian services marketplace. Customers discover local providers (plumbing, electrical, cleaning, repairs, painting, photography), place a service order, and leave a review after a completed job. Providers manage incoming orders and build a visible rating. Admins moderate flagged reviews, resolve disputes, and — in v1 — manually assign provider subscription tiers.

- **Version being built:** v1, as defined in `Fixora_PRD_v2.md` (post-review). v1 has no job-payment processing and no automated subscription billing — see Question 2 and Question 3, rule 20.
- **Who it is for:** Customers discovering and hiring providers (persona: Chidinma), providers managing job requests (persona: Emeka — who may also place orders as a customer under the same account, PR-AUTH-005), and Admins moderating and resolving disputes.
- **Source of truth:** `Fixora_PRD_v2.md`. If this AGENTS.md and the PRD disagree on a *feature* decision, the PRD wins. If they disagree on *process/behavior* (how you work, not what you build), this file wins. Anything the PRD marks `[ASSUMPTION]` is the current working rule, not optional, until an Open Question in PRD Section 14 resolves it.
- **What this file is not:** not a feature list, not a PRD summary. Every feature you build must trace to a specific PRD requirement ID (PR-XXX-NNN). This file only governs how you behave while building those requirements.

---

## Question 2 — What is locked?

Do not change, swap, or "improve" any of these. If you think one is wrong, stop and flag it — do not silently work around it.

### Stack
- **Framework:** Next.js, App Router, TypeScript strict mode. No `any`, no `@ts-ignore` to bypass a real type error.
- **Database:** PostgreSQL, accessed only through Prisma. No raw SQL except a parameterized Prisma `$queryRaw` when a Prisma query genuinely cannot express it.
- **Proximity search:** no PostGIS extension in v1 — it is explicitly not part of the locked stack (PR-TECH-001). Proximity uses a bounding-box prefilter on indexed lat/lng columns, with the exact haversine distance and the final sort/limit computed inside the same SQL query via `$queryRaw` — never in application code after fetching rows.
- **Category filtering requires a GIN index on `ProviderProfile.categories`**, added via raw SQL in the migration (Prisma's schema DSL doesn't generate this index type). This is a build prerequisite for `PR-SEARCH-001`, not an optional tuning step — do not ship category search without it.
- **No external search service** (Elasticsearch, Algolia, etc.) in v1. Postgres only.
- **OTP delivery channel:** SMS is the v1 default (PR-TECH-002). This is explicitly an open question in the PRD (Section 14, #6) — do not swap it for WhatsApp, push, or email without an instruction that says so.

### Payment provider
- **Flutterwave is the only payment provider**, for whenever automated payment collection is built. Do not add Stripe, Paystack, or any other processor, even as a fallback or for testing convenience.
- **This is not the same gate as "no billing exists."** Fixora's v1 already has a real, live subscription feature — `ProviderProfile.subscriptionTier`, `featuredStartedAt`, `featuredEndsAt` all exist today, and an Admin manually sets them (PR-SUB-003) after an off-platform payment. Locking Flutterwave means: *when* automated collection is built, it is the only provider — it does not mean automated collection is authorized now. See Question 3, rule 20 for the phase gate.
- Job payment (what a customer pays a provider for the actual service) is a separate, larger question — Section 3 of the PRD excludes it from v1 entirely, and Open Question 7 notes it would require a full payment-processing buildout, not just a provider choice. Flutterwave being locked for subscriptions does not authorize building job-payment processing.
- There is currently no `Transaction`/`Payment` model in the schema at all. Any Flutterwave work requires a new, explicitly approved schema extension before it requires any Flutterwave SDK code.

### Architecture boundaries (already decided, not open for restructuring)
- `AdminAction` rows are append-only (PR-ADMIN-004) — see Question 3, rule 12.
- The provider rating (`ratingAverage`, `ratingCount`) is a denormalized field recomputed transactionally on review approval, not calculated from `Review` rows on every read (PR-TECH-006).
- The 72-hour stale-completion sweep (PR-TECH-008) is a scheduled job, not something triggered by a user request.

---

## Question 3 — What must never happen

Every rule below is a direct order. **Breaking any rule on this list means the task failed, even if the code runs, even if the feature appears to work in a demo.** Each rule points to its PRD requirement where one exists.

1. **Never collect or store a password.** Authentication is phone number plus OTP only (PR-AUTH-001).

2. **Never let an OTP be reused or outlive its window.** A code is single-use, expires after 5 minutes, and requesting a new one invalidates any prior unconsumed code for that phone number (PR-AUTH-002).

3. **Never skip OTP rate limits.** Max 5 verification attempts per issued code, max 3 OTP requests per phone number per hour, and — separately — max 10 OTP sends per originating IP per hour (PR-AUTH-003, PR-TECH-002a). Exceeding any of these returns 429, not a silent retry.

4. **Never return an OTP code in an API response body outside a development environment.** It is delivered only through the SMS channel (PR-TECH-002).

5. **Never create an `ADMIN` account through the public signup flow, and never build a path for a `CUSTOMER` or `PROVIDER` account to become `ADMIN`** (PR-AUTH-006).

6. **Never treat `role` as a hard capability wall, but never let a provider order from themselves.** A `CUSTOMER` may also hold a `ProviderProfile`; a `PROVIDER` may place orders as a customer — under the same account (PR-AUTH-005). But an order is rejected with 422 if the customer's `userId` matches the `userId` behind the target `ProviderProfile` — a provider can never order, complete, or review their own listing (PR-ORDER-001). These two rules exist together: the first without the second is a rating-manipulation hole.

7. **Never make a provider's listed starting price or hourly rate binding.** It is informational only (PR-PROVIDER-003). A separately recorded `agreedPriceKobo` (PR-ORDER-004a) is also informational — it creates no payment obligation the system enforces.

8. **Never return a provider's phone number to a customer who has no order with that provider** (PR-PROVIDER-004).

9. **Never move an `Order.status` outside its six defined values** (`REQUESTED`, `ACCEPTED`, `DECLINED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `DISPUTED`) — these are the only values it may hold (PR-ORDER-003).

10. **Never let anyone but the order's provider accept, decline, or propose an alternate time on a `REQUESTED` order** (PR-ORDER-004, PR-ORDER-005).

11. **Never complete a job on one-sided confirmation, except through the defined auto-completion path.** `IN_PROGRESS` → `COMPLETED` requires both the provider marking done and the customer confirming — unless 72 hours pass with no customer confirmation, in which case the scheduled sweep (PR-TECH-008) auto-completes it with `autoCompleted = true` set (PR-ORDER-007, PR-ORDER-007a). An auto-completed order must be visibly distinguished from a customer-confirmed one wherever order history is shown — never rendered identically.

12. **Never accept a cancellation without a structured `cancelReasonCode`.** Free text alone is not enough — the enum value is required so patterns (like repeated `PROVIDER_NO_SHOW`) are queryable, not buried in prose (PR-ORDER-008).

13. **Never resolve a `DISPUTED` order automatically.** Only an explicit Admin action, with a resolution note, moves it to a terminal status (PR-ORDER-009).

14. **Never move an order out of a terminal status** (`COMPLETED`, `DECLINED`, `CANCELLED`) **except the one defined Admin dispute-resolution path**, and that path only applies to orders currently `DISPUTED` (PR-ORDER-010).

15. **Never let anyone but the order's customer, the order's provider, or an Admin read that order** (PR-ORDER-011).

16. **Never accept a review that isn't tied to exactly one `COMPLETED` order, submitted by that order's customer, one review per order** (PR-REVIEW-001). This applies identically to an `autoCompleted` order — auto-completion does not block review eligibility.

17. **Never let a review affect the provider's rating or appear publicly before it reaches `APPROVED`.** A `PENDING` or `FLAGGED` review is invisible and excluded from `ratingAverage` until approved; a `REJECTED` review is never shown and never counted (PR-REVIEW-003, PR-REVIEW-005).

18. **Never let review moderation auto-reject.** The moderation step may only move a review to `PENDING`-approved or `FLAGGED` — only an Admin can set `APPROVED` or `REJECTED` on a flagged review (PR-REVIEW-005, PR-ADMIN-001).

19. **Never hardcode the moderation keyword/pattern list in application code.** It is Admin-maintained through an internal add/remove list so it can be updated without a deployment (Section 6, PR-AI-002).

20. **Never build automated Flutterwave/subscription-payment code until the owner explicitly starts that work.** Until then: no Flutterwave SDK, no keys, no checkout flow, no webhook handler, and no `Transaction`/`Payment` schema model exists in the codebase. Subscription tier changes remain a manual Admin action (PR-SUB-003) — this is a real, working v1 feature already; do not "upgrade" it to an automated flow on your own initiative.
    - Once automated collection is explicitly scoped: all Flutterwave webhook events must be signature-verified before any tier change. Amounts are stored as whole integers in the smallest currency unit — never float or decimal (same as rule 22). The client never determines a price. Processing is idempotent by transaction reference.
    - Job payment (what a customer pays a provider) is a separate, larger scope than subscription billing and stays fully out of v1 regardless of any Flutterwave work done for subscriptions (Section 3, Non-Goals).

21. **Never update or delete an `AdminAction` row.** These records are append-only. A correction is a new row referencing the same `targetId`, never an edit to the prior one (PR-ADMIN-004).

22. **Never store any amount as a float or decimal.** `startingPriceKobo`, `agreedPriceKobo`, and any future money field are whole integers in the smallest currency unit (kobo), always (PR-TECH-007).

23. **Never switch an `onDelete: Restrict` relation to `Cascade` or `SetNull` to "fix" account deletion.** Account deletion currently has no defined semantics — the schema's `Restrict` relations make it impossible today, and this is a known, flagged NDPR-relevant open question (PRD Open Question 11), not a bug for you to patch. If a task seems to require deleting a `User` with order or review history, stop and flag it; do not change the deletion behavior unilaterally.

24. **Never build anything the roadmap places in v2 or v3 early**, even if implementing v1 cleanly seems to want it: job payment processing, in-app subscription checkout, provider verification gating, company/team provider accounts, multi-city search, automated dispute resolution, provider-side review responses, or any generative-AI feature (Section 13). The ranking and moderation logic in Section 6 is deterministic scoring and rule-based flagging — never introduce an LLM or a trained model into either without an explicit instruction, regardless of the section's original PRD title.

---

## Question 4 — How is the work arranged?

```
/fixora
├── /app                          # Next.js App Router — routes + Server Components only
│   ├── /(customer)                # customer-facing routes
│   ├── /(provider)                # provider-facing routes
│   ├── /(admin)                   # internal admin console (not public-facing, PR-AUTH-006)
│   └── /api
│       └── /v1                    # route handlers — thin, call into /modules only
│           ├── /auth              # OTP request/verify
│           ├── /providers
│           ├── /orders
│           ├── /reviews
│           └── /admin
│
├── /modules                      # ALL business logic lives here, by domain
│   ├── /auth                     # OTP issuance/verification, role/capability logic (rule 6)
│   ├── /providers                # profile, categories, listing visibility
│   ├── /search                   # ranking (Section 6), proximity query composition
│   ├── /orders                   # full lifecycle: accept/decline/propose, completion, cancellation, disputes
│   ├── /reviews                  # submission, moderation state, rating recalculation
│   ├── /subscriptions            # tier state, Admin-driven changes (PR-SUB-003)
│   ├── /admin                    # AdminAction writers (append-only, rule 21), dispute resolution, moderation queue
│   └── /billing                  # DOES NOT EXIST until Flutterwave work is explicitly scoped (rule 20).
│                                  # When it does: only module allowed to import a Flutterwave client.
│
├── /jobs                         # scheduled/background work, separate from request-response code
│   └── sweep-stale-completions.ts # PR-TECH-008: the 72-hour auto-completion sweep
│
├── /lib                          # cross-cutting technical utilities only (no business rules)
│   ├── /db                       # Prisma client singleton
│   ├── /sms                      # OTP delivery (PR-TECH-002)
│   └── /auth                     # session/request-scoping helpers used by /modules
│
├── /prisma
│   └── schema.prisma              # extend, don't restructure without explicit instruction
│
├── /tests
│   ├── /unit                      # per-module business rule tests
│   └── /integration               # cross-module flows (e.g., provider marks done → 72h sweep → auto-complete → review still eligible)
│
└── AGENTS.md                      # this file
```

**Placement rule:** any `if` that decides whether something is *allowed* (role/capability, order status transition, review eligibility, moderation outcome) belongs in `/modules`, never in `/app`. Route handlers call a module function and act on its result.

**Separation rule:** `/lib` never imports from `/modules`. `/modules` never imports from `/app`. `/jobs` imports from `/modules` for shared logic (e.g., the same completion-transition function used elsewhere) but is invoked by a scheduler, never by a route handler pretending to be one. Only `/modules/billing`, once it exists, may import a Flutterwave SDK — no other module talks to Flutterwave directly.

---

## Question 5 — How should the code look?

- **TypeScript strict mode, no exceptions.** No `any`. No suppressed type errors.
- **Node.js and all dependencies on their current LTS versions** at setup time. Do not pin old versions for convenience; do not jump to a non-LTS bleeding-edge release.
- **Small, named functions over clever one-liners.** A reviewer should know what a function checks or does from its name alone.
- **Every status transition is an explicit function** (`acceptOrder()`, `declineOrder()`, `markProviderDone()`, `confirmCompletion()`, `autoCompleteStale()`, `cancelOrder()`, `raiseDispute()`, `resolveDispute()`), not an inline `.update({ status: X })` scattered across call sites — this is the one place each rule in Question 3 lives and gets tested.
- **No magic strings for enums.** Use the Prisma-generated enum types (`UserRole`, `ServiceCategory`, `OrderStatus`, `CancelReasonCode`, `ReviewModerationStatus`, `SubscriptionTier`, `AdminActionType`) everywhere. Every switch or mapping over one of these ends in a `never` exhaustiveness check, so a new value is a compile error, not a silent gap.
- **Guarded writes are conditional, not read-then-write.** The self-order check, a status transition, and the review-eligibility check all depend on current state — express the check as part of the write (`updateMany` + assert one row changed, or a transaction), never a `findUnique` followed by `update`.
- **Server-side validation on every mutation**, even where client validation exists. The server never trusts client input, especially `status`, `agreedPriceKobo`, `subscriptionTier`, `moderationStatus`, or anything the customer could set to bypass rule 6's self-order block.
- **Comments explain why, not what**, and only where a Question 3 rule is being enforced and isn't obvious from the function name.
- **No commented-out code, no TODO-and-abandon.** Unfinished work is either not merged, or is an explicit open item in your task output.

---

## Question 6 — What counts as done?

For every task, before reporting it complete, produce a checklist covering:

- [ ] The code builds with zero errors and zero TypeScript strict-mode warnings.
- [ ] Every requirement ID this task touches is listed, with a one-line note on how it's satisfied (e.g., "PR-ORDER-007a: sweep function sets autoCompleted=true and completedAt in one transaction").
- [ ] Every "must never happen" rule from Question 3 relevant to this task has been checked against the actual code, not assumed.
- [ ] Any new Prisma model/field change includes the migration, and any new query includes its matching index in the same migration — including the GIN index requirement (Question 2) if the task touches category filtering.
- [ ] Role/ownership checks are in place on every new route or module function, with a test proving cross-account or wrong-role access is denied.
- [ ] No money field uses float or decimal.
- [ ] Tests exist for the specific business rule(s) this task implements — including at least one test that tries to break the rule (a provider ordering from themselves, a review submitted twice on one order, a status transition attempted out of order), not just a happy-path smoke test.
- [ ] Nothing from a later phase (v2, v3 per Section 13) was built early, and no Flutterwave/billing code was touched unless that work was explicitly scoped in this task.
- [ ] Anything you were unsure about is listed explicitly at the end of your output (see Question 7) rather than silently resolved by guessing.

---

## Question 7 — What does the agent do when unsure?

- **Never invent a feature, field, or scope the PRD doesn't define.** If a task seems to need something undefined — a new status value, a new endpoint, a new moderation category — stop and flag it as an open item. Do not guess and ship.
- **Never build ahead of v1.** If a task seems to require a v2/v3 item (verification gating, payment processing, multi-city) to feel "complete," do not build it because you're already in there. Flag the dependency and stop at the v1 boundary.
- **Check PRD Section 14 (Open Questions) before improvising an answer.** Eleven unresolved questions are already named there — cancellation windows, dispute arbitration formality, notification channel, account deletion/NDPR, and others. If a task touches one, build against the PRD's stated working assumption (where one exists) and flag it; do not resolve the open question yourself.
- **Never fill an ambiguity with the most convenient guess and move on silently.** Where genuinely ambiguous, pick the most restrictive reading (deny by default, reject rather than guess, don't auto-approve rather than auto-approve), implement that, and say plainly what you assumed and why.
- **Never paper over uncertainty with more code.** If you don't know how a rule should behave, don't write speculative branching logic to "cover all the cases." Write the smallest correct implementation for the case you're sure about, and name the uncertain case as an open question instead of guessing at it in code. An agent unsure how to handle a stale `DISPUTED` order with no resolution should not invent an auto-resolution path — none exists in this PRD (rule 13) — it should implement the parts that are certain and flag the rest.
- **When two rules seem to conflict**, stop and surface the conflict explicitly rather than picking one silently. Point to both requirement IDs (or, for the Flutterwave case, point to Question 2's provider lock versus rule 20's phase gate).
