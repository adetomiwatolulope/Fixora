# ai-provider-adapter

## Trigger

Use this skill for anything under `src/services/ai`, including provider adapters, prompts, confidence mapping, response validation, normalization, or provider switching.

## Purpose

Keep AI providers behind a stable service contract and enforce validation, human sign-off, normalization, and anti-fabrication requirements.

## Fixora v1 phase gate

Fixora v1 does not authorize generative AI.

The PRD explicitly excludes generative AI, and ranking/moderation behavior must remain deterministic/rules-based unless explicitly scoped otherwise.

Moderation may use:

- deterministic rules; or
- an explicitly permitted hosted moderation API.

Do not introduce an LLM or generative AI provider merely because an AI service directory exists.

## AiService contract

Provider SDKs must not leak through application/business code.

Define a stable service boundary so callers depend on the Fixora contract rather than a provider-specific SDK.

The adapter owns:

- provider invocation;
- provider-specific request/response translation;
- provider errors;
- response validation;
- normalization into the internal contract.

Callers should depend only on the internal service contract.

## Human sign-offs

The product requires two dated human sign-offs for the AI-provider flow.

The exact identities, dates, and required sign-off format are not present in the supplied `AGENTS.md` or PRD.

Do not fabricate sign-off names, dates, or approvals.

Require the repository-defined sign-off artifacts before enabling the relevant flow.

## Response validation

Never trust provider output merely because it parsed successfully.

Validate:

- required fields;
- allowed values;
- types;
- bounds;
- confidence representation;
- provider-specific failure states.

Reject malformed output before it reaches business logic.

## Normalization

Normalize provider-specific representations into the internal Fixora contract.

Do not let callers branch on provider names merely to interpret equivalent responses.

Provider switching should require changes inside the adapter boundary rather than throughout the application.

## Confidence mapping

Confidence values must use the repository-defined mapping.

Do not invent thresholds or semantic meanings when the source requirements do not define them.

If multiple providers use different confidence representations, normalize them before returning the internal result.

## Prompts

Prompts are application behavior.

Keep them versioned and reviewable.

Do not silently change prompts in ways that alter business behavior.

## R11 fabrication net

The R11 fabrication net must be enforced at the AI boundary.

The exact R11 rule/mechanics are not present in the supplied `AGENTS.md` or PRD, so do not invent the implementation.

When the repository supplies the R11 definition, ensure the adapter/service layer prevents unsupported fabricated output from crossing into application state.

## Completion checklist

- [ ] v1 phase gate checked.
- [ ] No unauthorized generative AI introduced.
- [ ] Stable `AiService` contract preserved.
- [ ] Provider SDK isolated.
- [ ] Two required dated human sign-offs verified where applicable.
- [ ] Provider responses validated.
- [ ] Responses normalized.
- [ ] Confidence mapping uses repository definitions.
- [ ] Prompts are versioned/reviewable.
- [ ] R11 fabrication protection is enforced using repository-defined rules.
- [ ] Provider switching does not leak provider-specific logic.
- [ ] Tests cover malformed/invalid provider output.