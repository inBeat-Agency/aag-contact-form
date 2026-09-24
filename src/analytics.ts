/**
 * GTM / GA4 submission tracking.
 *
 * The widget intercepts the native submit and posts via `fetch`, so neither GTM's
 * built-in Form Submission trigger nor a page navigation ever fires. Instead the
 * widget pushes a custom `dataLayer` event after the Worker confirms the lead.
 *
 * PUBLIC CONTRACT WITH GTM (container GTM-59KZSPX7): the event name and the
 * parameter keys below are referenced by a Custom Event trigger and by GA4
 * event parameters / custom dimensions in GTM. Renaming any of them silently
 * breaks conversion tracking — update GTM in the same change.
 *
 * Never send PII here (names, email, phone, company, budget, message, resume).
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export const SUBMIT_EVENT = "aag_form_submit";

const MAX_INTEREST_LENGTH = 64;

export interface SubmissionDetails {
  inquiryType: string;
  source: string | null;
}

function readInterest(): string | undefined {
  const raw = new URLSearchParams(window.location.search).get("interest");
  const interest = raw?.trim().slice(0, MAX_INTEREST_LENGTH);
  return interest ? interest : undefined;
}

/**
 * Push one `aag_form_submit` event onto `window.dataLayer`. Never throws: the
 * widget runs inside a third-party page, and a broken or hostile `dataLayer`
 * must never affect a submission that already succeeded.
 */
export function trackSubmission({ inquiryType, source }: SubmissionDetails): void {
  try {
    const payload: Record<string, string> = {
      event: SUBMIT_EVENT,
      inquiry_type: inquiryType,
    };
    if (source) payload.form_source = source;
    const interest = readInterest();
    if (interest) payload.interest = interest;

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  } catch {
    // Tracking is best-effort; swallow everything.
  }
}
