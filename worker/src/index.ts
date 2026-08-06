/**
 * Cloudflare Worker for the AAG contact form.
 *
 * `POST /submit` is PUBLIC by design and must never require credentials —
 * gating it means 100% lead loss, silently. `GET /resume/<key>` is gated by HTTP
 * Basic Auth enforced IN THIS FILE (see {@link authorizeResume}), behind a
 * hostname lock that runs first.
 *
 * The gate used to be Cloudflare Access at the edge. Zero Trust is not enabled
 * on this account, so authorization moved into code — which INVERTS the safe
 * default: an unconfigured deploy used to mean a dead route, and must now mean a
 * refusing one. Read the fail-closed paragraph in {@link authorizeResume} before
 * changing anything on that path.
 *
 * Three rules run through every response in this file:
 *
 *   1. Error bodies come EXCLUSIVELY from {@link ErrorCode}. A caught error is
 *      never wrapped, stringified or echoed back to the client.
 *   2. CORS headers are emitted on `/submit` only. `/resume` streams candidate
 *      CVs, and making those cross-origin readable would be a PII leak.
 *   3. Nothing logs the `Authorization` header or either resume credential. It
 *      now travels inbound on every gated request, so a single "log the request
 *      for debugging" line is a credential leak.
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
  /** Comma-separated allowlist. See {@link parseAllowedOrigins}. */
  ALLOWED_ORIGINS: string;
  RESUME_HOST: string;
  RESUME_URL_BASE: string;
  /**
   * Shared HTTP Basic credential for `GET /resume/<key>`. WORKER SECRETS, never
   * vars: they authorise reads of candidate PII.
   *
   * Both are REQUIRED for the route to serve anything. See
   * {@link authorizeResume} for why an unset one refuses instead of allowing.
   */
  RESUME_AUTH_USER: string;
  RESUME_AUTH_PASSWORD: string;
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
  | "UNAUTHORIZED"
  | "NOT_FOUND";

const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_SUBMISSION: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  STORAGE_FAILED: 502,
  FORWARD_FAILED: 502,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Split the comma-separated allowlist into origins.
 *
 * Parsed defensively on purpose. This var is edited by hand - in a TOML file and
 * in a dashboard field - so padding, a stray trailing comma and a wrapped line
 * are all things a human will produce, and not one of them may silently drop an
 * origin. A dropped origin IS the outage this list exists to prevent.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The origin to echo back to this caller, or null when there is nothing to echo.
 *
 * THE COMPARISON IS EXACT EQUALITY AND HAS TO STAY THAT WAY. `startsWith` would
 * accept `https://www.alphaapexgroup.com.attacker.tld`; a substring test against
 * the raw list would accept `https://www.alphaapexgroup.co`, a domain anyone can
 * register. Either one hands our responses to somebody else's page.
 *
 * Returning null - rather than `*`, or the first entry, or any other fallback -
 * is the entire point. `*` cannot be used with credentials and would give the
 * response to any site on the internet; a fixed value silently breaks every
 * origin except the one that happened to get hardcoded, which is precisely the
 * failure this allowlist was introduced to fix.
 *
 * NO `Origin` HEADER AT ALL is treated the same as an unlisted one: nothing is
 * echoed. Same-origin posts, curl, server-to-server callers and the P1 deploy
 * probe all arrive this way. CORS is a browser mechanism that engages only when
 * the browser sent an origin, so there is nothing to answer here - and answering
 * nothing is the one option that cannot widen access, because there is no origin
 * to widen it to.
 */
function matchAllowedOrigin(request: Request, env: Env): string | null {
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin === null || requestOrigin === "") return null;

  return parseAllowedOrigins(env.ALLOWED_ORIGINS).some(
    (allowed) => allowed === requestOrigin,
  )
    ? requestOrigin
    : null;
}

/**
 * CORS headers for `/submit` responses. Never applied to any other path.
 *
 * `Access-Control-Allow-Origin` appears ONLY when the caller's own origin is on
 * the list, and then carries that caller's origin verbatim. An unlisted or
 * absent origin gets the rest of the block and no echo — the request is still
 * processed either way, because by the time it reaches us the multipart body has
 * already been delivered and refusing it would cost a real lead rather than
 * prevent anything.
 *
 * `Vary: Origin` is unconditional: the response now genuinely differs per
 * caller, and without it a shared cache is free to hand one origin's echo to
 * another.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  const echo = matchAllowedOrigin(request, env);
  if (echo !== null) headers["Access-Control-Allow-Origin"] = echo;

  return headers;
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
 * The one path `/resume` is served under.
 *
 * Declared HERE, above both users, because it has two: the router that answers
 * downloads and the builder that emits the link staff click. Those two drifted
 * apart once already — the builder emitted `<base>/<key>` while the router only
 * ever answered `<base>/resume/<key>` — and every lead shipped with a link to a
 * 404. One constant, read by both, is what makes that particular drift
 * unrepresentable rather than merely tested for.
 */
const RESUME_PATH_PREFIX = "/resume/";

/**
 * The ORIGIN resume links are built on, or null when configuration cannot
 * produce a link that resolves.
 *
 * There is deliberately NO source-level fallback hostname. Hostnames are
 * configuration; hardcoding one here would mean the pending domain migration
 * needs a code change, and a stale literal would hand staff links to the wrong
 * origin.
 *
 * What IS enforced here is that the configured value is an origin and nothing
 * more. Letting the base carry its own path is precisely how the missing
 * `/resume` shipped: the path lived in configuration on one deploy and in code
 * on another, and neither side could tell which. An origin-only base means the
 * path can only come from {@link RESUME_PATH_PREFIX}.
 *
 * It also refuses a base whose hostname is not the hostname `/resume` is served
 * from. `RESUME_URL_BASE` says where the link points; `RESUME_HOST` says where
 * downloads are answered. They describe one fact through two bindings, so they
 * can disagree — and when they do, every emitted link is dead on arrival with
 * nothing in the response to say so. A blank `RESUME_HOST` is left alone: that
 * is an unconfigured deploy, not a contradiction, and failing the submission
 * there would trade a dead link for a lost lead.
 */
function resumeUrlOrigin(env: Env): string | null {
  const configured = (env.RESUME_URL_BASE ?? "").trim().replace(/\/+$/, "");
  if (configured === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return null;
  }

  const servingHost = (env.RESUME_HOST ?? "").trim().toLowerCase();
  if (servingHost !== "" && parsed.hostname.toLowerCase() !== servingHost) {
    return null;
  }

  return parsed.origin;
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
  const origin = resumeUrlOrigin(env);
  if (origin === null) return "STORAGE_FAILED";

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

  return {
    resumeUrl: `${origin}${RESUME_PATH_PREFIX}${submissionId}`,
    resumeFileName: file.name,
  };
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
  const cors = corsHeaders(request, env);

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

/**
 * Is this request arriving on the one hostname `/resume` is served from?
 *
 * DEFENCE IN DEPTH, NO LONGER THE PRIMARY CONTROL. The credential check in
 * {@link authorizeResume} is what actually stands between a stranger and a
 * candidate's CV; this narrows the surface that check has to defend.
 *
 * It still earns its place. Every name that routes to this Worker - the submit
 * host, `*.workers.dev`, a preview URL, `wrangler dev --remote` - reaches the
 * same code, and this is what makes all of them behave as though the route does
 * not exist rather than advertising a credential-gated PII endpoint on each one.
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

/**
 * The challenge that makes a browser show its native credential prompt.
 *
 * `charset="UTF-8"` is not decoration: without it a browser may encode a
 * non-ASCII credential as latin1, and the comparison below decodes UTF-8. The
 * realm is a fixed, meaningless-to-an-attacker label — it is echoed to anyone
 * who asks, so it must never name a host, an account or an environment.
 */
const RESUME_CHALLENGE_HEADERS: Record<string, string> = {
  "WWW-Authenticate": 'Basic realm="AAG Resume Downloads", charset="UTF-8"',
};

/**
 * Proof that Basic Auth succeeded, and the ONLY way into the download handler.
 *
 * This type exists to make an unauthenticated 200 impossible to write rather
 * than merely unlikely: {@link handleResumeDownload} demands one, and the single
 * expression in this file that produces one sits behind the comparison in
 * {@link authorizeResume}. Deleting the auth call does not produce an insecure
 * Worker, it produces one that does not compile.
 *
 * It also carries the value the audit line records, so "this download was
 * authenticated" is read off the proof itself instead of being a label the
 * logger chooses independently and could drift from.
 */
type ResumeAuthGrant = { readonly method: "basic" };

const RESUME_AUTH_GRANT: ResumeAuthGrant = { method: "basic" };

/** A supplied Basic credential, or empty strings when there was nothing usable. */
type BasicCredential = { user: string; password: string };

const NO_CREDENTIAL: BasicCredential = { user: "", password: "" };

/**
 * Pull the username and password out of an `Authorization` header.
 *
 * EVERY UNUSABLE SHAPE COLLAPSES TO THE SAME EMPTY CREDENTIAL — absent header,
 * empty value, a non-Basic scheme, invalid base64, a payload with no colon. They
 * are not distinguished because distinguishing them is a disclosure: an attacker
 * who can tell "malformed" from "wrong password" learns which half of their
 * guess was already right, and one search space becomes two smaller ones.
 *
 * The decode is base64 -> BYTES -> UTF-8, not `atob` alone. `atob` yields one
 * char per byte, so a credential containing any non-ASCII character would be
 * compared as mojibake and could never match the configured secret - a bug that
 * only appears for the users least able to diagnose it.
 *
 * The split is on the FIRST colon only: RFC 7617 forbids a colon in the
 * username and explicitly permits one in the password.
 */
function parseBasicCredential(header: string | null): BasicCredential {
  if (header === null) return NO_CREDENTIAL;

  const separatorIndex = header.indexOf(" ");
  if (separatorIndex === -1) return NO_CREDENTIAL;

  const scheme = header.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "basic") return NO_CREDENTIAL;

  const encoded = header.slice(separatorIndex + 1).trim();
  if (encoded === "") return NO_CREDENTIAL;

  let decoded: string;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    decoded = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return NO_CREDENTIAL;
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) return NO_CREDENTIAL;

  return {
    user: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}

/**
 * `timingSafeEqual` is a Cloudflare runtime extension to WebCrypto.
 *
 * This project's `tsconfig.worker.json` loads BOTH the DOM lib (for FormData and
 * File) and the Workers types, and for the global `crypto` the DOM declaration
 * wins - so the method exists at runtime but not in the type. It is narrowed
 * here, in one named place with a reason attached, rather than smeared across
 * the call site as `any`: `any` would also silently swallow a future signature
 * change on the one comparison guarding candidate PII.
 *
 * The cast preserves object identity, so this is the same object as
 * `crypto.subtle` and a test spy on it is observed here.
 */
type TimingSafeSubtleCrypto = {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
};

const timingSafeSubtle = crypto.subtle as unknown as TimingSafeSubtleCrypto;

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * BOTH SIDES ARE HASHED FIRST, and that is the load-bearing detail rather than
 * belt-and-braces. `crypto.subtle.timingSafeEqual` THROWS when its operands have
 * different lengths, so feeding it raw credentials would turn every length
 * mismatch into a thrown exception - a far louder side channel than the timing
 * difference it was reached for. SHA-256 makes both operands exactly 32 bytes
 * whatever went in, so length stops being observable at all and the comparison
 * cost stops depending on the input.
 *
 * A plain `===` leaks both: it returns immediately on a length mismatch, and
 * bails at the first differing byte, so an attacker can recover a secret one
 * character at a time by measuring.
 */
async function constantTimeEquals(
  supplied: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeSubtle.timingSafeEqual(suppliedDigest, expectedDigest);
}

/**
 * Authorise a resume download, or refuse.
 *
 * FAIL CLOSED. THIS IS THE MOST IMPORTANT PARAGRAPH IN THE FILE.
 *
 * Under Cloudflare Access the gate lived at the edge, so an unconfigured deploy
 * meant a dead route - `RESUME_HOST` blank, 404 everywhere - and a dead route is
 * safe. Moving the gate into code INVERTS the safe default: this function now
 * decides for itself whether to serve, so a missing credential must mean "refuse
 * everyone" and never "compare against nothing and let it pass". An unset Worker
 * secret arrives as `undefined`, and a blank one is what `wrangler secret put`
 * stores for an empty value; both are unconfigured, and a blank expectation
 * would MATCH the empty credential an absent `Authorization` header produces.
 * That single mistake would publish every CV in the bucket.
 *
 * The check is on the trimmed value but the comparison uses the raw one: a
 * whitespace-only secret is a provisioning accident, while a real secret is
 * matched byte for byte exactly as it was configured.
 *
 * The two comparisons are combined with a BITWISE `&`, deliberately, and a
 * `&&` here would be a bug. `&&` short-circuits, so a wrong username would skip
 * the password comparison entirely and answer measurably sooner - rebuilding
 * the username oracle out of control flow after the string comparison was
 * hardened against exactly that. Both comparisons always run, for every request,
 * including one that carried no credential at all.
 */
async function authorizeResume(
  request: Request,
  env: Env,
): Promise<ResumeAuthGrant | null> {
  const expectedUser = String(env.RESUME_AUTH_USER ?? "");
  const expectedPassword = String(env.RESUME_AUTH_PASSWORD ?? "");
  if (expectedUser.trim() === "" || expectedPassword.trim() === "") return null;

  const supplied = parseBasicCredential(request.headers.get("Authorization"));

  const [userMatches, passwordMatches] = await Promise.all([
    constantTimeEquals(supplied.user, expectedUser),
    constantTimeEquals(supplied.password, expectedPassword),
  ]);

  return (Number(userMatches) & Number(passwordMatches)) === 1
    ? RESUME_AUTH_GRANT
    : null;
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
 * A CV is an attacker-supplied binary served on the SAME ORIGIN a staff member
 * has just authenticated to. If the browser renders it inline, a malicious PDF
 * runs in the one origin whose cached credential unlocks every other candidate's
 * file. So it is never a page: `attachment` forces a download, `nosniff` stops
 * the browser second-guessing the stored type back into something renderable,
 * and the CSP sandbox leaves anything that does execute with no origin and no
 * privileges. `no-referrer` keeps the key out of outbound headers and `no-store`
 * keeps the bytes off shared disks.
 *
 * THERE IS DELIBERATELY NO `Access-Control-Allow-Origin` HERE, AT ANY STATUS
 * (W6). CORS belongs to `/submit` alone. Adding it would let any page in a
 * staff member's browser read a candidate's CV — and browsers replay a cached
 * Basic credential on same-origin requests automatically, so the CV would come
 * back without the attacker ever seeing the credential itself.
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
 * The record that a stored CV was read.
 *
 * IT NO LONGER NAMES A PERSON, AND THAT IS A DELIBERATE, ACCEPTED LOSS.
 *
 * Cloudflare Access authenticated an individual and passed their address in a
 * header, so this line used to pair a key with a reader. A shared Basic
 * credential authenticates no one in particular: every member of staff presents
 * the same secret, so any identity written here would be an invention. The
 * honest record is that the read happened and that it was authenticated.
 *
 * The `auth` value comes off the {@link ResumeAuthGrant} rather than being a
 * literal chosen here, so it cannot claim an authentication that did not occur -
 * there is no way to reach this function without one.
 *
 * The candidate is still not named. They are already identified by the key, and
 * copying their address in would spread the PII this route exists to protect.
 */
function auditResumeDownload(key: string, grant: ResumeAuthGrant): void {
  console.log({ key, auth: grant.method });
}

/**
 * Stream a stored resume to an authenticated staff member.
 *
 * THE GRANT PARAMETER IS THE POINT. It is unused as data beyond the audit line,
 * and it is required anyway: it makes "serve a CV without checking credentials"
 * a compile error rather than a code review someone has to catch. See
 * {@link ResumeAuthGrant}.
 *
 * The 404 for a missing object is the SAME fixed 404 a wrong host gets, and that
 * is intentional: the response must not tell a caller whether a key exists.
 */
async function handleResumeDownload(
  key: string,
  env: Env,
  grant: ResumeAuthGrant,
): Promise<Routed> {
  const object = await env.RESUMES.get(key);
  if (object === null) return fail("NOT_FOUND");

  // Written at the moment the object is read, not assembled at the end, so a
  // later failure cannot drop the record of a read that already happened.
  auditResumeDownload(key, grant);

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
          headers: corsHeaders(request, env),
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
    /**
     * ORDER: HOST LOCK FIRST, CREDENTIAL SECOND. This is a security decision,
     * not a style one.
     *
     * The host lock answers a routing question - does this route exist on the
     * hostname this request arrived on? - and every other name that reaches this
     * Worker (`*.workers.dev`, preview URLs, `wrangler dev --remote`, the public
     * submit host) must answer as though it does not.
     *
     * Reversed, all of those names would answer 401 and thereby ADVERTISE a
     * credential-gated route over candidate PII, complete with a browser prompt
     * to start guessing at. A wrong-host request would also reveal, by the
     * difference between 401 and 404, whether the credentials it carried WOULD
     * have been accepted. In this order a wrong host is byte-identical whether
     * the request was authenticated or not, and reveals nothing either way.
     *
     * Within the correct host the credential is checked BEFORE the R2 lookup, so
     * an unauthenticated caller cannot use the difference between "found" and
     * "not found" to probe which keys exist.
     */
    const grant = await authorizeResume(request, env);
    if (grant === null) return fail("UNAUTHORIZED", RESUME_CHALLENGE_HEADERS);

    const key = url.pathname.slice(RESUME_PATH_PREFIX.length);
    if (key !== "") return handleResumeDownload(key, env, grant);
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
     * `origin` is here on purpose, and it is the RECEIVED value rather than a
     * verdict. An origin missing from ALLOWED_ORIGINS still delivers the lead
     * and stores the CV but hides the response from the page, so the candidate
     * retries and we get duplicates plus a false failure report. Logging the
     * value makes that one query — group `/submit` by `origin` and any name that
     * is not on the allowlist is the misconfiguration, named. Without it the
     * mismatch presents as a mysterious client-side error and nothing else.
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
