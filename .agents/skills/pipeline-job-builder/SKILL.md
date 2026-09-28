# pipeline-job-builder

## Trigger

Use this skill for anything in worker/pipeline code, including pipeline stages, job types, queue processors, batch handling, scheduled jobs, and exports.

## Purpose

Build safe background processing with explicit job boundaries, ordered cost gates, partial-batch semantics, and export invariants.

## Job design

- Keep background work separate from request-response handlers.
- Put reusable business logic in modules rather than duplicating it inside workers.
- Prefer small, retry-safe functions.
- Make job processing idempotent where retries are possible.
- Do not introduce worker-only business rules that contradict module rules.

## Job granularity

Choose a job boundary around a meaningful unit of work.

Avoid:

- giant jobs that combine unrelated responsibilities;
- jobs that require an entire batch to succeed when partial processing is explicitly allowed;
- duplicated request-handler business logic;
- unnecessary AI/provider calls.

## Cost gates

The pipeline must enforce the product's three required cost gates in order before any AI spend.

The exact predicates/definitions of those three gates are not present in the supplied `AGENTS.md` or PRD. Do not invent their implementation.

When those definitions are supplied by the repository, preserve their exact ordering:

1. Gate 1
2. Gate 2
3. Gate 3
4. Only then permit AI spend

A pipeline must not move, merge, or bypass these gates without explicit authorization.

## PARTIAL batch semantics

When a batch is allowed to complete partially:

- persist successful work independently;
- identify failed items explicitly;
- do not report the entire batch as successful;
- make retry behavior deterministic;
- preserve already-completed work on retry;
- expose the repository's defined partial-batch state exactly.

Do not invent a new partial status when the repository already defines one.

## Export invariants

Exports must preserve the repository's defined watermark and diagram-edge invariants.

The supplied `AGENTS.md` and PRD do not define the exact watermark or diagram-edge semantics. Do not invent those definitions.

When implementing an export:

- preserve existing watermark semantics;
- preserve diagram edges;
- do not silently omit required relationships;
- do not change output meaning merely to simplify processing.

## Fixora v1 worker rule

The explicitly required v1 scheduled worker is stale-completion handling.

It must:

- identify eligible stale orders;
- use the shared completion/business-rule path;
- mark the order as auto-completed;
- preserve the visible distinction between manually confirmed and automatically completed orders;
- remain compatible with review eligibility.

Do not add job-payment processing or other v2/v3 worker functionality.

## Completion checklist

- [ ] Job purpose is explicit.
- [ ] Business logic is shared with modules.
- [ ] Retry behavior is safe.
- [ ] Idempotency is considered.
- [ ] Three cost gates occur in the required order before AI spend.
- [ ] PARTIAL semantics are preserved where applicable.
- [ ] Export watermark is preserved.
- [ ] Diagram edges are preserved.
- [ ] Stale-completion worker uses the shared completion path.
- [ ] Auto-completion remains visibly distinguishable.
- [ ] No job-payment/v2/v3 functionality introduced.