# api-route-scaffolder

## Trigger

Use this skill for any new or edited route, endpoint, API handler, or server action.

## Purpose

Keep Fixora API handlers thin and enforce the repository's authorization and validation sequence consistently.

## Opening ritual

Every route begins in this exact order:

1. Session
2. Input
3. Ownership
4. Limits

Do not reorder these checks casually.

### 1. Session

Establish the authenticated session before performing protected work.

Never collect or store passwords.

Respect the OTP rules:

- OTP is single-use.
- OTP expires after 5 minutes.
- A new OTP request invalidates the previous one.
- Maximum 5 verification attempts per code.
- Maximum 3 OTP requests per phone per hour.
- Maximum 10 sends per IP per hour.
- Rate-limit violations return `429`.
- Never expose OTP values through production APIs.

### 2. Input

Validate request input on the server.

Do not trust client-provided authorization-sensitive fields, prices, roles, or state.

Use the repository's typed validation conventions.

### 3. Ownership

Ownership and relationship authorization belongs in the module/business-logic layer, not the `app/api/v1` handler.

Use `403` for an authenticated caller who lacks access to the requested resource.

Orders are readable only by their customer, provider, or Admin.

Provider phone numbers must not be returned to customers without an order relationship.

Providers may act as customers, but a provider must never order from themselves. Self-order attempts return `422`.

### 4. Limits

Apply the relevant product and abuse limits before performing the operation.

Preserve the documented OTP, role, ownership, and state-transition limits.

## Thin handler rule

Routes live under:

`app/api/v1`

The route handler should:

- authenticate;
- parse/validate input;
- call the appropriate module function;
- map the module result to the REST/JSON response.

Do not place business authorization rules directly in the route.

Business logic belongs in `/modules`.

Cross-cutting infrastructure belongs in `/lib`.

Background processing belongs in `/jobs`.

## Status transitions

Do not perform arbitrary status writes.

Use explicit transition functions that enforce the allowed order states:

- `REQUESTED`
- `ACCEPTED`
- `DECLINED`
- `IN_PROGRESS`
- `COMPLETED`
- `CANCELLED`
- `DISPUTED`

Only the provider can accept, decline, or propose on `REQUESTED`.

Terminal states cannot be freely moved to another state.

Cancellation requires a structured `cancelReasonCode`.

Dispute resolution requires explicit Admin action and a resolution note.

Completion requires two-sided confirmation or the scheduled 72-hour auto-completion path.

## R31 blocked-message pattern

When a request is blocked by the product's R31 rule, use the repository's exact R31 blocked-message pattern rather than inventing a new message or status.

The precise R31 wording is not present in the supplied `AGENTS.md` or PRD, so this skill deliberately does not fabricate it.

## Handler shape

Prefer this conceptual sequence:

1. Session
2. Input validation
3. Module invocation
4. Response mapping

The module owns:

- authorization;
- ownership;
- business rules;
- guarded writes;
- state transitions.

## Completion checklist

- [ ] Correct `app/api/v1` location.
- [ ] Session check first.
- [ ] Server-side input validation.
- [ ] Ownership/authorization handled by the module.
- [ ] Limits enforced.
- [ ] Handler remains thin.
- [ ] No business authorization duplicated in the route.
- [ ] Correct HTTP status for authorization/state violations.
- [ ] OTP rules preserved where applicable.
- [ ] Self-order protection preserved.
- [ ] Order visibility preserved.
- [ ] Provider phone privacy preserved.
- [ ] R31 blocked-message pattern preserved where applicable.
- [ ] Relevant tests added/updated.