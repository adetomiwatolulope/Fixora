# flutterwave-billing

## Trigger

Use this skill for anything involving movement of kobo, including payments, webhooks, subscriptions, credits, refunds, balances, or watermark gates.

## Fixora phase gate

Automated payment collection is not authorized in Fixora v1.

The current product allows manual subscription handling by Admin and explicitly excludes:

- job payment;
- in-app subscription checkout;
- automated payment collection.

Do not implement automated Flutterwave billing until the owner explicitly starts that scope.

When automated payment is explicitly scoped, Flutterwave is the only authorized payment provider.

## Money

- All money is integer kobo.
- Never use float/decimal for money.
- Client-provided amounts are never authoritative.
- Recalculate/validate monetary values from trusted server state.

## Webhook order

When payment/webhook work is explicitly authorized, follow this order:

1. Receive the webhook.
2. Verify the Flutterwave signature.
3. Validate the payload.
4. Validate amount/currency/state using trusted server-side expectations.
5. Enforce idempotency using the Flutterwave transaction reference.
6. Apply the business state change.
7. Apply ledger and balance changes atomically.
8. Persist the durable payment/audit state.
9. Return success only after the transaction commits successfully.

Do not mutate balances before signature/payload/idempotency checks.

## Idempotency

The Flutterwave transaction reference is the idempotency key.

Repeated delivery of the same reference must not create:

- duplicate credits;
- duplicate ledger entries;
- duplicate subscription effects;
- duplicate business state changes.

Make the uniqueness constraint/database transaction part of the guarantee.

## Ledger-paired balance changes

A balance mutation must have its corresponding ledger/audit record inside the same database transaction.

Do not perform:

1. balance update;
2. separate ledger insert;

as independent operations that can leave the system inconsistent.

## Watermark gate

Payment-dependent watermark behavior must use the repository-defined watermark gate.

The exact watermark/payment semantics are not present in the supplied `AGENTS.md` or PRD. Do not invent them.

## v1 restrictions

Do not add:

- job payment;
- automated subscription checkout;
- payment-dependent job workflows;
- speculative credits/refunds systems;
- payment features merely because Flutterwave exists in the requirements.

## Completion checklist

- [ ] Automated billing explicitly authorized for the task.
- [ ] Flutterwave is the only provider.
- [ ] Integer kobo used everywhere.
- [ ] Client amount is not authoritative.
- [ ] Signature verification happens first.
- [ ] Payload/state validated.
- [ ] Idempotency uses transaction reference.
- [ ] Ledger and balance changes are atomic.
- [ ] Durable state is written transactionally.
- [ ] Watermark gate uses repository-defined semantics.
- [ ] No v2/v3 payment feature introduced.