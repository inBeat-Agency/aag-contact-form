/**
 * Deliver a validated resume to AAG staff as an email attachment, via Resend.
 *
 * WHY THIS EXISTS. Every stored CV is already reachable at `GET /resume/<key>`,
 * behind HTTP Basic Auth. That route is the archive, and it is not going away —
 * but it makes reading a CV a deliberate act: find the lead, find the link,
 * present a shared credential. Staff asked for the file to arrive where they
 * already are, so this module mails the ORIGINAL bytes, under the ORIGINAL file
 * name, to one fixed address.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A NOTIFICATION, NOT THE DELIVERY CONTRACT. READ THIS BEFORE CHANGING
 * ANYTHING HERE.
 * ---------------------------------------------------------------------------
 * The submission is DELIVERED when R2 has the file and Zapier has the lead.
 * This email is a convenience laid on top of a journey that already succeeded,
 * so nothing in this module may turn a stored-and-forwarded submission into a
 * user-visible failure. A candidate who sees an error submits again, and one
 * refusal becomes duplicate leads plus a false failure report — the failure this
 * whole Worker was built to eliminate.
 *
 * Hence the return type. {@link sendResumeEmail} NEVER throws and NEVER returns
 * an {@link ErrorCode}: every ending, including a rejected promise, collapses to
 * one member of a closed enum the caller can only log.
 *
 * ---------------------------------------------------------------------------
 * NOTHING FROM THE FAILURE PATH ESCAPES THIS FILE.
 * ---------------------------------------------------------------------------
 * The caught error, the response body, the status code, the request we sent and
 * the API key are all dropped rather than returned, wrapped or logged. A Resend
 * 4xx body echoes back the payload it rejected — which is a candidate's name,
 * their address and their CV — and a thrown fetch error can name the endpoint
 * and the credential. {@link ResumeEmailOutcome} is fixed text chosen here, so
 * there is no expression in this module through which any of that can travel.
 */

/**
 * Resend's transactional send endpoint.
 *
 * The REST API is used directly rather than the `resend` SDK. The SDK exists to
 * wrap one POST with one JSON body; adding a dependency to the Worker bundle for
 * that is cost without benefit, and this repo has no other runtime dependency in
 * `worker/` at all.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The verified sender. `forms.alphaapexgroup.com` is DNS-verified in Resend, and
 * a `from` outside a verified domain is refused by the API.
 */
export const RESUME_EMAIL_FROM =
  "AAG Website <resumes@forms.alphaapexgroup.com>";

/** The one inbox resumes are delivered to. */
export const RESUME_EMAIL_TO = "hello@alphaapexgroup.com";

/** Prefix of the subject line, so an inbox filter has something stable to match. */
export const RESUME_EMAIL_SUBJECT_PREFIX = "Resume submission: ";

/**
 * How one attempt ended. The complete set, and every member is safe to log.
 *
 * These are DIAGNOSTIC, not error codes: none of them ever reaches a client, and
 * none is derived from anything the remote end said. They are four fixed strings
 * naming four genuinely different operational problems:
 *
 *   - `delivered`    Resend accepted the message (2xx).
 *   - `rejected`     Resend answered and refused (3xx/4xx/5xx). Look at the key,
 *                    the verified domain, or the payload size.
 *   - `errored`      The attempt threw before an answer arrived — the network,
 *                    or the file could not be read back and encoded.
 *   - `unconfigured` No API key on a deploy that just took a resume. Nobody is
 *                    getting these emails and nothing else would ever say so.
 *
 * `unconfigured` is a member rather than a silent no-op ON PURPOSE. A secret
 * that was never set would otherwise mean "this feature is quietly off, forever"
 * — the same shape as the provisioning mistake that made this Worker necessary.
 */
export type ResumeEmailOutcome =
  | "delivered"
  | "rejected"
  | "errored"
  | "unconfigured";

export type ResumeEmailMessage = {
  /** Candidate's display name, used in the subject and the body. */
  candidateName: string;
  /** Candidate's work email, as submitted. */
  candidateEmail: string;
  /** ISO-8601 instant, the same one stored on the R2 object. */
  submittedAt: string;
  /** The validated upload. Its bytes and name are sent unmodified. */
  file: File;
};

/** Used when a supplied name is absent or sanitises away to nothing. */
const UNNAMED_CANDIDATE = "candidate";

/** Used when a stored file name sanitises away to nothing. */
const FALLBACK_ATTACHMENT_NAME = "resume";

/**
 * Strip the characters that have meaning to a mail header, and nothing else.
 *
 * Everything interpolated below is candidate-supplied: the name they typed, the
 * address they typed, the file they named. The subject and the attachment file
 * name both become MIME headers at Resend's end, and a CR or LF inside one
 * splits the header block — the same injection `sanitizeFileName` closes on the
 * `Content-Disposition` of a download.
 *
 * ONLY control characters are removed, deliberately. A resume file name has no
 * legitimate use for one, so nothing real is lost; stripping quotes or
 * backslashes as well would silently rewrite legitimate names, and the request
 * to preserve the original file name is explicit.
 */
function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/**
 * Bytes per `String.fromCharCode` call while building the base64 input.
 *
 * A resume may be 10MB, and `String.fromCharCode(...bytes)` on that many
 * arguments overflows the call stack. Appending one character at a time avoids
 * the overflow and is far slower on a body this size, so the array is walked in
 * fixed windows instead. 32768 is comfortably inside every engine's argument
 * limit.
 */
const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Base64 the file bytes EXACTLY as they were validated and stored.
 *
 * No transcoding, no re-encoding, no conversion to PDF. Whatever the candidate
 * uploaded is what lands in the mailbox, byte for byte, which is what makes the
 * attachment interchangeable with the R2 object it was stored from.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
    );
  }
  return btoa(binary);
}

/**
 * PLAIN TEXT ONLY, AND NO LINKS AT ALL.
 *
 * No HTML part is sent, so there is no markup for a candidate-supplied value to
 * break out of — the injection surface is removed rather than escaped.
 *
 * There is deliberately no resume URL in here either. Resend rewrites links when
 * click tracking is enabled on a domain, which is a dashboard setting this code
 * cannot read: the one link worth including is the gated URL of a candidate's
 * CV, and routing that through a tracking redirector is not a trade worth making
 * for a fallback the Zapier record already carries.
 */
function bodyText(
  candidateName: string,
  candidateEmail: string,
  submittedAt: string,
  fileName: string,
): string {
  return [
    "A new resume was submitted through the Alpha Apex Group website.",
    "",
    `Name: ${candidateName}`,
    `Email: ${candidateEmail}`,
    `Submitted: ${submittedAt}`,
    `File: ${fileName}`,
    "",
    "The resume is attached to this message.",
  ].join("\n");
}

/**
 * Application deadline for one send attempt, in milliseconds.
 *
 * The submit handler AWAITS this call before answering the candidate, so a
 * Resend request that never resolves would hang a submission whose CV is
 * already in R2 and whose lead is already in Zapier — the one thing this
 * module exists to never do. `fetch` has no deadline of its own, so one is
 * applied explicitly: on expiry the attempt rejects with a `TimeoutError`,
 * the catch below collapses it to `errored`, and the candidate's response is
 * exactly what a healthy submission produces.
 */
const RESUME_EMAIL_TIMEOUT_MS = 10_000;

/**
 * Mail one validated resume, and report how it went.
 *
 * NEVER THROWS. See the notification contract at the top of this file: the
 * caller has already stored the CV and delivered the lead, so there is no
 * failure here worth failing that journey over.
 *
 * BOUNDED. The attempt carries an abort timeout ({@link RESUME_EMAIL_TIMEOUT_MS})
 * because the caller awaits it before responding: an unanswered request must
 * cost the notification, never the submission's answer.
 *
 * REDIRECTS ARE NEVER FOLLOWED, and that is a security control rather than a
 * preference — the same one `forwardToZapier` applies, for a stronger reason. A
 * custom `Authorization` header is not stripped on a cross-origin hop, so a
 * followed redirect would hand the Resend API key to whatever the `Location`
 * names. With `manual` a 3xx comes back as a 3xx, `response.ok` is false, and
 * the attempt fails closed with no second hop to leak to.
 */
export async function sendResumeEmail(
  apiKey: string,
  message: ResumeEmailMessage,
): Promise<ResumeEmailOutcome> {
  try {
    // FAIL CLOSED, AND ONLY FOR THE EMAIL. An unset Worker secret arrives as
    // `undefined` and a blank one is what `wrangler secret put` stores for an
    // empty value; neither is a configured deploy, and interpolating either into
    // the bearer header would send a candidate's CV at an anonymous request that
    // Resend answers 401. Refusing to attempt is loud (the caller logs this) and
    // costs the submission nothing.
    //
    // INSIDE THE TRY, AND COERCED RATHER THAN TRUSTED. "Never throws" is a
    // runtime promise, and the parameter's TYPE cannot keep it: a Worker binding
    // is whatever the platform hands over, and `undefined.trim()` is a
    // TypeError thrown out of a function whose caller has already answered the
    // candidate 200. `String(x ?? "")` turns every non-string into a value this
    // guard can read, and the try catches even a hostile `toString`. The
    // signature stays `string`, so nothing is weakened for callers that type-check.
    if (String(apiKey ?? "").trim() === "") return "unconfigured";

    const candidateName = singleLine(message.candidateName) || UNNAMED_CANDIDATE;
    const fileName = singleLine(message.file.name) || FALLBACK_ATTACHMENT_NAME;
    const content = toBase64(new Uint8Array(await message.file.arrayBuffer()));

    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      redirect: "manual",
      // BOUNDED, so a Resend request that never answers cannot hang the
      // submission the caller is holding open. Expiry lands in the catch
      // below as `errored`, like every other thrown failure.
      signal: AbortSignal.timeout(RESUME_EMAIL_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESUME_EMAIL_FROM,
        to: [RESUME_EMAIL_TO],
        subject: `${RESUME_EMAIL_SUBJECT_PREFIX}${candidateName}`,
        text: bodyText(
          candidateName,
          singleLine(message.candidateEmail),
          singleLine(message.submittedAt),
          fileName,
        ),
        attachments: [{ filename: fileName, content }],
      }),
    });

    // `ok` is 200-299 only, so every 3xx lands here as a refusal.
    return response.ok ? "delivered" : "rejected";
  } catch {
    // The caught error is deliberately dropped rather than logged, wrapped or
    // returned: it can carry the endpoint, the bearer header and the request we
    // just built out of a candidate's CV.
    return "errored";
  }
}
