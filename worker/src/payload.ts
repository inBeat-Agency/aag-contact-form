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
 * | `companySize`      | Consulting, Recruitment / Hiring                     |
 * | `estimatedBudget`  | Consulting, Recruitment / Hiring                     |
 * | `expectedTimeline` | Consulting, Recruitment / Hiring                     |
 * | `message`          | always                                               |
 * | `resumeUrl`        | Submit Resume                                        |
 * | `resumeFileName`   | Submit Resume                                        |
 * | `source`           | when the embed sets `data-source`                    |
 * | `submittedAt`      | always                                               |
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
    companySize: readText(formData, "companySize"),
    estimatedBudget: readText(formData, "estimatedBudget"),
    expectedTimeline: readText(formData, "expectedTimeline"),
    message: readText(formData, "message"),
    resumeUrl: options.resumeUrl ?? "",
    resumeFileName: options.resumeFileName ?? "",
    source: readText(formData, "source"),
    submittedAt: options.submittedAt,
  };
}
