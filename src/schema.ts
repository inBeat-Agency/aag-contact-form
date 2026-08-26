import { z } from "zod";

import {
  hasAllowedResumeExtension,
  isAllowedResumeMimeType,
  MAX_FILE_NAME_BYTES,
  MAX_RESUME_BYTES,
  MAX_TEXT_FIELD_CHARS,
  utf8ByteLength,
} from "../worker/src/limits";

/**
 * Single source of truth for the AAG Contact Us widget data contract.
 *
 * The backend team can copy this file (or just the exported types) to mirror
 * the payload shape. The form is a discriminated union on `inquiryType`:
 * each inquiry type shares a common base and adds its own required/optional
 * fields (progressive disclosure in one form, not a wizard).
 */

// ---------------------------------------------------------------------------
// Option constants (kept exported so the UI renders from the same source).
// ---------------------------------------------------------------------------

/**
 * RE-EXPORT, not a definition. The list lives in `worker/src/limits.ts` next to
 * the per-type field requirements the Worker enforces, so the form cannot offer
 * a category the server does not recognise.
 */
export { INQUIRY_TYPES, type InquiryType } from "../worker/src/limits";

import type { InquiryType } from "../worker/src/limits";

/**
 * Company Size and Expected Timeline used to live here. Both were dropped from
 * the engagement flows: they were left blank far more often than not, and the
 * longer form measurably hurt conversion against the much shorter candidate
 * flow. Their option lists are gone with them.
 *
 * `companySize` and `expectedTimeline` nonetheless remain on the Zapier wire as
 * permanently empty strings — see `worker/src/payload.ts`. That is a TRANSPORT
 * concern, not a form one, so nothing about it belongs in this file.
 *
 * Estimated Budget's option list (`BUDGETS`) is gone too, for a different
 * reason: the field is still collected, but as free text. A prospect who does
 * not recognise themselves in any of the five brackets we happened to pick
 * either skips the field or picks the wrong one, and a wrong bracket is worse
 * than a sentence we can read. See `optionalText` below for what replaced it.
 *
 * That leaves `INQUIRY_TYPES` as the only option constant this section still
 * carries, and it is a re-export rather than a definition — so if the next
 * fixed-choice field also becomes free text, delete this section rather than
 * leaving an empty heading behind.
 */

/**
 * File constraints for the Submit Resume flow.
 *
 * These are RE-EXPORTS, not definitions. The values live in
 * `worker/src/limits.ts` because the Worker re-validates every upload and its
 * copy is the authoritative one — a client can bypass everything in this file.
 * Keeping a second hardcoded copy here is how the form ends up promising a limit
 * the server does not honour, so do not inline them back.
 */
export {
  ALLOWED_RESUME_EXTENSIONS,
  MAX_RESUME_BYTES,
} from "../worker/src/limits";

// ---------------------------------------------------------------------------
// Reusable primitives.
// ---------------------------------------------------------------------------

/**
 * The shared per-field length cap, expressed for the form.
 *
 * The Worker enforces the same limit in BYTES, and the request-size ceiling it
 * uses is derived from it. If the form does not enforce this, that ceiling stops
 * being a bound and a legitimate submission can be refused before it is parsed.
 * `MAX_TEXT_FIELD_CHARS` is the byte cap divided by the widest possible UTF-8
 * code point, so this rule is provably the stricter of the two.
 */
const withinLengthCap = (label: string) => (schema: z.ZodString) =>
  schema.max(MAX_TEXT_FIELD_CHARS, `${label} is too long`);

const requiredString = (label: string) =>
  withinLengthCap(label)(
    z
      .string({ required_error: `${label} is required` })
      .trim()
      .min(1, `${label} is required`),
  );

const workEmail = withinLengthCap("Work email")(
  z
    .string({ required_error: "Work email is required" })
    .trim()
    .min(1, "Work email is required")
    .email("Enter a valid work email address"),
);

/**
 * An optional free-text field.
 *
 * Three behaviours travel together here, and separating them is how they drift:
 * `.trim()` so whitespace is not an answer, `.max()` so the value is bounded,
 * and the `"" -> undefined` transform so a skipped field is genuinely absent.
 * That last one is load-bearing: `appendIfPresent` in `src/submit.ts` omits
 * `undefined` from the multipart body, so a copy of this shape that forgot the
 * transform would send `""` and the Worker could no longer tell "not asked" from
 * "asked and left blank".
 *
 * `max` is a parameter rather than a constant because the shared cap is a
 * CEILING, not a default — see `MAX_BUDGET_CHARS`.
 */
const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .optional()
    .transform((value) => (value === "" ? undefined : value));

// Phone is intentionally loose: optional, any non-empty free-form string is fine.
const optionalPhone = optionalText("Phone", MAX_TEXT_FIELD_CHARS);

/**
 * Estimated Budget's own cap, deliberately far stricter than the shared one.
 *
 * `MAX_TEXT_FIELD_CHARS` (5461) exists to bound the REQUEST the Worker will
 * accept; it is not a claim about what any single field ought to hold. Estimated
 * Budget is a short answer — "around 60k, flexible" — and it lands in one Zapier
 * column a human scans at a glance. Allowing five thousand characters there
 * would let a prospect paste an entire brief into the field that is supposed to
 * answer "how much", which is a data-quality failure rather than a safety one:
 * nothing breaks, the column just stops being readable.
 *
 * The containment invariant documented above still holds, and holds trivially:
 * 100 < `MAX_TEXT_FIELD_CHARS`, so every value this field accepts is a value the
 * server accepts too. Tightening this number is always safe; raising it past the
 * shared cap is the one change that would break containment.
 */
export const MAX_BUDGET_CHARS = 100;

/**
 * Resume file validation. File inputs yield a FileList, so normalize its first
 * item before validating the File itself. We check both the extension and the
 * MIME type (MIME can be empty on some OSes, so extension is the reliable
 * signal) and enforce the size limit.
 */
function normalizeResumeFile(value: unknown) {
  if (typeof FileList !== "undefined" && value instanceof FileList) {
    return value.item(0) ?? undefined;
  }
  return value;
}

const resumeFile = z
  .custom<File>((value) => typeof File !== "undefined" && value instanceof File, {
    message: "Please upload your resume",
  })
  .refine((file) => file.size > 0, "Please upload your resume")
  .refine((file) => file.size <= MAX_RESUME_BYTES, "File must be 10MB or less")
  // The name rides inside the multipart envelope the Worker's size ceiling
  // accounts for, so it is bounded on both sides rather than just one.
  .refine(
    (file) => utf8ByteLength(file.name) <= MAX_FILE_NAME_BYTES,
    "File name is too long",
  )
  .refine(
    (file) =>
      hasAllowedResumeExtension(file.name) && isAllowedResumeMimeType(file.type),
    "Resume must be a PDF or Word document",
  );

export const resumeFileSchema = z.preprocess(normalizeResumeFile, resumeFile);

// ---------------------------------------------------------------------------
// Shared shapes.
// ---------------------------------------------------------------------------

// Fields present in every inquiry type.
const commonShape = {
  firstName: requiredString("First name"),
  lastName: requiredString("Last name"),
  workEmail,
  message: requiredString("Message"),
};

/**
 * Company details, collected only by the engagement flows (Consulting and
 * Recruitment / Hiring). Submit Resume deliberately omits these: a candidate
 * applies as an individual, so asking for their title and employer is noise we
 * never act on.
 */
const companyDetailsShape = {
  title: requiredString("Title"),
  company: requiredString("Company"),
};

// ---------------------------------------------------------------------------
// Per-inquiry-type schemas.
// ---------------------------------------------------------------------------

const generalQuestionSchema = z.object({
  inquiryType: z.literal("General Question"),
  ...commonShape,
});

// Consulting and Recruitment / Hiring share an identical field set.
const engagementShape = {
  ...commonShape,
  ...companyDetailsShape,
  phone: optionalPhone,
  estimatedBudget: optionalText("Estimated budget", MAX_BUDGET_CHARS),
};

const consultingSchema = z.object({
  inquiryType: z.literal("Consulting"),
  ...engagementShape,
});

const recruitmentSchema = z.object({
  inquiryType: z.literal("Recruitment / Hiring"),
  ...engagementShape,
});

// Candidates give us contact details and a file — no company details.
const submitResumeSchema = z.object({
  inquiryType: z.literal("Submit Resume"),
  ...commonShape,
  phone: optionalPhone,
  resume: resumeFileSchema,
});

// ---------------------------------------------------------------------------
// Discriminated union + exported types.
// ---------------------------------------------------------------------------

/**
 * The form renders the placeholder (`inquiryType: ""`) until a real type is
 * picked, so an unmatched discriminator is a state real users submit from.
 * Zod's default message for that case leaks the raw option list ("Invalid
 * discriminator value. Expected 'Recruitment / Hiring' | ..."), which is
 * user-hostile. Zod already reports the issue on the `inquiryType` path, so
 * overriding the message is enough to land friendly copy on the select.
 */
const inquiryTypeErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
    return { message: "Please select an inquiry type" };
  }
  return { message: ctx.defaultError };
};

export const contactFormSchema = z.discriminatedUnion(
  "inquiryType",
  [recruitmentSchema, consultingSchema, generalQuestionSchema, submitResumeSchema],
  { errorMap: inquiryTypeErrorMap },
);

/** Validated payload produced by the form (post-parse). */
export type ContactFormValues = z.infer<typeof contactFormSchema>;

/**
 * Superset of every possible field, used as the react-hook-form working shape.
 * The form always renders from this shape; the discriminated union narrows it
 * on submit. `source` and `website` (honeypot) are transport concerns and live
 * outside the validated schema.
 */
export type ContactFormFields = {
  inquiryType: InquiryType | "";
  firstName: string;
  lastName: string;
  workEmail: string;
  title: string;
  company: string;
  phone: string;
  estimatedBudget: string;
  message: string;
  resume: File | FileList | null;
  website: string; // honeypot
};
