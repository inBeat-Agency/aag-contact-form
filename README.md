# AAG Contact Us Widget

A standalone, embeddable **Contact Us** form for the Alpha Apex Group Webflow
site. It is a single React app compiled to one self-mounting IIFE bundle. CSS is
injected at runtime, so embedding requires only one `<div>` and one `<script>`.

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
npm run test      # run the zod schema unit tests (vitest)
```

`npm run dev` serves `index.html`, which mounts the widget in a full-page panel
and mocks the backend so submissions resolve locally (watch the console for the
captured FormData).

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

The form sends `multipart/form-data` (a `FormData` body) via `POST` to
`data-endpoint`. A 2xx response is treated as success; anything else shows the
error banner. Requests time out after 60s by default to accommodate the
permitted 10MB resume upload.

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
| `companySize` | string | optional | Consulting / Recruitment only: `1-50`, `51-200`, `201-1,000`, `1,000+`. **Not sent for Submit Resume.** |
| `estimatedBudget` | string | optional | Consulting / Recruitment only: `Not yet defined`, `Under $50K`, `$50K – $150K`, `$150K – $300K`, `$300K+` |
| `expectedTimeline` | string | optional | Consulting / Recruitment only: `ASAP`, `1-3 months`, `1-6 months`, `6+ months` |
| `resume` | File | Submit Resume only | `.pdf/.doc/.docx`, ≤ 10MB |
| `source` | string | when configured | Value of `data-source` |
| `website` | — | never sent | Honeypot; if a bot fills it the client fakes success and never calls the API |

The canonical contract lives in [`src/schema.ts`](./src/schema.ts) as zod
schemas and exported TypeScript types — copy it to mirror validation on the
backend.

## Project structure

```
src/
  schema.ts        # zod discriminated union + exported payload types (the contract)
  schema.test.ts   # vitest unit tests for the schema
  fields.tsx       # accessible field primitives (label/error/aria wiring)
  submit.ts        # FormData builder + fetch with configurable 60s default timeout
  ContactForm.tsx  # the form component (progressive disclosure, states, honeypot)
  main.tsx         # self-mounting entry point (reads data attributes)
  styles.css       # layout-only widget CSS (Webflow owns field/button visuals)
index.html         # dev harness with a mocked backend + the Webflow stylesheet
vite.config.ts     # single-file IIFE build (CSS injected by JS)
```
