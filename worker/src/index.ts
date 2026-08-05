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

export interface Env {
  RESUMES: R2Bucket;
  ALLOWED_ORIGIN: string;
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

function errorResponse(
  code: ErrorCode,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status: ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/**
 * Handle a public form submission.
 *
 * A body that cannot be parsed as multipart — including no body at all, which is
 * exactly what the post-deploy probe sends — maps to `INVALID_SUBMISSION`. That
 * mapping is a contract, not a convenience: the probe uses it to prove the
 * endpoint is reachable unauthenticated AND answered by this Worker.
 */
async function handleSubmit(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("INVALID_SUBMISSION", cors);
  }

  void formData;
  return errorResponse("INVALID_SUBMISSION", cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/submit") {
      if (request.method === "OPTIONS") {
        // Defensive only: the widget posts multipart, which is CORS-safelisted,
        // so no preflight actually fires. Answering one anyway costs nothing and
        // removes a failure mode if a future caller sends a custom header.
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      if (request.method === "POST") {
        return handleSubmit(request, env);
      }
    }

    // Everything else, including /resume until its slice ships. A 404 here is
    // the guarantee that the resume hostname cannot serve bytes before its
    // Access gate exists.
    return errorResponse("NOT_FOUND");
  },
};
