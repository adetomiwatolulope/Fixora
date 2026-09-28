---
trigger: always_on
---

# upload-and-storage.md — Build Rules: File Uploads & Storage

Scope: any code that accepts, stores, serves, or deletes a user-supplied file.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Status: INACTIVE BY DESIGN. Fixora v1 has no upload feature.
- No PRD requirement, model, or field involves a file: no profile photo, no portfolio, no order attachment, no review image, no ID document.
- Provider verification, the one feature that would bring documents, is v2 (PRD Section 13, Open Questions 1 and 5).
- No storage service is in the locked stack (AGENTS Q2) or the folder layout (AGENTS Q4).
UP-1 to UP-4 are live now. UP-5 to UP-13 are defaults that take effect the moment the owner scopes an upload feature, and each is an [ASSUMPTION] until then.
Every rule here is a failure condition, not a preference. Cite UP-n in the Question 6 checklist when touched.

## Live rules

**UP-1 No upload capability exists in v1.** No file input, multipart route, storage SDK, `/lib/storage` folder, signed-URL code, or file-related field (`photoUrl`, `avatarKey`, `attachmentKey`, or anything similar) in any model or response. Every schema field and endpoint traces to a PRD requirement (AGENTS Q1), and no requirement mentions a file. Expect these temptations: a provider profile photo, a photography portfolio (the category exists in PR-PROVIDER-001, but no portfolio does), a photo attached to an order description, an image on a review. Each one is a new feature. Stop and flag it (AGENTS Q7). "It's just one optional field" is not an exception.

**UP-2 A storage provider is a locked-stack change, not an implementation detail.** No object storage service appears in AGENTS Q2. Adding one needs an owner decision recorded in AGENTS.md before any SDK is installed, the same way Flutterwave is handled. Never install a provider "temporarily". Never use the application server's local disk or a Postgres column as a stand-in.

**UP-3 The requirement comes first.** The first upload feature needs, before any code:
- a new `PR-XXX-NNN` requirement stating what may be uploaded, by whom, allowed types, maximum size, who can read it, and what happens to it on deletion;
- an approved schema extension.
A task that says "add a photo" without those is missing its requirement. Flag it.

**UP-4 No identity documents until deletion is decided.** A government ID or trade certificate (the v2 verification gate) is personal data. Account deletion has no defined semantics (Open Question 11, AGENTS rule 23) and is NDPR-relevant. Do not build any upload of an ID, a certificate, or any personal document until Open Question 11 has an answer and the verification decision (Open Question 1) has been made. Never switch an `onDelete: Restrict` relation to `Cascade` or `SetNull` to make files or their owning rows easier to delete.

## Defaults for when an upload feature is scoped

**UP-5 Private by default. Access follows the parent resource.** A file is readable only by whoever can read the row it belongs to:
- order files: the order's customer, its provider, and Admin (PR-ORDER-011);
- verification documents: the provider who owns them, and Admin;
- nobody else.
A wrong requester gets 403, never an empty result or a 404 standing in for a denial (PR-TECH-005). Public exposure (for example, a profile photo shown in search) is an owner decision written into the requirement, never a default. The ownership check runs in `/modules` before any URL is issued. `/lib` never decides who may read.

**UP-6 One abstraction.** Only `/lib/storage` imports the storage SDK, and it contains no business rules (AGENTS Q4). No module talks to the provider directly.

**UP-7 Validate on the server, by content.** Enforce the type allowlist by inspecting the file's actual content (signature bytes), never the extension or the client-declared MIME type. Enforce the size limit on the server while reading the upload, not only in the client. Allowed types and limits come from the scoped requirement. If it names none, stop and flag it. SVG and HTML are never on the allowlist by default. Serve every file with its verified content type and `X-Content-Type-Options: nosniff`. Never execute, evaluate, or render uploaded content inline as markup.

**UP-8 Keys are server-generated and opaque.** Never build a storage key or path from the uploaded filename or any user input. If the original filename is kept, it is display metadata only: escaped on render and never used in a path.

**UP-9 References only, URLs short-lived.** File bytes never go in Postgres. The database stores an opaque key, never a URL. A signed URL is generated per request, after the ownership check, and expires in minutes (default 900 seconds [ASSUMPTION]). It is never stored, cached, or logged.

**UP-10 Strip image metadata before storing.** Photos taken at a customer's home carry EXIF GPS coordinates. Fixora deliberately limits who sees a job's location and a provider's phone number (PR-ORDER-011, PR-PROVIDER-004). An uploaded image must not leak the same information through its metadata. Strip it before the image is stored or served.

**UP-11 Publicly shown images need a moderation path the PRD does not have.** PR-AI-002 moderates review text only. Do not extend it to images. Do not add a vision or generative model to do so (AGENTS rule 24). Any image shown to someone other than its owner needs a moderation flow defined in its own requirement. Until that exists, no user-uploaded image is shown publicly.

**UP-12 Deletion parity.** Every stored object is deletable together with its owning row. Deleting one without the other leaves an orphan object or a dangling key. The requirement must define what is deleted, when, and how long objects are retained after an order completes or a dispute resolves. None of that is defined today.

**UP-13 Fail closed.** If a write, validation, or signing step fails, the request fails. Never fall back to storing the file elsewhere, skipping validation, or returning a public URL to make a request look successful.

Tests for any upload work follow AGENTS Q6: at least one test attempts the forbidden action (another user requesting a file, a file whose extension lies about its content, an oversize file, a filename containing `../`, an image with GPS metadata coming back clean).