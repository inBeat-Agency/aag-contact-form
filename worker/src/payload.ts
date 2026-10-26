/**
 * Widget FormData -> Zapier JSON transform.
 *
 * Why this exists: the client's backend is a Zapier Catch Hook, and Zapier only
 * accepts XML, JSON or URL-encoded bodies. It silently discards
 * `multipart/form-data` **and still answers HTTP 200**, so an unconverted
 * submission looks successful to the widget while the lead is dropped. A
 * Cloudflare Worker sits between the widget and Zapier: it receives the
 * multipart body, uploads the resume to object storage, and forwards the flat
 * JSON produced here.
 *
 * This module is deliberately pure and dependency-free: no fetch, no clock, no
 * imports from `src/` (which would drag React and zod into the Worker bundle).
 * Everything time- or upload-dependent arrives through `options` so the
 * contract tests stay deterministic.
 */

/**
 * The 22 attribution hidden fields (first touch, last touch, conversion), in
 * wire order. Appended to {@link ZAPIER_PAYLOAD_KEYS}.
 */
export const ATTRIBUTION_PAYLOAD_KEYS = [
  "ft_channel",
  "ft_source",
  "ft_medium",
  "ft_campaign",
  "ft_term",
  "ft_content",
  "ft_click_id",
  "ft_landing_page",
  "ft_referrer",
  "ft_date",
  "lt_channel",
  "lt_source",
  "lt_medium",
  "lt_campaign",
  "lt_term",
  "lt_content",
  "lt_click_id",
  "lt_landing_page",
  "lt_referrer",
  "lt_date",
  "conversion_page",
  "days_to_convert",
] as const;

export type AttributionPayloadKey = (typeof ATTRIBUTION_PAYLOAD_KEYS)[number];

/**
 * The wire contract, in the order Zapier receives it.
 *
 * | Key                | Populated for                                        |
 * | ------------------ | ---------------------------------------------------- |
 * | `inquiryType`      | always                                               |
 * | `firstName`        | always                                               |
 * | `lastName`         | always                                               |
 * | `workEmail`        | always                                               |
 * | `title`            | Consulting, Recruitment / Hiring                     |
 * | `company`          | Consulting, Recruitment / Hiring                     |
 * | `phone`            | Consulting, Recruitment / Hiring, Submit Resume      |
 * | `companySize`      | never — no longer collected, always empty            |
 * | `estimatedBudget`  | Consulting, Recruitment / Hiring                     |
 * | `expectedTimeline` | never — no longer collected, always empty            |
 * | `message`          | always                                               |
 * | `resumeUrl`        | Submit Resume                                        |
 * | `resumeFileName`   | Submit Resume                                        |
 * | `source`           | when the embed sets `data-source`                    |
 * | `submittedAt`      | always                                               |
 * | `ft_*` (10 keys)   | always; empty when the visitor's source is unknown   |
 * |                    | or the embed predates attribution                    |
 * | `lt_*` (10 keys)   | always; empty when the visitor's source is unknown   |
 * |                    | or the embed predates attribution                    |
 * | `conversion_page`  | always; empty when the embed predates attribution    |
 * | `days_to_convert`  | always; empty when the visitor's source is unknown   |
 * |                    | or the embed predates attribution                    |
 *
 * `companySize` and `expectedTimeline` were retired from the form because they
 * hurt conversion, but they REMAIN on the wire as constant empty strings. See
 * the note on {@link ZapierPayload}: removing a key the client's live Zap has
 * already mapped is what breaks it. Retired is not the same as removed.
 *
 * The first-touch (`ft_*`) and last-touch (`lt_*`) attribution keys are
 * APPENDED after `submittedAt`, never interleaved: the existing fifteen keep
 * their positions so the live Zap mapping is untouched.
 */
export const ZAPIER_PAYLOAD_KEYS = [
  "inquiryType",
  "firstName",
  "lastName",
  "workEmail",
  "title",
  "company",
  "phone",
  "companySize",
  "estimatedBudget",
  "expectedTimeline",
  "message",
  "resumeUrl",
  "resumeFileName",
  "source",
  "submittedAt",
  ...ATTRIBUTION_PAYLOAD_KEYS,
] as const;

export type ZapierPayloadKey = (typeof ZAPIER_PAYLOAD_KEYS)[number];

/**
 * Every key is always present and always a string. Inapplicable fields carry
 * the empty string rather than being omitted or set to null.
 *
 * This is not accidental verbosity. Zapier builds its field-mapping picker from
 * whichever sample payload it happened to receive, so a payload that drops keys
 * for a General Question would leave the Consulting fields unmappable. One
 * stable, complete schema means one Zap mapping works for all four inquiry
 * types. Do not "clean up" this payload by pruning empty keys.
 */
export type ZapierPayload = { [K in ZapierPayloadKey]: string };

export type ToZapierPayloadOptions = {
  /** Object-storage URL of the uploaded resume. Empty string when absent. */
  resumeUrl?: string;
  /** Original file name of the uploaded resume. Empty string when absent. */
  resumeFileName?: string;
  /** ISO-8601 timestamp. Injected so the transform stays deterministic. */
  submittedAt: string;
};

/**
 * Read a text entry, coercing anything missing — or anything that arrived as a
 * File — to the empty string. The File branch is what keeps the uploaded resume
 * out of the JSON: the Worker handles that binary separately and reports it
 * back through `resumeUrl` / `resumeFileName`.
 */
function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Convert the widget's multipart body into the flat Zapier payload.
 *
 * The returned object's key order matches {@link ZAPIER_PAYLOAD_KEYS}, so
 * `JSON.stringify` produces the same field order the golden fixtures in
 * `worker/fixtures/` document.
 */
export function toZapierPayload(
  formData: FormData,
  options: ToZapierPayloadOptions,
): ZapierPayload {
  return {
    inquiryType: readText(formData, "inquiryType"),
    firstName: readText(formData, "firstName"),
    lastName: readText(formData, "lastName"),
    workEmail: readText(formData, "workEmail"),
    title: readText(formData, "title"),
    company: readText(formData, "company"),
    phone: readText(formData, "phone"),
    // Retired, and therefore hardcoded rather than read. Do NOT "restore" these
    // to `readText()`: after a deploy, a cached copy of the previous widget
    // bundle (CDN edge or browser) keeps POSTing both keys, and reading them
    // would forward data the form no longer collects straight into the client's
    // live Zap — contradicting the retirement contract documented above. The
    // submission still succeeds; only these two values are dropped, because a
    // stale embed is a real lead we refuse to lose over a cache window.
    companySize: "",
    estimatedBudget: readText(formData, "estimatedBudget"),
    expectedTimeline: "",
    message: readText(formData, "message"),
    resumeUrl: options.resumeUrl ?? "",
    resumeFileName: options.resumeFileName ?? "",
    source: readText(formData, "source"),
    submittedAt: options.submittedAt,
    ...readAttribution(formData),
  };
}

/**
 * The 22 attribution fields, in contract order. A body from a cached
 * pre-attribution widget carries none of them, and each becomes "".
 */
function readAttribution(
  formData: FormData,
): { [K in AttributionPayloadKey]: string } {
  return {
    ft_channel: readText(formData, "ft_channel"),
    ft_source: readText(formData, "ft_source"),
    ft_medium: readText(formData, "ft_medium"),
    ft_campaign: readText(formData, "ft_campaign"),
    ft_term: readText(formData, "ft_term"),
    ft_content: readText(formData, "ft_content"),
    ft_click_id: readText(formData, "ft_click_id"),
    ft_landing_page: readText(formData, "ft_landing_page"),
    ft_referrer: readText(formData, "ft_referrer"),
    ft_date: readText(formData, "ft_date"),
    lt_channel: readText(formData, "lt_channel"),
    lt_source: readText(formData, "lt_source"),
    lt_medium: readText(formData, "lt_medium"),
    lt_campaign: readText(formData, "lt_campaign"),
    lt_term: readText(formData, "lt_term"),
    lt_content: readText(formData, "lt_content"),
    lt_click_id: readText(formData, "lt_click_id"),
    lt_landing_page: readText(formData, "lt_landing_page"),
    lt_referrer: readText(formData, "lt_referrer"),
    lt_date: readText(formData, "lt_date"),
    conversion_page: readText(formData, "conversion_page"),
    days_to_convert: readText(formData, "days_to_convert"),
  };
}
