# AAG Contact Us Widget

A standalone, embeddable **Contact Us** form for the Alpha Apex Group Webflow
site. It is a single React app compiled to one self-mounting IIFE bundle. CSS is
injected at runtime, so embedding requires only one `<div>` and one `<script>`.

> ## ⚠️ The widget now talks to the Worker, and the Worker is not deployed yet
>
> The interim transport is gone. The widget POSTs **multipart to the Cloudflare
> Worker**, which stores the resume and forwards flat JSON to Zapier. Nothing in
> this repo posts to the Zapier hook any more.
>
> **The endpoint has not been repointed.** `data-endpoint` in the Webflow embed
> still points at the Zapier Catch Hook, and Zapier does not answer `ok: true`,
> so **every submission currently renders the error panel**. That is the correct
> behaviour, not a bug: the widget refuses to claim success it cannot verify.
> The form is not delivering leads until the cutover below runs.
>
> **Cutover — the one change that turns it back on.** Deploy the Worker, then set
> the embed attribute to the Worker's submit hostname:
>
> ```html
> data-endpoint="https://<submit-host>/submit"
> ```
>
> It is a runtime attribute in the Webflow embed, so this needs no code deploy
> and no rebuild. See [Cutover checklist](#cutover-checklist) for the full order.
>
> **Not done yet, and required before real candidates use this:**
>
> | Gate | State |
> | --- | --- |
> | Worker deployed + R2 bucket provisioned | ❌ not done |
> | `data-endpoint` repointed at the Worker | ❌ not done — do NOT apply before the Worker is live |
> | **Cloudflare Access on the resume hostname** | ❌ **not configured** |
> | Old Zapier Catch Hook revoked | ❌ not done — the burned URL still accepts POSTs |
>
> **The Access gate is the one that matters most.** `GET /resume/<key>` has a
> host lock in code, but **no authorization**: authorization is edge-side and
> deliberately not implemented in the Worker. Until the Access application exists
> on the resume hostname and probe P2 passes, that hostname must not be pointed
> at this Worker with a non-blank `RESUME_HOST`, or stored CVs are world-readable
> to anyone holding a key. A green local test suite proves the route works and
> proves **nothing** about the gate — Miniflare cannot see Access.

The form uses progressive disclosure in a single form (not a multi-step wizard).
On the **Inquiry type** placeholder it previews the General Question field set
so the widget never loads empty; choosing a type then reveals that type's
fields. The preview is presentational only — the placeholder is not a valid
value, so submitting without choosing a type fails and asks for one.

## Dev commands

```bash
npm install       # install dependencies
npm run dev       # local dev harness at http://localhost:5173 (mock endpoint)
npm run build     # produce the single embeddable bundle in dist/
npm run test      # run the widget + Zapier payload contract tests (vitest)
```

`npm run zapier:samples` is a manual tool, not part of the test run — see
[Zapier delivery](#zapier-delivery-why-a-worker-sits-in-the-middle).

`npm run erase:candidate` honours a candidate's deletion request — see
[Resume retention and erasure](#resume-retention-and-erasure).

`npm run dev` serves `index.html`, which mounts the widget in a full-page panel
and mocks the backend so submissions resolve locally (watch the console for the
captured `FormData`). The mock answers `{"ok":true}` — a bare `200` would render
the error panel, which is exactly the contract described below.

## Build output

`npm run build` emits **one** file:

```
dist/aag-contact-form.js
```

All CSS is injected by JS at runtime — there is no separate stylesheet to load.

## Webflow embed

Drop the mount div wherever the form should appear, then load the versioned
Cloudflare Pages script URL:

```html
<div
  id="aag-contact-form"
  data-endpoint="https://api.alphaapexgroup.com/contact"
  data-source="webflow/contact-page"
></div>

<!-- Use an explicit release or commit SHA. Never use a "latest" URL. -->
<script src="https://aag-contact-form.pages.dev/aag-contact-form.js?v=<release-or-sha>" defer></script>
```

- `data-endpoint` **(required)** — URL the form POSTs to. If missing, the widget
  does not mount.
- `data-source` *(optional)* — free-form string forwarded in the payload (use it
  to identify the page/placement).

The script is safe to place in the site `<head>`: it waits for
`DOMContentLoaded` and does nothing if the mount div is absent.

### Theming

The widget mounts into the **light DOM** — there is no Shadow DOM — so the
Webflow site stylesheet cascades into it. The fields and the submit button carry
the Webflow style-guide classes, which means **Webflow is the source of truth for
their visual identity**:

| Element | Classes | Edited in |
| --- | --- | --- |
| Text / email / tel input | `form_input w-input` | Webflow Designer |
| Select | `form_input is-select-input w-select` | Webflow Designer |
| Textarea | `form_input is-text-area w-input` | Webflow Designer |
| Submit button | `button is-form-submit w-button` | Webflow Designer |
| Error banner | `form_message-error` | Webflow Designer |
| Success panel | `form_message-success` | Webflow Designer |
| Field wrapper / label | `form_field-wrapper` / `form_label` | Webflow Designer (empty hooks today) |

Restyle any of these in the Designer and the widget follows automatically, in
sync with every other form on the site. The widget's own CSS **deliberately
declares no border, padding, height, colour or typography** for them — its
runtime-injected `<style>` lands *after* the Webflow stylesheet, so at equal
specificity any competing declaration here would silently beat the Designer.
`src/styles.test.ts` guards both halves of that contract.

The message-class contract is **only** `form_message-error` and
`form_message-success`. Do **not** add `w-form-fail` or `w-form-done` to either
message element.
Webflow's base stylesheet hides those classes with `display: none`, expecting
Webflow's form JavaScript to reveal them. This React widget conditionally
renders messages itself and does not run that JavaScript.

Layout and behaviour still live in the widget's own `aag-form-` prefixed CSS:
the flex/grid rhythm, the container query that collapses two-column rows below a
420px *container* width, the honeypot, the file input (Webflow has no class for
`<input type="file">`) and the inline per-field error text. `--aag-form-gap` and
`--aag-form-radius` remain overridable on the mount div.

There is one deliberate override:

```css
.aag-form-root .form_input { margin-bottom: 0; }
```

Webflow's `.form_input` ships `margin-bottom: .75rem` for stacked native Webflow
forms. This widget spaces fields with flex `gap`, so that margin double-counts
and produces uneven vertical rhythm. Neutralising it keeps layout with the
widget while leaving every visual property to Webflow. A matching
`.aag-form-root .button[disabled] { opacity: .65 }` supplies the in-flight
submit state, which the style guide does not define.

When developing locally, `index.html` loads the published Webflow stylesheet so
`npm run dev` mirrors the embedded environment. That link is dev-harness only and
is never part of the shipped bundle.

## Cloudflare Pages delivery

GitHub Actions is the delivery mechanism. On every push to `main` (or a manual
workflow dispatch), Actions installs dependencies, builds the widget, and uses
Cloudflare Pages Direct Upload to deploy `dist`. The deployment step runs only
after `npm run build` succeeds.

Before the first workflow deployment, an owner must create the Pages project
with a Pages-scoped API token:

```bash
npx wrangler pages project create aag-contact-form --production-branch=main
```

Add these GitHub repository secrets by their exact names:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with permission to deploy the Pages project |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID that owns the Pages project |

The deployment configuration is in [`wrangler.toml`](./wrangler.toml) and
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml). Do not commit
tokens, account IDs, or other Cloudflare credentials.

After Pages has deployed, use this fixed, explicitly versioned Webflow URL
pattern and bump the release or commit SHA for every new deployment:

```text
https://aag-contact-form.pages.dev/aag-contact-form.js?v=<release-or-sha>
```

## API contract

The table below is the shape the widget assembles with `buildFormData()` and
POSTs to the Worker as `multipart/form-data`, unchanged. It is the contract with
the Worker; the Worker converts it into the flat 15-key Zapier payload (see
[Zapier delivery](#zapier-delivery-why-a-worker-sits-in-the-middle)).

**A 2xx is not success.** The widget renders the success panel only when the
response is `response.ok` **AND** its body parses as a JSON object whose `ok` is
exactly `true`:

```jsonc
{ "ok": true, "resumeUrl": "https://<resume-host>/resume/<uuid>" }
```

Anything else is an error: a non-JSON body, a non-object, `ok: false`, or a
missing `ok`. Nothing defaults to success. This is deliberate — Zapier answers
`200 {"status":"success"}` for bodies it throws away, and that shape is exactly
the "valid JSON, no `ok` field" case now rejected. `resumeUrl` comes from the
Worker and is never constructed in the browser.

Requests time out after 60s by default to accommodate the permitted 10MB resume
upload.

Flat, camelCase keys. Optional fields are omitted when empty.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inquiryType` | string | always | One of: `Recruitment / Hiring`, `Consulting`, `General Question`, `Submit Resume` |
| `firstName` | string | always | |
| `lastName` | string | always | |
| `workEmail` | string | always | Valid email |
| `message` | string | always | Textarea contents |
| `title` | string | engagement types | Consulting / Recruitment only. **Not sent for Submit Resume.** |
| `company` | string | engagement types | Same as above |
| `phone` | string | optional | Loosely validated. Consulting / Recruitment / Submit Resume |
| `estimatedBudget` | string | optional | Free-form, ≤ 100 characters. Consulting / Recruitment only |
| `resume` | File | Submit Resume only | `.pdf/.doc/.docx`, ≤ 10MB |
| `source` | string | when configured | Value of `data-source` |
| `website` | — | never sent | Honeypot; if a bot fills it the client fakes success and never calls the API |

> **`companySize` and `expectedTimeline` are no longer collected.** The form
> dropped both from Consulting and Recruitment / Hiring — they were routinely
> left blank and the longer form hurt conversion. The widget never sends them,
> so they are absent from this multipart body entirely. They still exist on the
> **Zapier** side of the contract as permanently empty strings, coined by the
> Worker; see [Zapier JSON payload](#zapier-json-payload). Retired, not removed.

The canonical contract lives in [`src/schema.ts`](./src/schema.ts) as zod
schemas and exported TypeScript types — copy it to mirror validation on the
backend.

### Zapier delivery (why a Worker sits in the middle)

The client's backend is a **Zapier Catch Hook**, and Zapier only accepts XML,
JSON or URL-encoded bodies. It **silently discards `multipart/form-data` and
still answers HTTP 200** — so an unconverted submission looks successful to the
widget while the lead is dropped on the floor.

**Architecture** — a Cloudflare Worker sits between the widget and Zapier and
performs the conversion: it receives the multipart body, uploads the resume to
R2, and forwards flat JSON to the hook. It answers 2xx only when **both** the
upload and the forward succeed.

```text
widget ──multipart──> Cloudflare Worker ──JSON──> Zapier Catch Hook
                             │
                             └─ resume file ──> R2 (returns resumeUrl)
```

The hook URL and the Zap's shared secret are **Worker secrets**. Neither appears
in the bundle or the page source, so the widget can no longer be used to spend
the client's Zapier task quota.

**Never set the `Content-Type` header by hand.** Only the browser knows the
`multipart/form-data; boundary=…` value it generates for a `FormData` body; set
the header yourself and the boundary is lost, so the Worker cannot parse a
single field. Leaving it alone also keeps the request CORS-safelisted, so no
preflight `OPTIONS` ever fires. `src/submit.test.ts` guards this explicitly, and
it is the single most breakable line in the transport.

### Resume delivery email

When a submission carries a validated resume, the Worker also **mails that file
to staff as an attachment** — the original bytes, under the original file name,
never converted to PDF.

| | |
|---|---|
| Provider | [Resend](https://resend.com) REST API, `POST https://api.resend.com/emails` |
| From | `AAG Website <resumes@forms.alphaapexgroup.com>` |
| To | `hello@alphaapexgroup.com` |
| Secret | `RESEND_API_KEY` — a **Worker secret**, never a var |
| Body | Plain text. No HTML part, and no links at all |

The point is that staff stop needing the credential-gated `/resume` link in
their daily flow. That link is **not** going away: it remains the archive and
the fallback, and nothing below changes it.

```text
widget ──multipart──> Worker ──JSON──> Zapier      (delivers the lead)
                        │
                        ├─ resume file ──> R2      (the archive)
                        └─ resume file ──> Resend  (the notification)
```

**This email is a notification, not the delivery contract.** By the time it is
attempted the CV is in R2 and the lead is in Zapier — the submission has already
succeeded. So:

- **It is sent *after* the Zapier forward, never before.** A failed forward
  answers 502 and the candidate submits again; mailing first would put a fresh
  copy of the same CV in the inbox on every retry.
- **It is awaited, then discarded.** A Resend outage, a rejected key or an
  unverified sender domain answers the candidate `200` exactly as a healthy
  submission does. Turning it into a 502 would tell a candidate their
  application failed when it did not — and this widget's answer to a failure is
  the candidate submitting again, which buys duplicate leads and a false failure
  report in exchange for a notification staff can also get from the `resumeUrl`
  already in the lead.
- **Only `inquiryType: "Submit Resume"` triggers it** — not merely "a file
  arrived". `/submit` is public and a multipart body is trivially hand-written,
  so anyone can post a General Question carrying a PDF. On a file-only rule that
  would put a stranger's attachment into a staff inbox under a category nobody
  expects one from. The other three inquiry types never contact Resend whatever
  their body contains, and work unchanged on a deploy with no Resend
  configuration at all.
  This gates the **email only**: a file attached to a non-resume inquiry is
  still validated, stored and reported through `resumeUrl` / `resumeFileName`,
  exactly as before. Refusing it would throw away a real lead from someone who
  attached something to the wrong form, and the payload link is the only way
  anyone would ever learn the file was there.

**`RESEND_API_KEY` is deliberately not a mandatory binding.** The hook URL,
shared secret and erasure salt are checked before anything else because a
missing one means a lead nobody receives. This one does not deliver anything, so
listing it there would refuse every submission — including the three that have
no resume — during the window between the code deploy and `wrangler secret put`.

The one thing that *is* recorded is a single word:

```json
{"resumeEmail":"delivered"}
```

`delivered` · `rejected` (Resend answered and refused) · `errored` (the attempt
threw) · `unconfigured` (no key on a deploy that just took a resume). That is
the complete set, and it is deliberately all that escapes: **the message being
mailed is a CV**, so nothing logs the API key, the candidate, the file name, the
recipient, the response body or the endpoint. `unconfigured` is a value rather
than silence on purpose — a secret nobody set would otherwise mean "this feature
is quietly off, forever", which is the same shape as the provisioning mistake
this Worker exists to catch.

Two implementation details worth not undoing:

- **Redirects are never followed** (`redirect: "manual"`), the same control the
  Zapier forward uses and for a stronger reason: a custom `Authorization` header
  is not stripped on a cross-origin hop, so a followed redirect would hand the
  API key and the CV to whatever the `Location` names.
- **No links in the body, including the resume URL.** Resend rewrites links when
  click tracking is enabled on a domain — a dashboard setting this code cannot
  read — and routing a candidate's gated CV URL through a tracking redirector is
  not a trade worth making for a fallback the Zapier record already carries.

### Rate limiting

Both public routes carry a per-client request budget, enforced by Cloudflare's
**native rate limiting binding** declared in `worker/wrangler.toml`.

| Route | Budget | Counted against |
|---|---|---|
| `POST /submit` | 20 per 60s | `CF-Connecting-IP` |
| `GET /resume/<key>` | 60 per 60s | `CF-Connecting-IP` |

The binding was chosen over a WAF rate limiting rule because a WAF rule is
configured **per zone**, and this Worker is served from `workers.dev` while the
custom domain is still undecided. The binding needs no zone, no KV and no
Durable Object.

**The limits are deliberately generous.** A corporate NAT puts a whole office
behind one address, so several recruiters at one client company share a budget.
A limit tuned to a single human refuses real candidates — and a refused
candidate is a lead lost *silently*, which is the failure this Worker exists to
eliminate. Over-blocking costs more here than under-blocking.

**Know what this does not do.** Cloudflare counts these **per location, not
globally**. An attacker spread across N colos gets N times the ceiling. This
raises the cost of casual abuse — one script, one machine, a runaway retry loop
— and it does **not** stop a serious distributed attack. If that ever becomes
the threat, the answer is a zone plus a WAF rule, not a smaller number here.

Two further decisions worth knowing before changing anything on this path:

- **It fails open.** A limiter that is missing or throwing allows the request.
  A limiter outage that blocked `/submit` would lose every lead arriving during
  it, unrecoverably and silently; one that allows requests through costs only
  the protection. Those costs are not comparable. (Note this is the *opposite*
  of the `/resume` credential, which fails closed — a missing credential
  publishes candidate PII, a missing limiter publishes nothing.)
- **A request with no `CF-Connecting-IP` is counted, not exempted.** Cloudflare
  always sets that header on edge traffic, so an absent one means a service
  binding or local dev rather than a stranger. Those requests share a single
  sentinel budget: not exempt (which would make "send no header" an unlimited
  bypass) and not refused (which on `/submit` would be a lost lead).

An over-budget caller gets `429` with `{"error":"RATE_LIMITED"}` and a
`Retry-After` header. On `/submit` the refusal carries the CORS echo so the
**widget can read it** — a 429 the browser hides is indistinguishable from a
network error, and this widget's response to that is the candidate submitting
again, turning one refusal into duplicate leads.

### Resume retention and erasure

**Retention is indefinite, by decision.** Stored CVs do not expire and there is
deliberately **no R2 lifecycle rule**. An automatic expiry would delete resumes
the client still needs, and nobody would find out until the day they went
looking for one. Deletion is **manual and on request**.

That decision is only defensible if the deletion is actually executable, which
is why `scripts/erase-candidate.ts` exists. R2 keys here are opaque UUIDs —
chosen so that a key reveals nothing about the person — so without the tool
nobody can answer "delete my data" at all. **The retention policy and the script
are one decision, not two.**

**Who runs it.** Whoever handles the request, from a checkout of this repo, on a
machine that already has the R2 credentials. It is not deployed and nothing
calls it automatically.

**What it needs** — four environment variables, none with a default, none
committed:

| Variable | What it is |
|---|---|
| `ERASURE_SALT` | the **same** value as the Worker secret of that name |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 API token (S3 credentials), object read + delete |
| `R2_SECRET_ACCESS_KEY` | — |

`ERASURE_SALT` is the one that matters most. The script finds a candidate's
objects by recomputing the salted HMAC the Worker stored on them, so a *different*
salt produces well-formed digests that match nothing — and the run would
otherwise report a clean erasure of zero objects. If it is unset the script
**refuses to run and says why**; if it is merely wrong, the zero-match exit
below is the backstop.

**How to run it:**

```bash
# 1. DRY RUN (the default). Lists what would be deleted. Changes nothing.
ERASURE_SALT=… R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
  npm run erase:candidate -- someone@example.com

# 2. Read the report. Then, and only then:
ERASURE_SALT=… R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
  npm run erase:candidate -- someone@example.com --confirm
```

The report prints each matched object's key, `submittedAt` and
`originalFileName`, because a UUID alone tells a human nothing — those two
fields are what let you recognise the person you meant before destroying
anything.

**A zero-match run exits non-zero, on purpose.** "0 objects deleted" has two
causes and the script cannot tell them apart: the candidate genuinely has
nothing stored, or the salt does not match what the Worker signed with and every
CV is still there. It refuses to report success for either, so a deletion
request is never filed as honoured on the strength of a run that found nothing.

The subject hash itself lives in `worker/src/subject-hash.ts` and is **imported**
by both the Worker and the script — never reimplemented. Both test suites pin
its output to the same independently computed digest so the two cannot drift
apart silently.

### Cutover checklist

Ordered. Every intermediate state is safe; running these out of order is not.

1. Provision the R2 bucket and confirm it is **private** — `wrangler r2 bucket
   dev-url get` reports disabled **and** `wrangler r2 bucket domain list` is
   empty. Both. Either alone still serves CVs.
2. Audit the zone for a covering Cloudflare Access application before creating
   any new one. A wildcard app breaks the hostname-isolation assumption.
3. Deploy the Worker and set its secrets (hook URL, shared secret, erasure salt).
   All three are mandatory — a missing one fails the request loudly rather than
   dropping the lead quietly.
   Set `RESEND_API_KEY` here too, but note it is **not** in that mandatory set:
   `/submit` works with or without it, and until it is set every resume
   submission logs `{"resumeEmail":"unconfigured"}` while still storing the CV
   and delivering the lead. See
   [Resume delivery email](#resume-delivery-email).
4. Create the Access application on the resume hostname, then set `RESUME_HOST`.
   It ships blank on purpose, so `/resume` serves nothing until someone does.
5. Run both deploy probes and require a positive signature from each:
   - **P1** — an empty `POST /submit` must answer `400` with
     `{"error":"INVALID_SUBMISSION"}`. Only our Worker can emit that string, so
     no Access challenge can forge a pass.
   - **P2** — an unauthenticated `GET /resume/<sentinel-uuid>` must return a
     response containing `cloudflareaccess.com`. A `404` here means the gate is
     missing, not that the key is unknown.
6. Confirm `ALLOWED_ORIGINS` **contains** `document.location.origin` read from
   the live mounted page — on **every** origin the widget is mounted on, not
   just the one you happen to be looking at. During the migration window that is
   both of them: `alphaapexgroup.com` still serves Squarespace, so the widget
   lives on the Webflow staging origin and on production simultaneously.

   It is a comma-separated allowlist, and the Worker echoes back the caller's
   own origin when it is on the list. An origin that is missing still gets its
   lead delivered and its CV stored — multipart is CORS-safelisted, so no
   preflight fires — but the response is withheld from the page, so the
   candidate sees an error and submits again. That is duplicate leads plus a
   false failure report, and with a one-entry list it is a certainty on cutover
   day rather than a risk.

   The value that must be set at deploy time:

   ```
   ALLOWED_ORIGINS = "https://www.alphaapexgroup.com,https://alpha-apex-group.webflow.io"
   ```

   Every `/submit` log line carries the received `Origin`, so a mismatch is one
   query: group by `origin` and any name not on the list above is the
   misconfiguration, named. Drop the staging entry only once the widget is no
   longer mounted there.
7. **Only now** repoint `data-endpoint` at `https://<submit-host>/submit` and
   send one real staging submission end to end.
8. Delete the old Zapier Catch Hook and verify a direct POST to it now fails.
   Until this step runs, the previously public hook URL still accepts forged
   leads. Record the **new** hook URL in the runbook first — after this step the
   rollback path must point at the new hook, not the burned one.

Rollback is the same attribute: `data-endpoint` is runtime configuration in the
Webflow embed, so pointing it elsewhere restores delivery without a code deploy.

The transform is [`worker/src/payload.ts`](./worker/src/payload.ts). Its
contract tests build their input with the widget's own `buildFormData()`, so a
renamed or added widget field fails the suite instead of silently breaking the
Zap.

#### Zapier JSON payload

Flat, camelCase, **all values are strings**. No nulls, numbers, arrays or nested
objects.

**Every one of the 15 keys is always present.** Fields that do not apply to the
submitted `inquiryType` carry the empty string `""` — they are never omitted and
never `null`. This is deliberate: Zapier builds its field-mapping picker from
whichever sample payload it happened to receive, so a payload that pruned empty
keys would leave those fields unmappable. One complete, stable schema means one
Zap mapping works for all four inquiry types. **Do not "clean up" the payload by
dropping empty keys.**

| Key | Notes |
| --- | --- |
| `inquiryType` | One of: `Recruitment / Hiring`, `Consulting`, `General Question`, `Submit Resume` |
| `firstName` | |
| `lastName` | |
| `workEmail` | |
| `title` | |
| `company` | |
| `phone` | Free-form |
| `companySize` | **Retired — always `""`.** No longer collected by any inquiry type |
| `estimatedBudget` | Free-form, ≤ 100 characters |
| `expectedTimeline` | **Retired — always `""`.** No longer collected by any inquiry type |
| `message` | |
| `resumeUrl` | Object-storage URL written by the Worker after upload |
| `resumeFileName` | Original file name of the uploaded resume |
| `source` | Value of `data-source` |
| `submittedAt` | ISO-8601, e.g. `2026-07-30T14:18:41.000Z` |

Population by inquiry type — `•` populated, `""` always empty:

| Key | General Question | Consulting | Recruitment / Hiring | Submit Resume |
| --- | --- | --- | --- | --- |
| `inquiryType`, `firstName`, `lastName`, `workEmail`, `message`, `source`, `submittedAt` | • | • | • | • |
| `title`, `company` | `""` | • required | • required | `""` |
| `phone` | `""` | • optional | • optional | • optional |
| `estimatedBudget` | `""` | • optional | • optional | `""` |
| `companySize`, `expectedTimeline` | `""` | `""` | `""` | `""` |
| `resumeUrl`, `resumeFileName` | `""` | `""` | `""` | • |

> **`companySize` and `expectedTimeline` are retired, not removed.** The form
> stopped collecting them, so they are now empty for *every* inquiry type — but
> they stay in the payload because the live Zap has already mapped them, and
> Zapier rebuilds its field-mapping picker from the last sample it received.
> Dropping the keys would silently break that mapping. Keep sending them empty.

> **Branch on `inquiryType` only.** Never write a Zapier Filter or Path that
> matches on `estimatedBudget`. It is **free text** the visitor types, so there
> is no finite set of values to enumerate: `"around 60k"`, `"~$60,000"` and
> `"sixty thousand"` are all the same answer and no exact-match Filter catches
> more than one of them. A Filter built this way looks correct in the editor and
> silently never fires. `inquiryType` is the only field in this payload with a
> fixed, code-enforced set of values — branch on that and read the budget by eye.

Four golden fixtures in [`worker/fixtures/`](./worker/fixtures) show one
realistic payload per inquiry type. They are the contract artifact: read them
first when wiring the Zap.

To (re)teach Zapier the field mapping, replay the fixtures at the hook:

```bash
ZAPIER_HOOK_URL="https://hooks.zapier.com/hooks/catch/…" npm run zapier:samples
```

The hook URL is a credential — pass it through the environment, never commit it.
Zapier's trigger sample picker only lists the 3 most recent webhooks from the
past hour, so the oldest of the four will not appear. That is fine: every
fixture carries the complete key set, so any single one teaches Zapier the whole
schema.

## Project structure

```
src/
  schema.ts        # zod discriminated union + exported payload types (the contract)
  schema.test.ts   # vitest unit tests for the schema
  fields.tsx       # accessible field primitives (label/error/aria wiring)
  submit.ts        # FormData builder + multipart POST to the Worker (60s default timeout)
  ContactForm.tsx  # the form component (progressive disclosure, states, honeypot)
  main.tsx         # self-mounting entry point (reads data attributes)
  styles.css       # layout-only widget CSS (Webflow owns field/button visuals)
worker/
  src/payload.ts       # pure multipart -> Zapier JSON transform (no React, no zod)
  src/payload.test.ts  # contract test, driven by the widget's real buildFormData()
  src/resume-email.ts  # Resend REST call that mails the resume as an attachment
  fixtures/*.json      # four golden payloads, one per inquiry type (the artifact)
scripts/
  send-zapier-samples.ts  # manual fixture replay against the Catch Hook
index.html         # dev harness with a mocked backend + the Webflow stylesheet
vite.config.ts     # single-file IIFE build (CSS injected by JS)
```

`scripts/` is typechecked by `tsc -b` (via `tsconfig.worker.json`) and never
enters `dist/aag-contact-form.js`.

`worker/` never enters `dist/aag-contact-form.js`, with exactly one exception:
**`worker/src/limits.ts`**. The size, extension and MIME rules are shared on
purpose — the widget validates for a good error message and the Worker
re-validates as the authoritative check, and duplicating the numbers is how the
two sides silently drift until the form accepts files the server rejects.

`src/bundle.test.ts` enforces that as an **exact set**: the widget's production
source graph may import `../worker/src/limits` and nothing else from `worker/`.
The module is named literally, so any other cross-boundary import fails the test
rather than shipping Worker code to the browser. It also scans the built bundle
for the Zapier transform's server-only wire keys, and checks positively that the
shared limits module really did ship — otherwise every absence assertion would
also pass on a bundle containing no shared code at all.
