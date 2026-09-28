# db-migration-runner

## Trigger

Use this skill for any schema change, Prisma model/field change, migration, index, relation change, or new persistent data.

## Purpose

Keep Fixora's locked Prisma/PostgreSQL schema safe while preserving money, ownership, indexing, and deletion invariants.

## Rules

- Treat the PRD as the feature source of truth and `AGENTS.md` as the process source of truth.
- Make the smallest schema extension required by the requirement.
- Do not restructure existing schema without an explicit requirement.
- Use Prisma for schema/data access where Prisma can express the operation.
- If raw SQL is necessary, use parameterized Prisma `$queryRaw`.
- Every new model or field requires a migration.
- Required indexes must ship in the same migration as the schema change that needs them.
- `ProviderProfile.categories` requires its GIN index.
- Money is always a whole integer number of kobo. Never introduce float/decimal money.
- Preserve restrictive deletion behavior. Never switch a `Restrict` relation to `Cascade` or `SetNull`.
- Account deletion semantics are unresolved in v1. Stop and flag the task if it requires deleting a `User` with historical records.
- Do not introduce v2/v3 schema such as job payment, in-app subscription checkout, verification gating, company/team accounts, multi-city, automated dispute resolution, provider review responses, or generative AI unless explicitly scoped.

## Safe migration sequence

1. Identify the PRD requirement ID driving the change.
2. Inspect the existing schema and locked rules.
3. Make the smallest additive schema change possible.
4. Identify every affected query and required index.
5. Add required indexes in the migration.
6. Verify every monetary field remains an integer kobo field.
7. Verify existing restrictive relations remain restrictive.
8. Generate a named Prisma migration.
9. Inspect the generated SQL before applying it.
10. Confirm the migration contains no accidental destructive change or unwanted cascade.
11. Generate the Prisma client.
12. Run the build.
13. Run business-rule and ownership tests affected by the schema change.
14. Report the requirement IDs, schema changes, migration name, tests, and any unresolved ambiguity.

## Deletion guardrail

Deletion behavior is not permission to redesign referential integrity.

If a task involves deleting an account with historical Fixora records:

- preserve `Restrict`;
- do not add cascading deletion as a convenience;
- do not invent a retention/anonymization policy;
- stop and flag the unresolved account-deletion requirement.

## Completion checklist

- [ ] Requirement ID identified.
- [ ] Existing locked schema rules preserved.
- [ ] Smallest necessary schema change made.
- [ ] Required indexes added.
- [ ] GIN index preserved/added for provider categories where applicable.
- [ ] All money remains integer kobo.
- [ ] No `Cascade`/`SetNull` replacement for existing `Restrict`.
- [ ] Generated SQL inspected.
- [ ] Prisma client generated.
- [ ] Build passes.
- [ ] Relevant business-rule tests pass.
- [ ] No later-phase feature introduced.
- [ ] Ambiguities explicitly reported.