import { z } from "zod";

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

export const INQUIRY_TYPES = [
  "Recruitment / Hiring",
  "Consulting",
  "General Question",
  "Submit Resume",
] as const;

export type InquiryType = (typeof INQUIRY_TYPES)[number];

export const COMPANY_SIZES = ["1-50", "51-200", "201-1,000", "1,000+"] as const;

export const BUDGETS = [
  "$30k or less",
  "$30k - $50k",
  "$50k - $100k",
  "Greater than $100k",
] as const;

export const TIMELINES = ["ASAP", "1-3 months", "1-6 months", "6+ months"] as const;

// File constraints for the Submit Resume flow.
export const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10MB

export const ALLOWED_RESUME_EXTENSIONS = [".pdf", ".doc", ".docx"] as const;

const ALLOWED_RESUME_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// ---------------------------------------------------------------------------
// Reusable primitives.
// ---------------------------------------------------------------------------

const requiredString = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`);

const workEmail = z
  .string({ required_error: "Work email is required" })
  .trim()
  .min(1, "Work email is required")
  .email("Enter a valid work email address");

// Phone is intentionally loose: optional, any non-empty free-form string is fine.
const optionalPhone = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

// Optional select: allow empty string (nothing chosen) or one of the options.
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.literal(""), z.enum(values)])
    .optional()
    .transform((value) => (value === "" ? undefined : value));

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
  .refine((file) => {
    const name = file.name.toLowerCase();
    const extOk = ALLOWED_RESUME_EXTENSIONS.some((ext) => name.endsWith(ext));
    const mimeOk = file.type === "" || ALLOWED_RESUME_MIME.has(file.type);
    return extOk && mimeOk;
  }, "Resume must be a PDF or Word document");

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
 * applies as an individual, so asking for their title, employer, and employer
 * headcount is noise we never act on.
 */
const companyDetailsShape = {
  title: requiredString("Title"),
  company: requiredString("Company"),
  companySize: optionalEnum(COMPANY_SIZES),
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
  estimatedBudget: optionalEnum(BUDGETS),
  expectedTimeline: optionalEnum(TIMELINES),
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
  companySize: string;
  estimatedBudget: string;
  expectedTimeline: string;
  message: string;
  resume: File | FileList | null;
  website: string; // honeypot
};
