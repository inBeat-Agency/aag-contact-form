# AAG Contact Us Widget

A standalone, embeddable **Contact Us** form for the Alpha Apex Group Webflow
site. It is a single React app compiled to one self-mounting IIFE bundle. CSS is
injected at runtime, so embedding requires only one `<div>` and one `<script>`.

The form uses progressive disclosure: only the **Inquiry type** select shows
until a type is chosen, then the relevant fields appear in a single form (not a
multi-step wizard).

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

Drop the mount div wherever the form should appear, then load the script (host
the built file on a CDN / Cloudflare Pages and reference the versioned URL):

```html
<div
  id="aag-contact-form"
  data-endpoint="https://api.alphaapexgroup.com/contact"
  data-source="webflow/contact-page"
></div>

<!-- Bump the ?v= query when you deploy a new build to bust caches. -->
<script src="https://your-cdn.example.com/aag-contact-form.js?v=2026-07-21" defer></script>
```

- `data-endpoint` **(required)** — URL the form POSTs to. If missing, the widget
  does not mount.
- `data-source` *(optional)* — free-form string forwarded in the payload (use it
  to identify the page/placement).

The script is safe to place in the site `<head>`: it waits for
`DOMContentLoaded` and does nothing if the mount div is absent.

### Theming

The widget is width-fluid and fills its container. Two-column rows collapse to a
single column below a ~560px container width. Override the accent (or other
tokens) by setting CSS custom properties on the mount div:

```css
#aag-contact-form {
  --aag-form-accent: #1928c8;
  --aag-form-radius: 10px;
}
```

All classes are prefixed `aag-form-` to avoid colliding with Webflow styles.

## Cloudflare Pages deploy

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 18+ |

After deploy, reference `https://<project>.pages.dev/aag-contact-form.js` (with a
`?v=` cache-buster) in the Webflow embed.

## API contract

The form sends `multipart/form-data` (a `FormData` body) via `POST` to
`data-endpoint`. A 2xx response is treated as success; anything else shows the
error banner. Requests time out after 15s.

Flat, camelCase keys. Optional fields are omitted when empty.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inquiryType` | string | always | One of: `Recruitment / Hiring`, `Consulting`, `General Question`, `Submit Resume` |
| `firstName` | string | always | |
| `lastName` | string | always | |
| `workEmail` | string | always | Valid email |
| `message` | string | always | Textarea contents |
| `title` | string | business types | Present for Consulting, Recruitment / Hiring, Submit Resume |
| `company` | string | business types | Same as above |
| `phone` | string | optional | Loosely validated |
| `companySize` | string | optional | `1-50`, `51-200`, `201-1,000`, `1,000+` |
| `estimatedBudget` | string | optional | Consulting / Recruitment only: `$30k or less`, `$30k - $50k`, `$50k - $100k`, `Greater than $100k` |
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
  submit.ts        # FormData builder + fetch with 15s timeout
  ContactForm.tsx  # the form component (progressive disclosure, states, honeypot)
  main.tsx         # self-mounting entry point (reads data attributes)
  styles.css       # aag-form- prefixed styles, custom properties, container query
index.html         # dev harness with a mocked backend
vite.config.ts     # single-file IIFE build (CSS injected by JS)
```
