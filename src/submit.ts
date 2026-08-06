import type { ContactFormFields } from "./schema";

/** Upload-safe wall-clock default for the submission request. */
export const SUBMIT_TIMEOUT_MS = 60_000;

/**
 * The outcome of a submission.
 *
 * `success` is a claim the WORKER made about itself, never an inference the
 * widget drew from a status line — see {@link submitContactForm}. `resumeUrl`
 * is whatever the Worker stored the file under, or `""` for an inquiry that
 * carried no resume.
 */
export type SubmitResult =
  | { outcome: "success"; resumeUrl: string }
  | { outcome: "error" };

/**
 * Build the multipart payload sent to the backend. Fields are flat camelCase
 * keys so the backend contract is simple. Empty optional values are omitted so
 * the server receives a clean payload. The resume File is appended only when
 * present.
 */
export function buildFormData(
  values: ContactFormFields,
  source: string | null,
): FormData {
  const data = new FormData();

  const appendIfPresent = (key: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) data.append(key, trimmed);
  };

  data.append("inquiryType", values.inquiryType);
  data.append("firstName", values.firstName.trim());
  data.append("lastName", values.lastName.trim());
  data.append("workEmail", values.workEmail.trim());
  data.append("message", values.message.trim());

  appendIfPresent("title", values.title);
  appendIfPresent("company", values.company);
  appendIfPresent("phone", values.phone);
  appendIfPresent("companySize", values.companySize);
  appendIfPresent("estimatedBudget", values.estimatedBudget);
  appendIfPresent("expectedTimeline", values.expectedTimeline);

  const resume = values.resume instanceof File ? values.resume : values.resume?.[0];
  if (resume) data.append("resume", resume, resume.name);

  if (source) data.append("source", source);

  return data;
}

/* ===========================================================================
 * TRANSPORT — multipart, straight to the Cloudflare Worker.
 * ===========================================================================
 *
 * The widget posts the `FormData` from `buildFormData()` unchanged. The Worker
 * parses the multipart body, uploads the resume to object storage, and forwards
 * the flat 15-key JSON that `worker/src/payload.ts` produces. That transform is
 * SERVER-SIDE and must stay there: it is the only place that knows the stored
 * resume URL, and posting a flat body from the browser is what drops the file.
 *
 * DO NOT post directly to Zapier from here. That was tried:
 *
 *   1. `multipart/form-data` to Zapier — silently DISCARDED, and Zapier still
 *      answers HTTP 200 with {"status":"success"}. Every lead dropped while the
 *      widget shows the success panel.
 *   2. `application/json` from a browser — not CORS-safelisted, so the browser
 *      preflights and Zapier never answers the OPTIONS.
 *   3. `application/x-www-form-urlencoded` — the interim transport. It works,
 *      but a URL-encoded body cannot carry a binary, so the resume was never
 *      delivered at all. That is what this Worker exists to fix.
 *
 * THE SINGLE MOST BREAKABLE THING HERE: we never set a `Content-Type` header.
 * The browser derives `multipart/form-data; boundary=…` from the `FormData`
 * body, and only the browser knows that boundary. Setting the header by hand
 * strips it, and the Worker then cannot parse a single field. Multipart is also
 * CORS-safelisted, so leaving it alone means no preflight `OPTIONS` ever fires
 * against the Worker. `src/submit.test.ts` guards this explicitly.
 * =========================================================================== */

/**
 * POST the multipart payload to the endpoint with an AbortController-based
 * timeout. Never throws.
 *
 * A 2xx proves a response ARRIVED. It does not prove our Worker produced it, and
 * it does not prove the lead was recorded — an intercepting proxy, a parked
 * domain, a stale Zapier hook and a captive portal all answer 200 with an HTML
 * body. So success additionally requires the Worker to say so in a JSON body
 * carrying `ok: true`. Anything else — non-JSON, a non-object, a missing `ok`,
 * a falsy `ok` — is an error. There is no tolerant parsing and no defaulting.
 */
export async function submitContactForm(
  endpoint: string,
  formData: FormData,
  timeoutMs = SUBMIT_TIMEOUT_MS,
): Promise<SubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      // No `headers` key. See TRANSPORT above — setting Content-Type here strips
      // the multipart boundary and the Worker parses nothing.
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) return { outcome: "error" };

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { outcome: "error" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { outcome: "error" };
    }

    const body = parsed as { ok?: unknown; resumeUrl?: unknown };
    if (body.ok !== true) return { outcome: "error" };

    return {
      outcome: "success",
      resumeUrl: typeof body.resumeUrl === "string" ? body.resumeUrl : "",
    };
  } catch {
    return { outcome: "error" };
  } finally {
    clearTimeout(timer);
  }
}
