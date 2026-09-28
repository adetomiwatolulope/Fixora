# Fixora

Fixora is a Nigerian services marketplace that connects customers with local service providers. Customers can discover, request, and review providers for everyday services, while providers can manage incoming job requests and build their reputation. Admins handle moderation and disputes.

## What it is

Fixora helps customers find trusted providers for common services like plumbing, electrical work, cleaning, repairs, painting, and photography. Providers receive job requests, accept/decline them or propose alternate times, track work in progress, and build a visible rating from customer reviews. All order activity is recorded to create an accountable job history for both parties.

Key characteristics (v1):
- **Phone-based auth** — signup/login uses a phone number plus OTP (no passwords stored).
- **One account, flexible roles** — a single user can be both a customer and a provider under the same account (role doesn't block capability), but providers cannot order from themselves.
- **Order lifecycle** — REQUESTED → ACCEPTED/DECLINED → IN_PROGRESS → COMPLETED (with two-sided confirmation; auto-completes after 72 hours if customer doesn't confirm).
- **Reviews tied to completed jobs** — customers leave exactly one review per completed order; reviews go through moderation before affecting provider ratings.
- **Provider subscriptions (manual in v1)** — providers have FREE or FEATURED tiers; Admins manually assign tier changes (no automated billing for subscriptions/jobs in v1).
- **Proximity search (Postgres-only)** — provider discovery uses bounding-box prefiltering on lat/lng with distance computed in SQL; no PostGIS required.

## Core Features

- **Provider discovery**: Search by category, city, proximity, and rating with deterministic ranking (FEATURED gets a boost).
- **Orders**: Request jobs with description, preferred timing, and address; providers can accept/decline or propose alternate times.
- **Completion tracking**: Jobs require both provider marking done and customer confirming completion; stale jobs auto-complete after 72 hours.
- **Cancellations & disputes**: Structured cancellation reasons; disputes go to Admin for manual resolution (no auto-resolution).
- **Moderation**: Review comments are checked against maintainable keyword/pattern lists; flagged reviews require Admin approval/rejection.
- **Ratings**: Provider ratings are denormalized (`ratingAverage`, `ratingCount`) and recomputed transactionally when reviews are approved.

## Tech Stack

- **Framework**: Next.js (App Router) + TypeScript (strict mode)
- **Database**: PostgreSQL 16+ with Prisma ORM
- **Auth**: OTP verification (6-digit, 5-minute expiry, rate-limited)
- **Architecture**: Business logic lives in `/modules`, thin API handlers in `/app/api/v1`, scheduled work in `/jobs`, shared utilities in `/lib`
- **Money**: All amounts stored as integers in smallest currency unit (kobo) — no floats

## Getting Started

### Prerequisites
- Node.js >= 24 (see `package.json`)
- PostgreSQL 16 running locally
- `psql` available if you want to reproduce evidence/screenshots

### Setup

1. Clone the repo and install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your DB credentials and secrets
```

3. Generate Prisma client and run migrations:
```bash
npm run prisma:generate
npm run db:migrate  # or db:deploy in production
```

4. Seed the database (development):
```bash
npm run db:seed
```

## Scripts

| Script | What it does |
|---|---|
| `prisma:generate` | Generate Prisma Client |
| `db:migrate` | Run dev migrations |
| `db:deploy` | Deploy migrations (production) |
| `db:seed` | Seed database (requires `FIXORA_ALLOW_SEED_RESET=1` in dev) |
| `typecheck` | TypeScript type checking |
| `proof` | Runs full schema proof: seed + fixtures + 5 queries + query plans + constraint checks |
| `proof:*` | Individual proof steps (fixtures, queries, plans, constraints) |

## Documentation & Source of Truth

- **PRD (v2)**: `docx/Fixora_PRD_v2.md` — authoritative product requirements. If PRD and AGENTS.md disagree on features, PRD wins; on process/behavior, AGENTS.md wins.
- **Agent Rules**: `AGENTS.md` — build rules, constraints, and guardrails (must not break any "must never happen" rule).
- **Data Model**: `docx/02-data-model.md`, `prisma/schema.prisma`
- **API Design**: `docx/04-api-design.md`
- **Evidence/Proof**: `evidence/README.md` — ERD, order state machine, query plans (with index usage), and constraint violation screenshots; all captured from a live Postgres instance.

## Database Notes

- Migrations live under `prisma/migrations/`. Schema uses enums for OrderStatus, ReviewModerationStatus, SubscriptionTier, ServiceCategory, CancelReasonCode, AdminActionType, UserRole.
- Category filtering uses a GIN index on `ProviderProfile.categories` (created via raw SQL in migrations) — required for efficient category search.
- Money fields are integer `kobo` values (e.g., `startingPriceKobo`, `agreedPriceKobo`).
- Admin actions are append-only (never updated/deleted).

## Security & Privacy

- No passwords collected or stored. OTP codes are single-use, time-limited, rate-limited (per-phone and per-IP), and never returned in API responses outside dev.
- Authorization is resource-scoped (customer/provider on order, review owner, or Admin); denials return 403.
- Secrets go in `.env` (never committed). See `.env.example`.

## Contributing

When making changes, follow `AGENTS.md` rules: understand conventions, avoid guessing ambiguous requirements (flag open questions), write small testable functions with explicit state transitions, run typecheck/lint if available, and only commit when explicitly requested.

---

*This README summarizes Fixora based on the PRD and codebase. For detailed requirements and constraints, see the documents above.*