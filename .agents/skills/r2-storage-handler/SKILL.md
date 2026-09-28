# r2-storage-handler

## Trigger

Use this skill for anything involving files moving into or out of object storage, including uploads, signed URLs, storage keys, object deletion, or deletion of books/accounts and their files.

## Purpose

Keep storage ownership explicit and keep database rows and R2 objects synchronized without weakening deletion or privacy guarantees.

## Ownership-encoded keys

Storage keys must encode ownership or another repository-approved ownership boundary.

Do not create opaque/global keys that allow an object to be addressed without proving ownership.

A signed URL must only be issued after the caller has passed the appropriate ownership/authorization check.

## Row/object pairing

Treat the database record and R2 object as a pair.

For every persisted file:

- know the database row representing it;
- know the exact object key;
- preserve the ownership relationship;
- make creation/deletion behavior retry-safe.

Do not delete a database row while silently abandoning its object.

Do not delete an object while leaving a database record that falsely claims it still exists.

## Immutable originals

Original uploaded files are immutable.

Do not overwrite originals as part of ordinary processing.

Derived/transformed artifacts must have their own explicitly managed storage records/keys where applicable.

## Deletion sequence

For a supported deletion flow:

1. Authenticate the caller.
2. Verify ownership/authorization.
3. Enumerate the database rows and corresponding storage objects.
4. Prevent new access during deletion where necessary.
5. Delete the required object(s).
6. Delete the corresponding database record(s).
7. Handle partial failures explicitly.
8. Verify that no unauthorized orphan remains.
9. Verify dependent records are handled according to their relationship rules.

Do not report deletion as successful while required objects remain.

## Account deletion guardrail

Fixora v1 has unresolved account-deletion semantics.

Existing restrictive relationships must remain restrictive.

Never change `Restrict` to `Cascade` or `SetNull` merely to make account deletion work.

If a task requires deleting a `User` with historical Fixora records:

- stop;
- preserve the existing relationship constraints;
- flag the unresolved account-deletion requirement;
- do not invent a retention, anonymization, or cascading policy.

## Signed URLs

Before issuing a signed URL:

- verify the authenticated session;
- verify resource ownership/relationship;
- resolve the server-side storage key;
- sign only the authorized object.

Never accept an arbitrary client-supplied storage key as proof of access.

## Client uploads

Client input must not determine ownership.

The server determines the storage namespace/key from authenticated ownership and validated resource context.

## Failure handling

Storage operations can fail independently of database operations.

Design the flow so failures are:

- detectable;
- retryable;
- observable;
- unable to silently grant access to an unauthorized object.

Do not swallow object-store errors.

## Completion checklist

- [ ] Ownership is encoded/enforced.
- [ ] Server controls storage keys.
- [ ] Signed URLs require authorization.
- [ ] Database rows map to exact objects.
- [ ] Originals remain immutable.
- [ ] Object and row deletion stay paired.
- [ ] Partial failures are handled.
- [ ] No orphaned object is silently accepted.
- [ ] No `Restrict` relation was weakened.
- [ ] Account deletion ambiguity is flagged rather than invented.
- [ ] Relevant ownership/storage tests pass.