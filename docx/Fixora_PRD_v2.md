# Fixora — Product Requirements Document (v2)

*This is a revision of v1. Every change below was made in response to a live cross-functional review (Skeptic / Author / Engineer / Product Lead / Judge). Where a v1 requirement was reworded, cut, or extended, that is noted inline.*

## 1. Product Summary

Fixora is a Nigerian services marketplace, built on Next.js, TypeScript, Prisma, and PostgreSQL, that connects customers with local service providers across plumbing, electrical work, cleaning, repairs, painting, and photography. Customers search providers by category, city, proximity, and rating, place a service order describing the job and preferred timing, and the provider accepts, declines, or proposes an alternate time. Once a job is marked complete, the customer can leave a one-time review tied to that order.

Fixora does not process payment for the job itself in v1; customers and providers settle payment directly. **Fixora's intended v1 revenue mechanism is provider subscription tiers, collected manually off-platform and applied by an Admin action (PR-SUB-003) — there is no automated payment collection in v1.** *(Reworded — the v1 draft stated "revenue comes from subscription tiers" as if this were a functioning automated system; it is a manual process pending a payment-provider decision, Section 8.)*

## 2. Problem Statement

Finding a service provider in a Nigerian city today mostly happens through word of mouth, informal WhatsApp groups, or roadside signage. This creates three recurring problems:

- **No reliable discovery.** A customer has no single place to compare providers by category, location, and reputation before committing to hire one.
- **No accountability trail.** When a job goes badly, there is no record of what was agreed, who accepted the job, or what happened, so disputes are he-said-she-said.
- **No reputation signal.** A provider's track record (how many jobs completed, how they were rated) is invisible to a new customer, so trust has to be rebuilt from zero every time.

Fixora gives customers a structured way to discover and request providers, gives providers a place to build a visible reputation, and gives both sides a recorded order history to refer back to — **including, as of this revision, an optional agreed-price record (PR-ORDER-004a), since "what was agreed" without a price was an incomplete record of the thing most likely to be disputed.**

## 3. Goals and Non-Goals

### Goals (v1)
- Let a customer find providers in their city, filtered by category and sorted by proximity and rating, and place an order in one flow.
- Let a provider manage their incoming orders (accept, decline, propose an alternate time) from a single place.
- Record every order's full lifecycle (requested, accepted, in progress, completed, cancelled, or disputed) so both sides and Fixora's admin have a shared record.
- Let a customer leave exactly one review per completed order, and show providers an aggregate rating.
- Generate subscription revenue from providers who want better search placement.

### Non-Goals (v1)
- Fixora does not process payment for the service itself. No escrow, no in-app payment for the job, no commission on job value.
- No company/team provider accounts — a provider account is one individual in v1.
- No formal dispute arbitration workflow — disputes are flagged in the system and handled by an admin manually, outside any automated resolution logic.
- No AI-driven chat, dynamic pricing, or automated dispute resolution.
- No multi-city expansion tooling — v1 launches in a single city.
- **No provider verification gate exists in v1. This is accepted as a launch risk, not a deferred detail — see Section 9. At minimum, a provider's phone number (PR-AUTH-001) is the only identity check performed before a provider can be listed and dispatched to a customer's address.** *(Extended — the v1 draft treated this as a footnote; the review found it needed to be stated as a named launch risk with an explicit floor, without resolving the underlying open question, which stays the owner's decision — Section 14.)*

## 4. User Personas

**Chidinma, Customer (primary persona).** Needs a plumber this week and doesn't have one she trusts. She wants to see who's nearby, what they charge to start, and what other customers thought of them, then request a job without a phone call.

**Emeka, Provider (primary persona).** An independent electrician who wants more customers than word of mouth brings him. He wants a simple way to see new job requests, accept the ones that fit his schedule, and build a rating that helps him get chosen over unknown competitors. **As of this revision, Emeka can also place orders as a customer under the same account — see PR-AUTH-005 — but cannot order from his own listed services (PR-ORDER-001).**

**Admin (secondary persona).** A Fixora staff member who reviews AI-flagged reviews before they publish, and steps in manually when a customer or provider raises a dispute on an order. Not a public-facing persona; operates through an internal admin view. The review noted this role carries the heaviest operational load in the system (subscription approvals, dispute resolution, moderation) — no persona rewrite was made, but this load is why Section 9's mitigation for manual subscription handling was reworded rather than left as a bare "accepted."

## 5. Functional Requirements

### PR-AUTH — Authentication
- **PR-AUTH-001.** Signup and login use a phone number plus OTP. No password is ever collected or stored.
- **PR-AUTH-002.** An OTP is a 6-digit code, valid for 5 minutes, single-use. Requesting a new OTP for the same phone number invalidates any prior unconsumed code for that number.
- **PR-AUTH-003.** OTP verification is rate-limited: a maximum of 5 verification attempts per issued code, and a maximum of 3 OTP requests per phone number per hour. Exceeding either returns 429.
- **PR-AUTH-004.** A verified phone number that has never signed up is prompted to choose a role (Customer or Provider) and complete a minimal profile (name; city and state; for a Provider, at least one service category) before the account is usable.
- **PR-AUTH-005 *(rewritten)*.** `User.role` records the account's primary/default role at signup (`CUSTOMER`, `PROVIDER`, or `ADMIN`) and determines the default UI experience. It does not, by itself, restrict capability:
  - A `CUSTOMER` account may additionally create a `ProviderProfile` to offer services under the same phone number. This does not change `role`, but grants provider capabilities (listing, receiving orders).
  - A `PROVIDER` account may place orders as a customer without restriction — placing an order (PR-ORDER-001) only requires being an authenticated user, not `role = CUSTOMER`.
  - `role = ADMIN` is the one exception: an `ADMIN` account has no customer- or provider-facing capability layered on top of it in v1.
  *(Reworded — the v1 draft required a second phone-number account to hold both capabilities. The review found this was an arbitrary rule, not a schema limitation, since `ProviderProfile` was already a separate table with its own foreign key.)*
- **PR-AUTH-006.** `ADMIN` accounts are never created through the public signup flow. There is no API or UI path for a `CUSTOMER` or `PROVIDER` account to become `ADMIN`.

### PR-PROVIDER — Provider Profile and Listing
- **PR-PROVIDER-001.** A provider profile has: one or more service categories (from the fixed `ServiceCategory` enum), a bio (max 500 characters), a starting price or hourly rate (integer, minor units — kobo), city, state, latitude, longitude.
- **PR-PROVIDER-002.** A provider must select at least one category before their profile is visible in search results.
- **PR-PROVIDER-003.** A provider's listed starting price or hourly rate is informational only. It is never treated as a binding price for any order — the actual price is agreed between customer and provider outside any price field this system enforces for payment purposes (an agreed price may still be recorded informationally — see PR-ORDER-004a).
- **PR-PROVIDER-004.** `GET /v1/providers/:id` returns the provider's profile, aggregate rating, review count, and subscription tier (to render a "Featured" badge if applicable). It does not return the provider's phone number to a customer who has no order with that provider.
- **PR-PROVIDER-005.** A provider's aggregate rating (`ratingAverage`, `ratingCount`) is recalculated whenever a review is approved (PR-REVIEW-004) — never on review submission, since a review may still be pending moderation.

### PR-SEARCH — Discovery
- **PR-SEARCH-001.** `GET /v1/providers` supports filtering by `category`, `city`, and a minimum rating, and sorts by a combination of proximity (given the customer's lat/lng) and rating (see Section 6 for the exact ranking logic). **Category filtering requires the GIN index on `ProviderProfile.categories` described in Section 10 — this is a build prerequisite, not an optional optimization.**
- **PR-SEARCH-002.** Search results include only providers with at least one category set (PR-PROVIDER-002). There is no other visibility gate in v1 (no verification requirement — see Open Questions).
- **PR-SEARCH-003.** Search results are scoped to a single city in v1; there is no cross-city search (Section 14).

### PR-ORDER — Orders and Job Lifecycle
- **PR-ORDER-001 *(extended)*.** A customer creates an order via `POST /v1/orders` with: `providerId`, `category` (must be one of the provider's listed categories), `description` (max 1000 characters), `preferredDate` (a date/time), and a job address (text plus optional lat/lng). No binding price field is accepted from the customer at creation. **The request is rejected with 422 if the requesting customer's `userId` matches the `userId` behind the target `ProviderProfile` — a provider cannot place, complete, or review an order against themselves.** *(This check exists specifically because PR-AUTH-005's rewrite now permits one account to hold both a customer identity and a `ProviderProfile`; without it, a provider could self-review to inflate their own rating.)*
- **PR-ORDER-002.** A created order starts in status `REQUESTED`.
- **PR-ORDER-003.** Valid order statuses are: `REQUESTED`, `ACCEPTED`, `DECLINED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `DISPUTED`. These are the only values `Order.status` may hold.
- **PR-ORDER-004.** Only the provider on the order may transition `REQUESTED` → `ACCEPTED` or `REQUESTED` → `DECLINED`. Declining requires a reason (free text, max 300 characters).
- **PR-ORDER-004a *(new)*.** At acceptance, the provider may optionally record an agreed price (`agreedPriceKobo`, integer, kobo). This field is informational and creates no payment obligation Fixora enforces, but is visible to both parties and to an Admin resolving a dispute on this order. It also means real pricing data accumulates from v1 onward — see Section 8 for why this matters beyond dispute resolution.
- **PR-ORDER-005.** A provider may propose an alternate date/time instead of a flat accept/decline. This is recorded as a `proposedDate` on the order with status remaining `REQUESTED`; the customer then accepts the proposed date (moving the order to `ACCEPTED` with `preferredDate` updated to the proposed value) or declines it (moving the order to `DECLINED`).
- **PR-ORDER-006.** `ACCEPTED` → `IN_PROGRESS` is set by the provider when the job begins. [ASSUMPTION — only starting the job, not finishing it, is provider-only.]
- **PR-ORDER-007.** `IN_PROGRESS` → `COMPLETED` requires both the provider marking their side done and the customer confirming completion. The order enters an intermediate `providerMarkedDone = true` sub-state until the customer confirms; only then does `status` become `COMPLETED`. [ASSUMPTION — resolves the "who marks a job completed" question with two-sided confirmation, the most defensible default for a marketplace where reviews and reputation depend on the record being accurate.]
- **PR-ORDER-007a *(new)*.** If a provider marks an order done and the customer does not confirm within 72 hours, the order auto-transitions to `COMPLETED` with a boolean flag `autoCompleted = true` recorded on the order. An auto-completed order is still eligible for a customer review (PR-REVIEW-001 is unaffected), but is visually distinguished from a customer-confirmed completion wherever order history is shown. **This requires a scheduled job to sweep for stale `providerMarkedDone` orders — see PR-TECH-008.** *(New — the v1 draft named this exact stall condition as a known risk without a resolution path; the review found it also silently contaminated the completed-job-rate metric, Section 11.)*
- **PR-ORDER-008 *(extended)*.** `ACCEPTED` or `IN_PROGRESS` orders may transition to `CANCELLED` by either the customer or the provider. A cancellation requires both a `cancelReasonCode` (enum: `CUSTOMER_CHANGED_MIND`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NO_SHOW`, `SCHEDULING_CONFLICT`, `OTHER`) and an optional free-text `cancelReason` for detail. *(Extended — the v1 draft used free text only, which meant a pattern like repeated provider no-shows was invisible without full-text search across unrelated orders. The structured code makes this queryable.)* [OPEN QUESTION carried forward — no cancellation window or penalty is defined; any cancellation is allowed at any point before `COMPLETED` in v1.]
- **PR-ORDER-009.** Either party may raise a dispute on an order in `IN_PROGRESS` or `COMPLETED` status, moving it to `DISPUTED`. Raising a dispute requires a reason (free text, max 1000 characters) and records which party raised it. `DISPUTED` is resolved only by an Admin action that sets a resolution note and moves the order to a terminal status (`COMPLETED` or `CANCELLED`); there is no automated resolution.
- **PR-ORDER-010.** `COMPLETED`, `DECLINED`, and `CANCELLED` are terminal. No code path transitions an order out of a terminal status except the Admin dispute-resolution path in PR-ORDER-009, which only applies to `DISPUTED` orders.
- **PR-ORDER-011.** `GET /v1/orders/:id` is visible only to the customer on the order, the provider on the order, or an Admin.

### PR-REVIEW — Reviews and Ratings
- **PR-REVIEW-001.** A review may only be created for an order in `COMPLETED` status (including an `autoCompleted` order — PR-ORDER-007a does not affect review eligibility), only by the customer on that order, and only once per order (`Order.id` is unique on `Review`).
- **PR-REVIEW-002.** A review has a `rating` (integer, 1 to 5) and an optional `comment` (max 500 characters).
- **PR-REVIEW-003.** A submitted review starts in moderation status `PENDING`. It is not visible on the provider's profile and does not affect `ratingAverage` until it reaches `APPROVED` (see Section 6 for how it gets there).
- **PR-REVIEW-004.** When a review's moderation status becomes `APPROVED`, the provider's `ratingAverage` and `ratingCount` are recalculated in the same transaction as the status change.
- **PR-REVIEW-005.** A review that is flagged by the moderation step (Section 6) enters status `FLAGGED` and requires an Admin to manually set it to `APPROVED` or `REJECTED`. A `REJECTED` review is never shown and never affects the rating.

### PR-SUB — Provider Subscriptions
- **PR-SUB-001.** Every provider has exactly one active subscription tier: `FREE` or `FEATURED`. `FREE` is the default on profile creation.
- **PR-SUB-002.** A `FEATURED` provider receives a ranking boost in search results (Section 6) and a visible "Featured" badge on their profile and in search results.
- **PR-SUB-003.** Tier changes in v1 are set by an Admin action only — there is no in-app payment flow to upgrade a tier (Section 8, Open Questions). An Admin action records who made the change and when.
- **PR-SUB-004.** A `FEATURED` tier has a `startedAt` and an `endsAt`. When `endsAt` passes, the provider's tier is treated as `FREE` for ranking purposes even if the `SubscriptionTier` field has not been explicitly reset — the effective tier is computed at read time from `endsAt`, not assumed from the stored enum value alone.

### PR-ADMIN — Moderation and Dispute Handling
- **PR-ADMIN-001.** An Admin can view all `FLAGGED` reviews and set each to `APPROVED` or `REJECTED`.
- **PR-ADMIN-002.** An Admin can view all `DISPUTED` orders and resolve each with a resolution note and a final status (`COMPLETED` or `CANCELLED`).
- **PR-ADMIN-003.** An Admin can change a provider's subscription tier (PR-SUB-003).
- **PR-ADMIN-004 *(reworded)*.** Every Admin action (review moderation decision, dispute resolution, subscription tier change) is recorded with the admin's user ID and a timestamp. **`AdminAction` rows are append-only — no code path updates or deletes an existing `AdminAction` record. A correction is a new `AdminAction` row referencing the same `targetId`, never an edit to the prior one.** *(Reworded — the v1 draft explicitly allowed these records to be non-immutable. The review found this was exactly backwards: dispute resolutions and subscription-tier changes are the records that most need to be tamper-evident.)*

## 6. Ranking and Moderation Logic

*(Section renamed from "AI Processing Pipeline" — the review found the original title implied machine-learning infrastructure that isn't part of this design, and could mislead whoever builds it next into over-engineering this. The requirement IDs `PR-AI-001` and `PR-AI-002` are kept unchanged, since they're referenced elsewhere in this document.)*

Despite the earlier section name, provider ranking (PR-AI-001) is deterministic scoring, not machine learning. Only review moderation (PR-AI-002) may optionally use a hosted moderation API, and even that is explicitly allowed to be a rules-based filter instead. Neither use case involves an LLM, a trained model, or generative AI of any kind in v1. There is no chat, no dynamic pricing, and no automated dispute resolution.

**Provider ranking (PR-AI-001).** When a customer searches (PR-SEARCH-001), a ranking step scores each matching provider using three inputs already in the data model: proximity (distance between customer and provider lat/lng), `ratingAverage`, and subscription tier (`FEATURED` providers get a fixed ranking boost applied after the proximity/rating score, per PR-SUB-002). This ranking is a deterministic scoring function — a SQL `ORDER BY` expression, effectively — not a machine-learning model or an LLM call. A provider with zero reviews is not excluded; they rank using proximity alone with a neutral rating placeholder, so new providers aren't permanently buried.

**Review moderation (PR-AI-002 *(extended)*).** Every submitted review's `comment` text is passed through a moderation check before it can reach `APPROVED` status. The check flags text matching patterns for spam (repeated characters, URLs, phone numbers embedded in review text) or abusive language (a maintained keyword/pattern list). **The keyword/pattern list is maintained by an Admin through a simple internal list (add/remove entries), not hardcoded in application code, so it can be updated without a deployment.** *(Extended — the v1 draft said the list was "maintained" with no stated mechanism or owner; an unowned, hardcoded list would go stale silently.)* A review with no `comment` (rating only) skips text moderation and can be auto-approved immediately, since PR-REVIEW-001 already restricts who can submit a review and against what. A review whose comment is flagged moves to `FLAGGED`, not `REJECTED` — the moderation step never rejects a review outright; only an Admin can (PR-ADMIN-001, PR-REVIEW-005). [ASSUMPTION — the exact moderation mechanism, whether a rules-based filter or a hosted moderation API, is left open; either satisfies this requirement as long as the step only flags and never auto-publishes or auto-rejects.]

## 7. Technical Requirements

- **PR-TECH-001 *(reworded)*.** PostgreSQL has no PostGIS extension assumed in v1 (not part of the locked stack). Proximity filtering uses a bounding-box prefilter applied as a `WHERE` clause on indexed `latitude`/`longitude` columns. **The exact haversine distance and the final sort/limit are computed in the same SQL query via `$queryRaw`, not in application code after fetching rows** — this keeps pagination correct and avoids pulling the full candidate set into memory. *(Reworded — the v1 draft said "in the query or in application code" as if the two were interchangeable; the review found they scale differently, and left the choice unmade meant two compliant implementations could behave very differently.)* [ASSUMPTION — this is adequate at v1's expected single-city scale; a dedicated geospatial extension is a candidate if search latency becomes a problem.]
- **PR-TECH-002.** OTP codes are delivered over SMS. [OPEN QUESTION carried forward — the exact channel (SMS vs. WhatsApp) and provider are not decided; this requirement assumes SMS as the v1 default because it requires no recipient opt-in, unlike WhatsApp Business API.] The OTP code itself is never returned in the API response body in any non-development environment — it is only ever delivered through the SMS channel.
- **PR-TECH-002a *(new)*.** OTP-send requests are rate-limited by originating IP address in addition to the per-phone-number limit in PR-AUTH-003 (default: a maximum of 10 OTP sends per IP per hour), to prevent bulk enumeration or harassment sends against arbitrary phone numbers that may not even be Fixora users. *(New — the v1 draft only rate-limited per phone number, leaving no defense against an attacker cycling through many numbers, which is a direct SMS-cost and harassment exposure.)*
- **PR-TECH-003.** Order-lifecycle events (new request, accepted, declined, alternate time proposed, marked done, auto-completed, completed, disputed) trigger a notification to the affected party. [OPEN QUESTION carried forward — the channel (SMS, WhatsApp, push, email) is undecided.] Notification content is generated from a versioned template with variable substitution, not a hand-built string per call site, regardless of which channel is eventually chosen.
- **PR-TECH-004.** REST, JSON request/response bodies, versioned under `/v1/`. Every mutating endpoint validates on the server regardless of client-side validation.
- **PR-TECH-005.** Every request that reads or mutates an order, review, or provider profile is scoped to the requesting user's role and relationship to that resource (the customer or provider on the order; the review's own customer; any Admin for admin-only actions). A wrong-role or wrong-owner request returns 403, never a filtered or empty result standing in for a denial.
- **PR-TECH-006.** `ratingAverage` is stored as a computed, denormalized field on the provider profile (not calculated from `Review` rows on every read), recalculated transactionally whenever a review's status changes to or from `APPROVED` (PR-REVIEW-004).
- **PR-TECH-007.** Any amount in the system (a provider's starting price/hourly rate, or the new agreed price on an order) is stored as a whole integer in the smallest currency unit (kobo). No amount is ever stored as a float or decimal.
- **PR-TECH-008 *(new)*.** A scheduled job runs at a defined interval (default: hourly) to find orders where `providerMarkedDone = true`, `status = IN_PROGRESS`, and `providerMarkedDoneAt` is more than 72 hours in the past, and auto-completes each one per PR-ORDER-007a. [ASSUMPTION — the exact scheduling mechanism (a cron-triggered route, a queue-based worker, or a platform-level scheduled function) is left open; any of these satisfies the requirement as long as the sweep runs reliably at the defined interval.]

## 8. Business Model

Fixora's v1 revenue mechanism is provider subscriptions: a free `FREE` tier (listed, searchable, no ranking boost) and a paid `FEATURED` tier (ranking boost in search, a visible badge). No commission is taken on job value, because Fixora does not process job payment in v1 (Section 3, Non-Goals).

[OPEN QUESTION carried forward] How a provider actually pays for `FEATURED` is not decided — no payment provider is chosen for v1, so PR-SUB-003 assumes tier upgrades happen through an Admin action following an off-platform payment (for example, a bank transfer an Admin manually confirms), not an in-app checkout. If an online payment provider is introduced later, it could support either the subscription model as-is or a shift toward commission on job value — but a commission model would require Fixora to process job payment, which is explicitly out of scope for v1.

**The optional `agreedPriceKobo` field on Order (PR-ORDER-004a, added in this revision) also means real pricing data accumulates from v1 onward, even though it isn't used for billing — this keeps a future pivot to commission-based pricing possible without a historical data gap.** *(New — the review found that excluding price from the order record entirely, as the v1 draft did, would have made a future commission pivot structurally harder by leaving no pricing history to build on.)*

## 9. Risks

| Risk | Category | Mitigation |
|---|---|---|
| No provider verification gate means anyone can list, including bad actors, in a category where providers enter customers' homes | Business | Flagged as an open question (Section 14) requiring an owner decision before wide launch; a provider's phone number (PR-AUTH-001) is the only identity check performed in the interim (Section 3) |
| **A stuck `IN_PROGRESS` order (one party goes silent after the other marks it done) no longer stalls indefinitely** *(resolved)* | Technical | **Resolved by PR-ORDER-007a: auto-completion after 72 hours, distinguished from a customer-confirmed completion** |
| No online payment for the job itself means Fixora has no visibility into whether a job's real-world outcome matches its recorded status | Business | Accepted for v1; reviews, disputes, and the new optional `agreedPriceKobo` field (PR-ORDER-004a) are the only signals until payment processing is considered |
| Haversine-in-application-code proximity search does not scale well past a moderate number of providers per city | Technical | **Resolved by the PR-TECH-001 rewrite: distance and sort/limit now committed to run in SQL via `$queryRaw`, not application code** |
| Rules-based review moderation misses genuinely abusive text that doesn't match known patterns, or over-flags legitimate reviews | Technical | Admin review of the `FLAGGED` queue (PR-ADMIN-001) is the backstop; the moderation step never auto-rejects, so a false positive only delays a review, it doesn't destroy it |
| Subscription tier changes being a manual Admin action does not scale past a small number of providers | Operational | **Accepted for v1. No specific provider-count threshold is defined for when this breaks — this is itself a gap; flag manual subscription handling for reassessment once provider count or Admin workload becomes a visible bottleneck, rather than waiting for a predefined number this PRD does not have grounds to set.** *(Reworded — the v1 draft said "accepted" with no mitigation behind it; this version is honest about the absence of a threshold instead of implying one exists.)* |
| A provider proposing unlimited alternate dates (PR-ORDER-005) with no cap could stall an order in `REQUESTED` indefinitely | Technical | Not capped in v1; carried forward as an open question (Section 14) a future revision should close with either a proposal limit or an expiry |
| **A provider's repeated no-shows were invisible as a pattern, buried in free-text cancellation reasons on separate orders** *(resolved)* | Operational | **Resolved by the PR-ORDER-008 `cancelReasonCode` enum, including a `PROVIDER_NO_SHOW` value, making this queryable** |
| **OTP sends had no defense against bulk enumeration or harassment against arbitrary phone numbers** *(resolved)* | Technical | **Resolved by PR-TECH-002a: IP-based rate limiting on OTP sends, in addition to the existing per-phone-number limit** |

## 10. Prisma Data Model

### Model Summary

| Model | Purpose |
|---|---|
| `User` | A single account: Customer, Provider, or Admin by default role. May hold a `ProviderProfile` regardless of default role (PR-AUTH-005). |
| `ProviderProfile` | Extra fields specific to offering services: categories, pricing, subscription, rating. |
| `OtpCode` | A short-lived one-time code issued for phone verification. |
| `Order` | One service request and its full lifecycle, including the new agreed-price, structured cancellation reason, and auto-completion fields. |
| `Review` | One review, tied to exactly one completed order. |
| `AdminAction` | An append-only record of an Admin's moderation, dispute-resolution, or subscription-tier decision. |

*Changes from v1: added `Order.agreedPriceKobo`, `Order.cancelReasonCode`, `Order.autoCompleted`, `Order.providerMarkedDoneAt`; added the `CancelReasonCode` enum; added a required GIN index on `ProviderProfile.categories`.*

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  CUSTOMER
  PROVIDER
  ADMIN
}

enum ServiceCategory {
  PLUMBING
  ELECTRICAL
  CLEANING
  REPAIRS
  PAINTING
  PHOTOGRAPHY
  OTHER
}

enum OrderStatus {
  REQUESTED
  ACCEPTED
  DECLINED
  IN_PROGRESS
  COMPLETED
  CANCELLED
  DISPUTED
}

enum CancelReasonCode {
  CUSTOMER_CHANGED_MIND
  PROVIDER_UNAVAILABLE
  PROVIDER_NO_SHOW
  SCHEDULING_CONFLICT
  OTHER
}

enum ReviewModerationStatus {
  PENDING
  APPROVED
  FLAGGED
  REJECTED
}

enum SubscriptionTier {
  FREE
  FEATURED
}

enum AdminActionType {
  REVIEW_MODERATION
  DISPUTE_RESOLUTION
  SUBSCRIPTION_CHANGE
}

model User {
  id          String    @id @default(cuid())
  phone       String    @unique
  role        UserRole
  name        String
  city        String
  state       String
  latitude    Float
  longitude   Float
  createdAt   DateTime  @default(now())

  providerProfile ProviderProfile?

  ordersAsCustomer Order[] @relation("CustomerOrders")
  ordersAsProvider Order[] @relation("ProviderOrders")
  reviewsWritten   Review[] @relation("CustomerReviews")
  adminActions     AdminAction[] @relation("AdminActor")

  @@index([role, city])
  @@map("users")
}

model ProviderProfile {
  id                String            @id @default(cuid())
  user              User              @relation(fields: [userId], references: [id], onDelete: Restrict)
  userId            String            @unique
  categories        ServiceCategory[]
  bio               String?
  startingPriceKobo Int
  ratingAverage     Float             @default(0)
  ratingCount       Int               @default(0)
  subscriptionTier  SubscriptionTier  @default(FREE)
  featuredStartedAt DateTime?
  featuredEndsAt    DateTime?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  reviewsReceived Review[] @relation("ProviderReviews")

  @@index([subscriptionTier])
  @@map("provider_profiles")
}

// NOTE: categories requires a GIN index, added via raw SQL in the migration
// (Prisma's schema DSL does not generate this index type directly):
//   CREATE INDEX provider_profiles_categories_gin_idx
//     ON provider_profiles USING GIN (categories);
// This is a build prerequisite for PR-SEARCH-001, not an optional optimization.

model OtpCode {
  id          String    @id @default(cuid())
  phone       String
  codeHash    String
  expiresAt   DateTime
  consumedAt  DateTime?
  attempts    Int       @default(0)
  createdAt   DateTime  @default(now())

  @@index([phone, consumedAt])
  @@map("otp_codes")
}

model Order {
  id                     String            @id @default(cuid())
  customer               User              @relation("CustomerOrders", fields: [customerId], references: [id], onDelete: Restrict)
  customerId             String
  provider               User              @relation("ProviderOrders", fields: [providerId], references: [id], onDelete: Restrict)
  providerId             String
  category               ServiceCategory
  description            String
  jobAddress             String
  jobLatitude            Float?
  jobLongitude           Float?
  preferredDate          DateTime
  proposedDate           DateTime?
  status                 OrderStatus       @default(REQUESTED)
  declineReason          String?
  agreedPriceKobo        Int?              // set at acceptance (PR-ORDER-004a); informational, not billed
  providerMarkedDone     Boolean           @default(false)
  providerMarkedDoneAt   DateTime?
  autoCompleted          Boolean           @default(false) // true if PR-ORDER-007a's 72h sweep completed this order
  cancelledBy            String?
  cancelReasonCode       CancelReasonCode?
  cancelReason           String?
  disputeRaisedBy        String?
  disputeReason          String?
  disputeResolutionNote  String?
  disputeResolvedAt      DateTime?
  createdAt              DateTime          @default(now())
  updatedAt              DateTime          @updatedAt
  completedAt            DateTime?

  review Review?

  @@index([customerId, status])
  @@index([providerId, status])
  @@index([status])
  @@index([status, providerMarkedDone, providerMarkedDoneAt]) // supports the PR-TECH-008 sweep
  @@map("orders")
}

model Review {
  id                String                  @id @default(cuid())
  order             Order                   @relation(fields: [orderId], references: [id], onDelete: Restrict)
  orderId           String                  @unique
  customer          User                    @relation("CustomerReviews", fields: [customerId], references: [id], onDelete: Restrict)
  customerId        String
  provider          ProviderProfile         @relation("ProviderReviews", fields: [providerId], references: [id], onDelete: Restrict)
  providerId        String
  rating            Int
  comment           String?
  moderationStatus  ReviewModerationStatus  @default(PENDING)
  aiFlagReason      String?
  createdAt         DateTime                @default(now())

  @@index([providerId, moderationStatus])
  @@index([moderationStatus])
  @@map("reviews")
}

model AdminAction {
  id          String           @id @default(cuid())
  admin       User             @relation("AdminActor", fields: [adminId], references: [id], onDelete: Restrict)
  adminId     String
  actionType  AdminActionType
  targetId    String
  note        String?
  createdAt   DateTime         @default(now())

  @@index([targetId])
  @@index([actionType])
  @@map("admin_actions")
}
```

**Money field range note:** `startingPriceKobo` and `agreedPriceKobo` both use `Int` (max ≈ ₦21.4M in kobo). `startingPriceKobo` is comfortably within range since it's a starting/hourly figure. `agreedPriceKobo` is less certain — a full job total (a large renovation-adjacent repair, a multi-day photography contract) is more likely to approach real-world extremes than a starting rate is, though still probably well under this ceiling. If Fixora's category mix later includes jobs realistically priced above it, this field requires a type change before that becomes a silent overflow risk.

## 11. Success Metrics

| Metric | Definition | Target |
|---|---|---|
| Completed-job rate | Orders reaching `COMPLETED` ÷ orders reaching `ACCEPTED` | ≥ 70% |
| **Provider acceptance rate** *(new)* | Orders reaching `ACCEPTED` ÷ total orders `REQUESTED` | ≥ 60% |
| Average provider rating | Mean of `ratingAverage` across providers with ≥ 3 approved reviews | ≥ 4.0 / 5.0 |
| Provider time-to-first-response | Median time from `REQUESTED` to the provider's first accept/decline/propose action | ≤ 2 hours |
| Repeat customer rate | Customers with ≥ 2 `COMPLETED` orders ÷ customers with ≥ 1 `COMPLETED` order, rolling 90 days | ≥ 20% |
| Review submission rate | Reviews submitted ÷ orders reaching `COMPLETED` | ≥ 50% |
| Featured conversion | Providers on `FEATURED` tier ÷ total active providers | ≥ 10% (v1 revenue signal) |

**Completed-job rate and provider acceptance rate must be read together** — a high completed-job rate with a low acceptance rate means providers are cherry-picking easy jobs, not that the product is working well for customers. *(The review found that completed-job rate alone can hit its target while the actual customer experience is bad: a provider who declines 80% of requests and completes 100% of the rest shows a perfect completed-job rate while serving customers badly.)*

**Review submission rate note:** this target may need to be tracked separately for `autoCompleted` vs. customer-confirmed orders once real data exists, since an auto-completed order (PR-ORDER-007a) likely has a structurally lower review rate — a customer who never actively confirmed completion seems less likely to then write a review. The 50% target above is a blended starting point, not a per-path target.

[ASSUMPTION: all numeric targets above are starting points for v1 and should be revisited against real usage once launched.]

## 12. Assumptions

*Regenerated to reflect every correction applied in this revision.*

- A user's `role` is a default/primary role, not a hard capability limit — a `CUSTOMER` may also hold a `ProviderProfile`, and a `PROVIDER` may place orders as a customer, under the same phone-number account (PR-AUTH-005).
- Job completion requires two-sided confirmation (provider marks done, customer confirms), with a 72-hour auto-completion fallback if the customer never confirms (PR-ORDER-007, PR-ORDER-007a). This resolves an open question with the most defensible default and should be confirmed by the owner.
- Provider ranking is a deterministic scoring function over proximity, rating, and subscription tier — not a machine-learning model or LLM call (Section 6).
- Review moderation only ever flags or auto-approves; it never auto-rejects a review. The exact mechanism (rules-based filter vs. hosted moderation API) is unspecified; the flagging keyword/pattern list is Admin-maintained, not hardcoded (Section 6).
- Proximity search commits to computing the haversine distance and final sort/limit in SQL via `$queryRaw`, with a bounding-box prefilter on indexed lat/lng columns, since PostGIS isn't part of the locked stack (PR-TECH-001).
- OTP delivery uses SMS as the default channel, rate-limited both per phone number (PR-AUTH-003) and per originating IP (PR-TECH-002a), pending the open question on notification channel more broadly.
- Provider subscription tier upgrades happen through a manual Admin action following an off-platform payment, since no online payment provider is chosen for v1 (PR-SUB-003, Section 8). No provider-count threshold is defined for when this manual process breaks.
- The auto-completion sweep (PR-TECH-008) runs on an unspecified scheduling mechanism (cron route, queue worker, or platform scheduled function) — any of these satisfies the requirement.
- `AdminAction` records are append-only by design; a correction is always a new row, never an edit (PR-ADMIN-004).
- All numeric success-metric targets in Section 11 are placeholders pending real usage data.

## 13. Phased Roadmap

**v1 (this PRD)**
- Phone/OTP auth (with IP-based rate limiting), provider profiles and search (with GIN-indexed category filtering), the full order lifecycle including two-sided completion with 72-hour auto-completion, structured cancellation reasons, one-review-per-order with Admin-maintained moderation, manually-managed provider subscription tiers, and append-only admin action records.
- Explicitly out of scope: job payment processing, in-app subscription checkout, provider verification gating, company/team provider accounts, multi-city search, automated dispute resolution, any generative-AI feature.

**v2 (candidate)**
- Provider verification (ID and/or trade certification) as a gate before listing, once Section 14's open question is resolved.
- Online payment integration — for provider subscriptions, for job payment, or both, once a provider is chosen; this could shift the business model from subscription toward commission (aided by the pricing history `agreedPriceKobo` already accumulates from v1 — Section 8).
- Multi-city expansion.
- A cap or expiry on repeated alternate-date proposals (PR-ORDER-005), closing the gap flagged in Section 9's Risks.

*(Removed: "Automatic timeout handling for stalled `IN_PROGRESS` orders" — this is now a v1 requirement, PR-ORDER-007a, not a v2 candidate. The review flagged the v1 draft's roadmap as directly contradicting its own risk table once this fix was made.)*

**v3 (candidate)**
- A formal, semi-automated dispute/arbitration workflow beyond manual Admin resolution.
- Provider-side review responses.
- Company/team provider accounts.

## 14. Open Questions

| # | Question | Tradeoff |
|---|---|---|
| 1 | Does a provider need to be verified (ID, business registration, trade certification) before they can list, or can anyone list immediately? | Verification builds trust and reduces safety risk in home-entry categories, but adds onboarding friction and requires a verification process to build and staff. No verification is faster to launch but leaves customers with no safety signal beyond reviews. **v1 ships with no gate — Section 3 now states this plainly as an accepted launch risk, not a deferred detail.** |
| 2 | Can either side cancel an order after acceptance? Is there a cancellation window or penalty? | A free cancellation policy is simple and provider-friendly but allows late no-shows with no consequence. A penalty or window protects the other party's time but adds complexity and a fairness question about who enforces it. **v1 at least now records *why* a cancellation happened via a structured code (PR-ORDER-008), including a specific `PROVIDER_NO_SHOW` value, even though no window or penalty exists yet.** |
| 3 | Is there a formal dispute/arbitration flow, or does an admin intervene manually through support on a case-by-case basis? | Manual handling (this PRD's v1 assumption) is fast to build but doesn't scale past a small number of orders. A formal flow scales better but is real scope to design and build. |
| 4 | Can a provider publicly respond to a review, or formally dispute one? | A response feature gives providers a voice against unfair reviews but adds moderation surface (a response can itself be abusive) and UI scope. |
| 5 | Is there any provider safety vetting beyond basic verification (background checks, insurance), given providers enter customers' homes? | Deeper vetting meaningfully reduces risk but is expensive, slow, and may not be available or affordable to check reliably in the target market at launch. |
| 6 | What notification channel is used for order updates: SMS, WhatsApp, push, or email? | SMS is simple and needs no opt-in but costs per message and has weaker formatting. WhatsApp is popular locally but requires Business API approval and recipient opt-in. Push requires an installed app. Email is cheapest but likely has poor open rates for this user base. |
| 7 | If online payment is added later (for job payment or for provider subscriptions), which payment provider is used, and does that change the v1 business model away from subscriptions toward commission? | A payment provider decision unlocks both a smoother subscription flow and a possible commission model. The optional `agreedPriceKobo` field added in this revision means at least the pricing data for a future commission pivot won't be missing. |
| 8 | Does the platform expand to multiple cities in v1, or is single-city launch a hard v1 boundary with expansion as a v2 decision? | Single-city (this PRD's assumption) lets the team validate the model with less operational surface. Multi-city from day one reaches more users but multiplies operational and support load before the model is proven. |
| 9 | PR-ORDER-005 allows unlimited alternate-date proposals with no cap or expiry — is this acceptable for v1, or does it need a limit? | No limit is simplest to build but can leave an order stuck in `REQUESTED` indefinitely. A cap (e.g., 3 proposals) or an expiry adds a small amount of logic but prevents an unbounded back-and-forth. |
| 10 | Should a customer who never leaves a review still see their order marked `COMPLETED` and counted toward provider trust signals, or should an unreviewed completion carry less weight than a reviewed one? | Treating all completions equally (this PRD's assumption) is simpler, but a provider with many completions and few reviews may look more or less trustworthy than they actually are, depending on which way the gap is read. This is now sharper post-PR-ORDER-007a: an `autoCompleted` order was never actively confirmed by the customer at all. |
| 11 *(new)* | What does account deletion mean for a User with order or review history — hard delete (currently impossible under the locked `onDelete: Restrict` relations, Section 10), anonymization in place, or explicitly unsupported in v1? | This has NDPR (Nigeria Data Protection Regulation) implications for a Nigeria-market consumer product and needs an explicit answer, not a schema default that happened to make deletion impossible. |
