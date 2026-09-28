---
trigger: always_on
---

# coding-standard.md — Build Rules: Code

Scope: all TypeScript in /app, /modules, /jobs, /lib, /tests.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition, not a preference. When a task touches a rule, cite its ID (CS-n) in the Question 6 checklist.

## Rules

**CS-1 Types are never bypassed.** No `any`, no `@ts-ignore`/`@ts-expect-error` to silence a real error, and no `as` assertion on request bodies, SMS-provider responses, or AI-provider responses. External data is parsed into a type; an assertion is not validation.

**CS-2 Enums are exhaustive.** Every switch or mapping over `UserRole`, `ServiceCategory`, `OrderStatus`, `CancelReasonCode`, `ReviewModerationStatus`, `SubscriptionTier`, or `AdminActionType` ends in a `never` check, so a new value is a compile error. No string literal stands in for an enum value.

**CS-3 One writer per status field.** Each transition of `Order.status`, `Review.moderationStatus`, and `ProviderProfile.subscriptionTier` is written by exactly one named function in `/modules`. That function checks the actor, checks the current state is a legal from-state, writes, and updates linked fields in the same operation. Only transitions the PRD defines exist. Where two requirements conflict (PR-ORDER-009 lets a COMPLETED order be disputed; PR-ORDER-010 says COMPLETED is terminal), implement the certain case and flag the conflict (AGENTS Q7).

**CS-4 Guarded writes are conditional, not read-then-write.** When correctness depends on current state, the state check is part of the write: `updateMany` with the state in `where` and an assertion that exactly one row changed. A `findUnique` followed by `update` is a race and fails review. A unique-constraint violation (Prisma P2002: a second review on one order, a second signup on one phone) is a normal rejection, never a 500.

**CS-5 Linked consequences are atomic.** If a rule says B happens when A happens, both share one `prisma.$transaction`:
- A review entering or leaving APPROVED and the provider's `ratingAverage`/`ratingCount` recalculation (PR-REVIEW-004, PR-TECH-006).
- Any admin decision and its `AdminAction` row (PR-ADMIN-004).
- Marking a job done and `providerMarkedDoneAt`; completion and `completedAt`/`autoCompleted`.
No follow-up job fixes these up later.

**CS-6 Identity and authority come from the server.** `customerId`, `cancelledBy`, `disputeRaisedBy`, admin ids, every status, and every timestamp come from the session or module logic. Never from a request body, query string, or hidden field.

**CS-7 The server clock decides time.** The 72-hour auto-completion, the 5-minute OTP window, the one-hour rate-limit windows, subscription expiry, and every stored timestamp use the server clock in UTC. A client timestamp never decides anything.

**CS-8 The effective subscription tier has one function.** The stored `subscriptionTier` is not the tier in force: a FEATURED tier past `featuredEndsAt` counts as FREE (PR-SUB-004). One function computes the effective tier, and ranking, badges, and every read go through it. No other code reads `subscriptionTier` directly.

**CS-9 Capability, not role.** `User.role` is a default, not a wall (PR-AUTH-005). Provider actions require a `ProviderProfile`; ordering requires an authenticated non-admin; admin actions require `role = ADMIN`. All capability logic lives in one helper in `/modules/auth`. A `role ===` comparison anywhere else is a defect.

**CS-10 Distance is computed in SQL.** The bounding-box prefilter, the haversine distance, and the final sort and limit run in one parameterized `$queryRaw` query (PR-TECH-001). Never fetch candidate rows and compute distance or sort in application code.

**CS-11 Errors are not swallowed.** No empty `catch`, and no `catch` that returns a default from a guarded function. Permission failure is a typed error that becomes 403. Validation failure is 4xx with field errors. Unexpected failure is a generic 500; details go to the server log only.

**CS-12 Handlers are thin.** Code in `/app` and `/jobs` parses input, calls one module function, and maps the result. Any allow-or-deny, retry, or threshold `if` in `/app` or `/jobs` is a defect and moves to `/modules`.

**CS-13 Every mutation validates on the server,** even when the UI already validated.

**CS-14 Scheduled work is a job, not a route.** The 72-hour sweep lives in `/jobs`, calls a module function, is invoked by a scheduler, and is idempotent: a second run changes nothing (PR-TECH-008).

**CS-15 Dependencies are decisions.** Do not add, replace, or major-upgrade a package as a side effect of a task. Only `/modules/billing` (once it exists) may import a Flutterwave client. Only the adapters in `/modules/ai` (once approved, see ai-pipeline.md) may import an AI-provider SDK. No PostGIS extension and no external search service in v1 (AGENTS Q2).

**CS-16 Guards are proven by failing tests.** For every guard a task adds or touches, at least one test attempts the forbidden action and asserts the rejection (a provider ordering from themselves, a second review on one order, a customer confirming someone else's order, an OTP used twice). A suite of happy-path tests alone means the task is not done.