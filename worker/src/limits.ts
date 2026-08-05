/**
 * Submission constraints, shared by the widget and the Worker.
 *
 * This module is the single source of truth for both sides. It lives under
 * `worker/` because the Worker's copy is the AUTHORITATIVE one — the widget's
 * checks exist to give a fast, friendly message, and a client can skip them
 * entirely. The widget imports from here so the two can never drift into a state
 * where the form promises something the server then refuses.
 *
 * It is deliberately pure: no fetch, no clock, no Workers-only globals, no
 * imports from `src/`. That is what lets it be bundled into the browser widget
 * and executed in workerd from the same file.
 *
 * ---------------------------------------------------------------------------
 * ON MAGIC BYTES: THIS IS A SPEED BUMP, NOT A SAFETY GUARANTEE.
 * ---------------------------------------------------------------------------
 * Sniffing the leading bytes raises the cost of uploading a trivially renamed
 * executable. It does NOT make an accepted file safe. A malicious PDF is a
 * perfectly valid PDF and passes every check in this file.
 *
 * Actual containment lives elsewhere and must not be traded away for confidence
 * in this function: the stored file is never rendered inline, and retrieval is
 * gated at the hostname edge. Do not let a green check here become the reason
 * someone relaxes either of those.
 */

/**
 * The inquiry types the form offers, and the discriminator the payload carries.
 *
 * This list is the SOURCE, and `src/schema.ts` re-exports it. Defining it in
 * both places is how the server ends up accepting a category no Zap branch
 * matches: an unrecognised discriminator used to sail through server-side
 * validation, be stored, be forwarded, and be answered 200.
 */
export const INQUIRY_TYPES = [
  "Recruitment / Hiring",
  "Consulting",
  "General Question",
  "Submit Resume",
] as const;

export type InquiryType = (typeof INQUIRY_TYPES)[number];

/** Text fields every inquiry type must carry. */
const COMMON_REQUIRED_TEXT_FIELDS = [
  "firstName",
  "lastName",
  "workEmail",
  "message",
] as const;

/**
 * Text fields a given inquiry type requires ON TOP of the common set.
 *
 * Consulting and Recruitment are engagements from a company, so the person's
 * title and employer are load-bearing for triage. Submit Resume deliberately
 * asks a candidate for neither - they apply as an individual - and its extra
 * requirement is the file itself, which is enforced separately because it is
 * not a text field.
 */
const ADDITIONAL_REQUIRED_TEXT_FIELDS: Record<InquiryType, readonly string[]> = {
  "Recruitment / Hiring": ["title", "company"],
  Consulting: ["title", "company"],
  "General Question": [],
  "Submit Resume": [],
};

export function isInquiryType(value: string): value is InquiryType {
  return (INQUIRY_TYPES as readonly string[]).includes(value);
}

/**
 * Every text field this inquiry type must carry, or `null` when the type itself
 * is not one we offer.
 *
 * `null` rather than an empty array on purpose: an unknown discriminator is a
 * rejection, and returning `[]` would make it indistinguishable from a type
 * that happens to require nothing extra.
 */
export function requiredTextFieldsFor(
  inquiryType: string,
): readonly string[] | null {
  if (!isInquiryType(inquiryType)) return null;
  return [
    ...COMMON_REQUIRED_TEXT_FIELDS,
    ...ADDITIONAL_REQUIRED_TEXT_FIELDS[inquiryType],
  ];
}

/**
 * A deliberately PERMISSIVE check that an address could be delivered to.
 *
 * This is intentionally looser than the widget's zod `.email()`, and the
 * direction matters: everything the form accepts, the server must accept too.
 * A server-side rule stricter than the client's produces the worst outcome this
 * project has - a candidate whose address passed validation in the browser,
 * whose submission was then refused, and who is never told why in terms they
 * can act on. `src/schema.test.ts` asserts that containment directly.
 *
 * So this rejects only what cannot possibly be routed: no `@`, nothing before
 * or after it, no dot in the domain, or whitespace anywhere.
 */
export function hasEmailShape(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Maximum accepted resume size, in bytes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Longest accepted value for a single text field, in UTF-8 BYTES.
 *
 * Text fields used to have no maximum at all, which is what made the request
 * ceiling below a fiction: a 4-byte PDF next to a 12MB message was refused as
 * `FILE_TOO_LARGE` even though the measured file was three orders of magnitude
 * under its cap. A limit nobody enforces cannot be used to derive a bound.
 */
export const MAX_TEXT_FIELD_BYTES = 16 * 1024; // 16KB, ~4000 words of prose

/**
 * The same limit expressed in the unit ZOD actually counts: UTF-16 code units,
 * which is what `String.length` returns.
 *
 * THE DIVISOR IS 3, NOT 4, and the reasoning is easy to get backwards. A 4-byte
 * UTF-8 character is a surrogate pair, so it costs 2 code units and weighs only
 * 2 bytes per unit. The true worst case is a 3-byte BMP character, which is a
 * single code unit weighing 3 bytes.
 *
 * Multiplying by 3 therefore bounds the bytes of any string the widget accepts,
 * making the widget's rule provably the STRICTER of the pair. That direction is
 * mandatory: a server stricter than the form refuses a submission the user was
 * already told was fine.
 */
export const MAX_TEXT_FIELD_CHARS = Math.floor(MAX_TEXT_FIELD_BYTES / 3);

/**
 * How many text fields a submission may carry. The widget sends thirteen; the
 * margin is for future fields, and the cap is what makes the payload budget
 * below an actual bound rather than an estimate.
 */
export const MAX_TEXT_FIELD_COUNT = 16;

/** Every text field at its cap, which is the worst legal text payload. */
export const MAX_TEXT_PAYLOAD_BYTES =
  MAX_TEXT_FIELD_BYTES * MAX_TEXT_FIELD_COUNT;

/**
 * Longest accepted original file name, in UTF-8 bytes.
 *
 * The name travels inside the multipart envelope, so leaving it unbounded
 * leaves the envelope unbounded, and the allowance below could then be
 * exceeded by a submission that broke no other rule.
 */
export const MAX_FILE_NAME_BYTES = 1024;

/**
 * Headroom for the multipart envelope itself: boundaries, per-part headers and
 * field names.
 *
 * A `Content-Length` describes the whole request body, not the file inside it.
 * Comparing it directly against {@link MAX_RESUME_BYTES} rejects an
 * exactly-10MB resume every time, because the envelope always pushes the body a
 * little over - silent lead loss at precisely the size the UI advertises.
 */
export const MULTIPART_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024; // 1MB

/**
 * Largest declared request body that could still hold a LEGAL submission.
 *
 * DERIVED, not guessed, and every term is separately enforced: the resume is
 * capped by measured size, the text payload by per-field and per-count limits,
 * the file name by its own cap, and the remainder is envelope overhead. So any
 * submission satisfying every declared rule fits underneath this number, and
 * the pre-parse fast path can only ever reject a request that was going to be
 * refused anyway.
 *
 * That property is the point, and it is asserted by measurement rather than
 * argument: the worker suite encodes the heaviest legal submission, weighs it,
 * and requires it to sit under this ceiling and come back 200.
 */
export const MAX_SUBMISSION_BODY_BYTES =
  MAX_RESUME_BYTES + MAX_TEXT_PAYLOAD_BYTES + MULTIPART_ENVELOPE_ALLOWANCE_BYTES;

/** UTF-8 weight of a string, which is what a request body actually carries. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const ALLOWED_RESUME_EXTENSIONS = [".pdf", ".doc", ".docx"] as const;

export const ALLOWED_RESUME_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * Leading bytes each accepted format really starts with.
 *
 * DOCX is a ZIP container and legacy DOC is an OLE2 compound file, so the
 * signatures are the container's, not the document's. That is also why this
 * check cannot distinguish a DOCX from any other ZIP.
 */
const RESUME_MAGIC_PREFIXES: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46], // "%PDF"
  [0x50, 0x4b, 0x03, 0x04], // ZIP container (DOCX)
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 compound file (DOC)
];

/** Bytes needed from the head of a file to evaluate every signature above. */
export const RESUME_MAGIC_BYTE_LENGTH = RESUME_MAGIC_PREFIXES.reduce(
  (longest, prefix) => Math.max(longest, prefix.length),
  0,
);

export function hasAllowedResumeExtension(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return ALLOWED_RESUME_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * MIME types that mean "nobody could work out what this is", both of which are
 * accepted rather than refused.
 *
 * Some operating systems and browsers report no type at all for a legitimate
 * `.doc` or `.pdf`. That empty string does NOT survive the wire: multipart
 * encodes an untyped part as `application/octet-stream`, so the widget sees ""
 * and the Worker sees `application/octet-stream` for the very same file.
 *
 * Treating either as a rejection means the form accepts a candidate's resume and
 * the server then refuses it - silent lead loss for everyone whose OS is quiet
 * about MIME types. The extension and the magic bytes carry the decision here;
 * neither is relaxed by this.
 */
const UNDETERMINED_MIME_TYPES = ["", "application/octet-stream"];

export function isAllowedResumeMimeType(mimeType: string): boolean {
  if (UNDETERMINED_MIME_TYPES.includes(mimeType)) return true;
  return (ALLOWED_RESUME_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** True when `head` starts with the signature of an accepted container. */
export function hasAllowedResumeMagicBytes(head: Uint8Array): boolean {
  return RESUME_MAGIC_PREFIXES.some(
    (prefix) =>
      head.length >= prefix.length &&
      prefix.every((byte, index) => head[index] === byte),
  );
}
