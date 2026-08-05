/**
 * Resume constraints, shared by the widget and the Worker.
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

/** Maximum accepted resume size, in bytes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Headroom above {@link MAX_RESUME_BYTES} for everything that travels ALONGSIDE
 * the file: multipart boundaries, per-part headers, the original file name and
 * the text fields.
 *
 * WHY THIS CONSTANT EXISTS. A `Content-Length` describes the whole request body,
 * not the file inside it. Comparing it directly against `MAX_RESUME_BYTES`
 * rejects an exactly-10MB resume every time, because the envelope always pushes
 * the body a little over. That is silent lead loss precisely at the documented
 * limit, which is the failure mode this project exists to remove.
 *
 * So the allowance is deliberately generous. The declared length is only an
 * optimization that avoids buffering an absurd body; it must never refuse
 * something that could still contain an acceptable file. The measured check on
 * the parsed file is the real gate.
 */
export const MULTIPART_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024; // 1MB

/** Largest declared request body that could still hold an acceptable resume. */
export const MAX_SUBMISSION_BODY_BYTES =
  MAX_RESUME_BYTES + MULTIPART_ENVELOPE_ALLOWANCE_BYTES;

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
 * An EMPTY MIME type is allowed on purpose. Some operating systems and browsers
 * report no type at all for a legitimate `.doc`, so treating empty as a
 * rejection would refuse real resumes. The extension and the magic bytes carry
 * the decision in that case.
 */
export function isAllowedResumeMimeType(mimeType: string): boolean {
  if (mimeType === "") return true;
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
