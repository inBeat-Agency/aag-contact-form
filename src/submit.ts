import type { ContactFormFields } from "./schema";
// Cross-boundary import, and deliberately so. `toZapierPayload` belongs to the
// Cloudflare Worker; it lives under `worker/` because that is where it will run.
// The widget borrows it only while the Worker is paused — see TEMPORARY below.
import { toZapierPayload } from "../worker/src/payload";

/** Upload-safe wall-clock default for the submission request. */
export const SUBMIT_TIMEOUT_MS = 60_000;

export type SubmitOutcome = "success" | "error";

export type SubmitOptions = {
  /**
   * ISO-8601 submission timestamp. Injected rather than read from the clock
   * inside the transform so tests stay deterministic. Defaults to now.
   */
  submittedAt?: string;
  /** Abort deadline for the request. Defaults to {@link SUBMIT_TIMEOUT_MS}. */
  timeoutMs?: number;
};

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
 * TEMPORARY — the widget talks to the Zapier Catch Hook directly.
 * ===========================================================================
 *
 * DO NOT "clean this up" into JSON. Read this first; every alternative below
 * has already been tried and is broken for a specific, verified reason.
 *
 *   1. `multipart/form-data` (what this widget used to send) — Zapier does not
 *      accept it. It only accepts XML, JSON or URL-encoded bodies. Multipart is
 *      SILENTLY DISCARDED **and Zapier still answers HTTP 200 with
 *      {"status":"success"}**. So the widget shows the success panel, the team
 *      believes delivery works, and every single lead is dropped. A green
 *      response here is not evidence of anything.
 *
 *   2. `application/json` — impossible from a browser. That content type is not
 *      CORS-safelisted, so the browser fires a preflight `OPTIONS` request first
 *      and Zapier never answers it. The request dies before Zapier sees a byte.
 *      Zapier's own docs say: "do not set a custom Content-Type header."
 *
 *   3. `application/x-www-form-urlencoded` — the ONLY option left. It is on
 *      Zapier's accepted list AND it is CORS-safelisted, so there is no
 *      preflight. That intersection is exactly one content type wide.
 *
 * THE SINGLE MOST BREAKABLE THING HERE: we never set a `Content-Type` header.
 * Passing a `URLSearchParams` body makes the browser set
 * `application/x-www-form-urlencoded;charset=UTF-8` on its own. Setting it by
 * hand — even to that same value — turns the request into a preflighted one and
 * breaks CORS against Zapier. `src/submit.test.ts` guards this explicitly.
 *
 * RESUME FILES ARE NOT DELIVERED. A URL-encoded body cannot carry a binary, and
 * there is nowhere to upload it to yet. We send the real `resumeFileName` and
 * leave `resumeUrl` empty on purpose: that pair is an honest, greppable signal
 * in Zapier meaning "a resume submission arrived, the file is still pending".
 * We do not fabricate a URL that resolves to nothing.
 *
 * INTERIM UNTIL THE WORKER EXISTS. The target architecture is
 * widget --multipart--> Cloudflare Worker --JSON--> Zapier, with the Worker
 * uploading the resume to object storage. That Worker is paused. When it lands,
 * the `worker/src/payload` import above disappears and this goes back to posting
 * `formData` untouched.
 * =========================================================================== */

/**
 * Convert the widget's multipart body into the URL-encoded body Zapier accepts.
 *
 * `buildFormData()` stays the input format: it is the widget's contract with the
 * Worker, and `worker/src/payload.test.ts` drives the transform from it.
 */
function toZapierBody(formData: FormData, submittedAt: string): URLSearchParams {
  const resume = formData.get("resume");

  const payload = toZapierPayload(formData, {
    // The browser knows the file name; nothing has uploaded the bytes.
    resumeFileName: resume instanceof File ? resume.name : "",
    resumeUrl: "",
    submittedAt,
  });

  // URLSearchParams over a flat all-strings record. The transform already
  // guarantees the resume binary is not in `payload`.
  return new URLSearchParams(payload);
}

/**
 * POST the payload to the endpoint with an AbortController-based timeout.
 * Returns "success" on a 2xx response, "error" otherwise (including network
 * failures and timeouts). Never throws.
 *
 * Caveat inherited from the transport above: a 2xx from Zapier proves the
 * request was accepted, NOT that the lead was recorded.
 */
export async function submitContactForm(
  endpoint: string,
  formData: FormData,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const {
    submittedAt = new Date().toISOString(),
    timeoutMs = SUBMIT_TIMEOUT_MS,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      // No `headers` key. See TEMPORARY above — setting Content-Type here is
      // what breaks CORS against Zapier.
      body: toZapierBody(formData, submittedAt),
      signal: controller.signal,
    });
    return response.ok ? "success" : "error";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}
