---
trigger: always_on
---

# security.md — Build Rules: Application Security

Scope: authentication, authorization, input/output handling, secrets, logging, headers, and third-party data.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition. Cite SEC-n in the Question 6 checklist when touched.
Related: ai-pipeline.md (AI providers).

## Rules

**SEC-1 OTP generation and storage.** Generate codes with a cryptographically secure random source, never `Math.random`. Store only a keyed hash (HMAC with a server-side secret) in `codeHash`, never the code. A plain hash of a 6-digit code is trivially reversible if the table leaks. Compare in constant time. Never log a code (AGENTS rules 2 and 4, PR-TECH-002).

**SEC-2 OTP consumption is atomic.** Consuming a code is one conditional write: not yet consumed, not expired, and under the attempt limit. Increment the attempt count before comparing, so parallel guesses cannot exceed 5 (PR-AUTH-002, PR-AUTH-003, CS-4).

**SEC-3 Sessions.** The PRD does not say how a session persists after OTP login. Do not invent a mechanism silently. If a task needs one, flag it and propose the most restrictive option: a server-side session, `HttpOnly`, `Secure`, `SameSite=Lax` or stricter cookie, with the session identifier regenerated at login. The role and capabilities are read from server-side data, never from anything the client can edit.

**SEC-4 Authorization is capability plus ownership** (PR-TECH-005, PR-AUTH-005). After the capability check (see coding-standard.md CS-9), every resource fetched by id also passes an ownership check. A wrong role or wrong owner is a 403, never a filtered result. Test the wrong-owner case, not only the wrong-role case.

**SEC-5 No self-promotion.** Public signup creates only `CUSTOMER` or `PROVIDER` accounts. No path creates an `ADMIN` or lets an account change to one (AGENTS rule 5, PR-AUTH-006). A customer may add their own `ProviderProfile`, only for their own account.

**SEC-6 Mass assignment is closed.** Never pass or spread a request body into a Prisma create or update. Pick each accepted field explicitly. Never client-writable: `role`, any status, `moderationStatus`, `subscriptionTier`, `featuredStartedAt`, `featuredEndsAt`, `ratingAverage`, `ratingCount`, `providerMarkedDone`, `providerMarkedDoneAt`, `autoCompleted`, `cancelledBy`, `disputeRaisedBy`, `customerId`, `codeHash`, and any price except the provider's optional `agreedPriceKobo` at acceptance.

**SEC-7 Output is allowlisted.** Responses use explicit `select` or DTOs. Never return `codeHash`, an OTP code, or another user's data. A provider's phone number goes only to a customer who has an order with them (AGENTS rule 8). The PRD does not say whether a provider sees the customer's phone; default to leaving it out and flag it. Provider location in search results is a distance, not raw coordinates [ASSUMPTION: a provider's coordinates may be their home].

**SEC-8 Injection and input bounds.** No string-built SQL (see database-schema.md DB-12). Client-supplied latitude, longitude, and radius feed a raw query: validate them as numbers within valid ranges, and cap the radius so a request cannot force a full scan. The PRD gives no cap; propose one and flag it. User-written text is never rendered as HTML (design-system-rule.md DS-14).

**SEC-9 Server-only boundary.** Modules and `/lib` code that touch the database, SMS, AI providers, or secrets import `server-only`, so a client import fails the build. Secrets never use a `NEXT_PUBLIC_` name and never appear in client components.

**SEC-10 CSRF and GET.** No state change on GET. Mutating routes that use cookie auth verify the request Origin (Server Actions do this by default; route handlers do not).

**SEC-11 Abuse limits.** Enforce the PRD's OTP limits exactly: 3 requests per phone per hour, 5 attempts per code, and 10 sends per IP per hour (PR-AUTH-003, PR-TECH-002a). The IP comes from the platform's configured trusted-proxy handling, never from a client-settable header taken at face value. The schema has nowhere to store an IP, so stop and flag that; never ship a per-instance in-memory counter. The PRD sets no limit on order requests or reviews; flag the gap and do not invent numbers.

**SEC-12 Phone numbers and addresses are personal data.** Never put them in URLs or query strings. Never log a full phone number (mask it) or a job address. Log ids, not contents. Clients receive generic error bodies, with no stack traces and no Prisma error text.

**SEC-13 Audit integrity.** `AdminAction` rows take the actor from the session, are written in the decision's transaction, and are never updated or deleted (AGENTS rule 21).

**SEC-14 Transport and headers.** HTTPS only outside local dev, with HSTS. Send `X-Content-Type-Options: nosniff`. Deny framing (`frame-ancestors 'none'`).

**SEC-15 Third parties receive only what the PRD gives them.** The SMS provider receives a phone number and a code. The AI moderation provider, if ever approved, receives only a review comment (ai-pipeline.md). Never add a service that receives users' phone numbers, addresses, or text (analytics, error tracking, email, a new AI provider) without owner approval. The PRD cites NDPR and marks account deletion as an open question (Open Question 11); a foreign SMS or AI provider is also a cross-border transfer the owner must decide on.