/**
 * Cloudflare Worker for the AAG contact form.
 *
 * `POST /submit` is PUBLIC by design and must never be covered by a Cloudflare
 * Access application — gating it means 100% lead loss. `GET /resume/<key>` will
 * be added in a later slice and is gated at the hostname edge, not in code.
 *
 * Two rules run through every response in this file:
 *
 *   1. Error bodies come EXCLUSIVELY from {@link ErrorCode}. A caught error is
 *      never wrapped, stringified or echoed back to the client.
 *   2. CORS headers are emitted on `/submit` only. `/resume` streams candidate
 *      CVs on the origin whose session is the staff Access identity; making that
 *      cross-origin readable would be a PII leak.
 */

import { toZapierPayload, type ZapierPayload } from "./payload";
import {
  hasAllowedResumeExtension,
  hasAllowedResumeMagicBytes,
  hasEmailShape,
  isAllowedResumeMimeType,
  MAX_FILE_NAME_BYTES,
  MAX_RESUME_BYTES,
  MAX_SUBMISSION_BODY_BYTES,
  MAX_TEXT_FIELD_BYTES,
  MAX_TEXT_FIELD_COUNT,
  MAX_TEXT_PAYLOAD_BYTES,
  requiredTextFieldsFor,
  RESUME_MAGIC_BYTE_LENGTH,
  utf8ByteLength,
} from "./limits";

export interface Env {
  RESUMES: R2Bucket;
  ALLOWED_ORIGIN: string;
  RESUME_HOST: string;
  RESUME_URL_BASE: string;
  ZAPIER_HOOK_URL: string;
  ZAPIER_SHARED_SECRET: string;
  ERASURE_SALT: string;
}

/**
 * The complete set of error bodies this Worker may produce. Adding a member is a
 * contract change: the post-deploy probe matches on `INVALID_SUBMISSION`, and
 * every value here is safe to show a stranger.
 */
export type ErrorCode =
  | "INVALID_SUBMISSION"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "STORAGE_FAILED"
  | "FORWARD_FAILED"
  | "NOT_FOUND";

const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_SUBMISSION: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  STORAGE_FAILED: 502,
  FORWARD_FAILED: 502,
  NOT_FOUND: 404,
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** CORS headers for `/submit` responses. Never applied to any other path. */
function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * A response plus the enum member that produced it.
 *
 * The code travels separately instead of being re-read off the body so the
 * single log line can name it without the router ever parsing its own output.
 */
type Routed = { response: Response; errorCode: ErrorCode | null };

function fail(
  code: ErrorCode,
  extraHeaders: Record<string, string> = {},
): Routed {
  return {
    response: new Response(JSON.stringify({ ok: false, error: code }), {
      status: ERROR_STATUS[code],
      headers: { ...JSON_HEADERS, ...extraHeaders },
    }),
    errorCode: code,
  };
}

/**
 * Bindings without which this Worker cannot do its job, and the enum member each
 * missing one reports.
 *
 * An unset Worker secret does NOT throw on access — it arrives as `undefined`.
 * Interpolated into a header that becomes the literal string "undefined": the
 * Zap's filter rejects it, the Catch Hook still answers 200, and the Worker
 * cheerfully reports `{"ok":true}` for a lead nobody received. A provisioning
 * mistake turning into a silent success is precisely the failure this Worker
 * exists to eliminate, so configuration is checked as configuration.
 *
 * A blank string is treated exactly like a missing one. `wrangler secret put`
 * with an empty value, or a var left as `""` in the TOML, is not a configured
 * deploy — and an empty ERASURE_SALT additionally throws a raw `DataError` out
 * of `importKey`, escaping both the error enum and the log allowlist.
 */
const MANDATORY_BINDINGS = [
  ["ZAPIER_HOOK_URL", "FORWARD_FAILED"],
  ["ZAPIER_SHARED_SECRET", "FORWARD_FAILED"],
  ["ERASURE_SALT", "STORAGE_FAILED"],
] as const satisfies readonly (readonly [keyof Env, ErrorCode])[];

/** The enum member for the first unusable binding, or null when all are set. */
function misconfiguredBinding(env: Env): ErrorCode | null {
  for (const [name, code] of MANDATORY_BINDINGS) {
    if (String(env[name] ?? "").trim() === "") return code;
  }
  return null;
}

const RESUME_INQUIRY_TYPE = "Submit Resume";

function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Authoritative field validation, driven by the shared contract.
 *
 * This used to check five common fields for non-emptiness and stop, which meant
 * `inquiryType: "Bogus"` with `workEmail: "not-an-email"` was stored, forwarded
 * and answered 200: a lead nobody can reply to, filed under a category no Zap
 * branch matches. Neither the discriminator nor the per-type requirements were
 * enforced anywhere except the browser, and the browser is skippable.
 *
 * The requirements come from `./limits`, which the widget's schema is also built
 * from, so a field cannot be mandatory on one side and optional on the other.
 */
/**
 * Enforce the text limits the request ceiling is derived from.
 *
 * Without these the ceiling is a fiction: unbounded text meant a request could
 * be refused as FILE_TOO_LARGE while the measured file was far under its cap.
 * Counting entries as well as bytes is what turns the payload budget into an
 * actual bound - a hundred small fields would otherwise slip past a per-field
 * check and still add up to an unbounded body.
 */
function validateTextSize(formData: FormData): ErrorCode | null {
  let count = 0;
  let total = 0;

  for (const [, value] of formData.entries()) {
    if (typeof value !== "string") continue;

    count += 1;
    if (count > MAX_TEXT_FIELD_COUNT) return "INVALID_SUBMISSION";

    const bytes = utf8ByteLength(value);
    if (bytes > MAX_TEXT_FIELD_BYTES) return "INVALID_SUBMISSION";

    total += bytes;
    if (total > MAX_TEXT_PAYLOAD_BYTES) return "INVALID_SUBMISSION";
  }

  return null;
}

function validateFields(formData: FormData): ErrorCode | null {
  const oversized = validateTextSize(formData);
  if (oversized !== null) return oversized;

  const required = requiredTextFieldsFor(readText(formData, "inquiryType"));
  if (required === null) return "INVALID_SUBMISSION";

  for (const field of required) {
    if (readText(formData, field) === "") return "INVALID_SUBMISSION";
  }

  if (!hasEmailShape(readText(formData, "workEmail"))) {
    return "INVALID_SUBMISSION";
  }

  return null;
}

/**
 * Decide whether the declared body size alone is enough to refuse the request.
 *
 * The header is attacker-controlled, so it is treated as an OPTIMIZATION and
 * never as the gate: it can only cause an early rejection, never an early
 * acceptance. A missing or non-numeric value deliberately falls through to the
 * parser and the measured check in {@link validateResume}.
 *
 * Rejecting on a MISSING header was considered and refused: it would silently
 * refuse a legitimate chunked client, and silent lead loss is the exact failure
 * this Worker exists to eliminate. The platform still caps request bodies well
 * above our limit, so the residual exposure is bounded rather than unbounded.
 *
 * The comparison is against MAX_SUBMISSION_BODY_BYTES, not MAX_RESUME_BYTES:
 * the header measures the whole multipart envelope, so comparing it to the file
 * cap would reject every resume sent at exactly the documented limit.
 */
function declaredBodyExceedsCap(request: Request): boolean {
  const header = request.headers.get("Content-Length");
  if (header === null) return false;

  const declared = Number(header);
  if (!Number.isFinite(declared)) return false;

  return declared > MAX_SUBMISSION_BODY_BYTES;
}

/**
 * Authoritative server-side resume validation on MEASURED bytes.
 *
 * The widget runs equivalent checks for a fast, friendly message, and none of
 * that is trusted here: a client can post straight to this endpoint.
 */
async function validateResume(file: File): Promise<ErrorCode | null> {
  if (file.size > MAX_RESUME_BYTES) return "FILE_TOO_LARGE";

  // Bounded because the name rides inside the multipart envelope, and an
  // unbounded envelope makes the request ceiling unprovable.
  if (utf8ByteLength(file.name) > MAX_FILE_NAME_BYTES) {
    return "INVALID_SUBMISSION";
  }

  if (
    !hasAllowedResumeExtension(file.name) ||
    !isAllowedResumeMimeType(file.type)
  ) {
    return "UNSUPPORTED_FILE_TYPE";
  }

  const head = new Uint8Array(
    await file.slice(0, RESUME_MAGIC_BYTE_LENGTH).arrayBuffer(),
  );
  if (!hasAllowedResumeMagicBytes(head)) return "UNSUPPORTED_FILE_TYPE";

  return null;
}

/**
 * Candidate-level erasure index: `HMAC-SHA-256(normalised email, ERASURE_SALT)`.
 *
 * Storing the address itself would put PII in object metadata; storing a plain
 * digest would let anyone confirm a guessed address. The salted HMAC lets us
 * answer "delete everything belonging to this person" by recomputing the hash
 * and matching it, and is reversible only to whoever holds the salt.
 *
 * Case and surrounding whitespace are normalised first, or the same person
 * typing their address differently on two submissions produces two hashes and a
 * deletion request silently misses one of them.
 */
async function computeSubjectHash(email: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(email.trim().toLowerCase()),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Base for resume URLs, read from configuration.
 *
 * There is deliberately NO source-level fallback hostname. Hostnames are
 * configuration; hardcoding one here would mean the pending domain migration
 * needs a code change, and a stale literal would hand staff links to the wrong
 * origin.
 */
function resumeUrlBase(env: Env): string {
  return (env.RESUME_URL_BASE ?? "").trim().replace(/\/+$/, "");
}

type StoredResume = { resumeUrl: string; resumeFileName: string };

/**
 * Persist the resume, then report the URL Zapier will carry.
 *
 * Storage happens BEFORE the Zapier forward on purpose: a lead that arrives
 * pointing at a CV we never stored is unrecoverable, whereas a stored object
 * whose forward failed is a retained orphan and an accepted cost.
 */
async function storeResume(
  file: File,
  workEmail: string,
  submittedAt: string,
  env: Env,
): Promise<StoredResume | ErrorCode> {
  const base = resumeUrlBase(env);
  if (base === "") return "STORAGE_FAILED";

  const submissionId = crypto.randomUUID();
  const subjectHash = await computeSubjectHash(workEmail, env.ERASURE_SALT);

  try {
    await env.RESUMES.put(submissionId, file, {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
      },
      customMetadata: {
        originalFileName: file.name,
        submittedAt,
        submissionId,
        subjectHash,
      },
    });
  } catch {
    // The caught error is deliberately dropped rather than logged or echoed:
    // it can carry bucket names and request detail we do not want in output.
    return "STORAGE_FAILED";
  }

  return { resumeUrl: `${base}/${submissionId}`, resumeFileName: file.name };
}

/**
 * Forward the flat contract payload to Zapier as JSON.
 *
 * NEVER multipart. Zapier does not accept multipart/form-data: it discards the
 * body and still answers HTTP 200, so a multipart forward reports success while
 * every lead is silently dropped. That is the bug this Worker exists to prevent,
 * and the byte-comparison against the golden fixtures is what keeps it dead.
 *
 * The shared secret travels as a HEADER, not a body key. The Zap filters on it
 * so a stranger who scraped the old public hook URL can no longer inject leads,
 * and keeping it out of the body leaves the 15-key contract frozen.
 *
 * REDIRECTS ARE NEVER FOLLOWED, and that is a security control rather than a
 * preference. `fetch` follows them by default, so an expired or repointed hook
 * answering 302 would send us to whatever the Location names, that stranger
 * would answer 200, and this function would report a delivered lead that Zapier
 * never received - the same "2xx that does not mean delivery" this Worker was
 * built to kill, one layer down. Worse, a custom header is not stripped on a
 * cross-origin hop, so the shared secret would be handed to the redirect target.
 *
 * With `manual` a 3xx is returned as a 3xx, `response.ok` is false, and the
 * request fails closed with no second hop to leak to.
 *
 * Failures collapse to `false`. The caught error is never logged, wrapped or
 * returned: it can carry the hook URL and the request we just sent.
 */
async function forwardToZapier(
  payload: ZapierPayload,
  env: Env,
): Promise<boolean> {
  try {
    const response = await fetch(env.ZAPIER_HOOK_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "X-AAG-Worker-Auth": env.ZAPIER_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });
    // `ok` is 200-299 only, so every 3xx lands here as a failure.
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Handle a public form submission.
 *
 * A body that cannot be parsed as multipart — including no body at all, which is
 * exactly what the post-deploy probe sends — maps to `INVALID_SUBMISSION`. That
 * mapping is a contract, not a convenience: the probe uses it to prove the
 * endpoint is reachable unauthenticated AND answered by this Worker.
 */
async function handleSubmit(request: Request, env: Env): Promise<Routed> {
  const cors = corsHeaders(env);

  // FIRST, ahead of parsing, storage and network. A deploy that cannot deliver a
  // lead must never write a candidate's CV into R2 and must never answer the
  // post-deploy probe with the healthy signature.
  const misconfigured = misconfiguredBinding(env);
  if (misconfigured !== null) return fail(misconfigured, cors);

  if (declaredBodyExceedsCap(request)) {
    return fail("FILE_TOO_LARGE", cors);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail("INVALID_SUBMISSION", cors);
  }

  const invalidFields = validateFields(formData);
  if (invalidFields !== null) return fail(invalidFields, cors);

  const resume = formData.get("resume");
  const file = resume instanceof File && resume.size > 0 ? resume : null;

  let stored: StoredResume = { resumeUrl: "", resumeFileName: "" };
  const submittedAt = new Date().toISOString();

  if (file === null) {
    // Only the resume flow requires a file; the other inquiry types are
    // text-only and must keep working.
    if (readText(formData, "inquiryType") === RESUME_INQUIRY_TYPE) {
      return fail("INVALID_SUBMISSION", cors);
    }
  } else {
    const rejection = await validateResume(file);
    if (rejection !== null) return fail(rejection, cors);

    const result = await storeResume(
      file,
      readText(formData, "workEmail"),
      submittedAt,
      env,
    );
    if (typeof result === "string") return fail(result, cors);
    stored = result;
  }

  const forwarded = await forwardToZapier(
    toZapierPayload(formData, {
      resumeUrl: stored.resumeUrl,
      resumeFileName: stored.resumeFileName,
      submittedAt,
    }),
    env,
  );

  // The stored object is deliberately NOT deleted here. An orphaned file is an
  // accepted cost; answering 2xx while the lead is gone is not.
  if (!forwarded) return fail("FORWARD_FAILED", cors);

  return {
    response: new Response(
      JSON.stringify({ ok: true, resumeUrl: stored.resumeUrl }),
      { status: 200, headers: { ...JSON_HEADERS, ...cors } },
    ),
    errorCode: null,
  };
}

const RESUME_PATH_PREFIX = "/resume/";

/**
 * Is this request arriving on the one hostname the Access application covers?
 *
 * THIS COMPARISON IS THE ONLY THING STANDING BETWEEN A STRANGER AND A CANDIDATE'S
 * CV, and it is worth being explicit about why.
 *
 * Authorization deliberately lives at the edge, not in this file: Cloudflare
 * Access challenges the request before the isolate ever runs. But Access is bound
 * to ONE hostname, while every other name that routes to this Worker - the submit
 * host, `*.workers.dev`, a preview URL, `wrangler dev --remote` - reaches the
 * same code with no gate in front of it. Without this check,
 * `<submit-host>/resume/<key>` streams PII to anyone who asks.
 *
 * An unset or blank binding matches NOTHING. An unconfigured deploy serving CVs
 * from every hostname is the failure mode; answering 404 everywhere is merely a
 * broken feature, and a broken feature is loud.
 *
 * The comparison is against configuration, never a literal: the AAG domain
 * migration is still pending and must not require a source change.
 */
function isResumeHost(env: Env, url: URL): boolean {
  const configured = (env.RESUME_HOST ?? "").trim().toLowerCase();
  if (configured === "") return false;
  return url.hostname.toLowerCase() === configured;
}

/** Used when the stored name is absent or sanitises away to nothing. */
const FALLBACK_RESUME_FILE_NAME = "resume";

/**
 * Make a candidate-supplied filename safe to place inside a response header.
 *
 * The name travels from an upload straight into `Content-Disposition`, so it is
 * attacker-controlled input in a header value. A CR or LF splits the header
 * block and lets the uploader dictate headers - or an entire second response -
 * to the staff browser downloading the file. A bare quote closes the
 * quoted-string early and does the same to its parameters, and a backslash is
 * the escape character inside one.
 *
 * They are STRIPPED rather than escaped: a resume filename has no legitimate use
 * for any of them, and deleting a character cannot be got wrong the way an
 * escaping scheme can.
 */
function sanitizeFileName(name: string): string {
  const stripped = name.replace(/[\r\n"\\]/g, "").trim();
  return stripped === "" ? FALLBACK_RESUME_FILE_NAME : stripped;
}

/**
 * Response headers for a resume download (D-L).
 *
 * A CV is an attacker-supplied binary served on the SAME ORIGIN whose session is
 * the Access identity. If the browser renders it inline, a malicious PDF runs in
 * the one origin whose cookies unlock every other candidate's file. So it is
 * never a page: `attachment` forces a download, `nosniff` stops the browser
 * second-guessing the stored type back into something renderable, and the CSP
 * sandbox leaves anything that does execute with no origin and no privileges.
 * `no-referrer` keeps the key out of outbound headers and `no-store` keeps the
 * bytes off shared disks.
 *
 * THERE IS DELIBERATELY NO `Access-Control-Allow-Origin` HERE, AT ANY STATUS
 * (W6). CORS belongs to `/submit` alone. Adding it would let any page in a
 * staff member's browser read a candidate's CV using that staff member's own
 * Access session.
 */
function resumeDownloadHeaders(
  contentType: string,
  fileName: string,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${sanitizeFileName(fileName)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  };
}

/**
 * Stream a stored resume to an already-authenticated staff member.
 *
 * The 404 for a missing object is the SAME fixed 404 a wrong host gets, and that
 * is intentional: the response must not tell a caller whether a key exists.
 */
async function handleResumeDownload(key: string, env: Env): Promise<Routed> {
  const object = await env.RESUMES.get(key);
  if (object === null) return fail("NOT_FOUND");

  return {
    response: new Response(object.body, {
      status: 200,
      headers: resumeDownloadHeaders(
        object.httpMetadata?.contentType ?? "application/octet-stream",
        object.customMetadata?.originalFileName ?? "",
      ),
    }),
    errorCode: null,
  };
}

async function route(
  request: Request,
  env: Env,
  url: URL,
): Promise<Routed> {
  if (url.pathname === "/submit") {
    if (request.method === "OPTIONS") {
      // Defensive only: the widget posts multipart, which is CORS-safelisted,
      // so no preflight actually fires. Answering one anyway costs nothing and
      // removes a failure mode if a future caller sends a custom header.
      return {
        response: new Response(null, {
          status: 204,
          headers: corsHeaders(env),
        }),
        errorCode: null,
      };
    }
    if (request.method === "POST") {
      return handleSubmit(request, env);
    }
  }

  // The host lock lives INSIDE this branch on purpose. Hoisting it into a
  // top-level guard would host-lock `/submit` too, and a submit host that stops
  // accepting posts is 100% lead loss - the failure this whole change exists to
  // eliminate. `/submit` is public by design, so locking it buys no security
  // and only adds a way to lose leads. The asymmetry is the design.
  if (
    request.method === "GET" &&
    url.pathname.startsWith(RESUME_PATH_PREFIX) &&
    isResumeHost(env, url)
  ) {
    const key = url.pathname.slice(RESUME_PATH_PREFIX.length);
    if (key !== "") return handleResumeDownload(key, env);
  }

  return fail("NOT_FOUND");
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const { response, errorCode } = await route(request, env, url);

    /**
     * The ONLY log line this Worker emits, and its shape is an allowlist.
     *
     * Never add the hook URL, the shared secret, the erasure salt, a raw fetch
     * error, a header collection or any submitted field to it. Those are the
     * things that turn an observability line into a credential leak, and a
     * runtime test drives every error path asserting none of them appear.
     *
     * `origin` is here on purpose: an ALLOWED_ORIGIN mismatch still delivers the
     * lead but hides the response from the page, so the user retries and we get
     * duplicates plus a false failure report. Without this field that
     * misconfiguration is invisible.
     */
    console.log({
      requestId: crypto.randomUUID(),
      path: url.pathname,
      status: response.status,
      errorCode,
      origin: request.headers.get("Origin") ?? "",
      durationMs: Date.now() - startedAt,
    });

    return response;
  },
};
