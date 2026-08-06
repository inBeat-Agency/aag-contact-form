/**
 * Request budgets for the two public routes.
 *
 * The enforcement lives in Cloudflare's native rate limiting binding, declared
 * in `worker/wrangler.toml`. This module holds the numbers that describe those
 * bindings, the key every budget is counted against, and the one wrapper that
 * decides what happens when the binding cannot answer.
 *
 * WHY THE NATIVE BINDING RATHER THAN A WAF RULE. A WAF rate limiting rule needs
 * a zone, and this Worker is served from `workers.dev` because the custom domain
 * is still an open question. The binding needs no zone, no KV and no Durable
 * Object, so it is the only option that works today and keeps working after the
 * domain migration.
 *
 * WHAT THIS BUYS AND WHAT IT DOES NOT. Cloudflare counts these per location, not
 * globally: a client spread across twenty colos gets twenty budgets. This raises
 * the cost of casual abuse — a script from one machine, a bored stranger with
 * curl — and it does not stop a determined distributed attacker. It is stated
 * plainly here and again in `worker/wrangler.toml` so nobody builds a stronger
 * assumption on top of it.
 */

/**
 * The slice of Cloudflare's rate limiting binding this Worker uses.
 *
 * Narrowed to the one method actually called, so a test double is a two-line
 * object rather than a mock of an interface we do not exercise. The binding is
 * OPTIONAL everywhere it appears: see {@link withinRateLimit} for why a missing
 * one has to be survivable.
 */
export type RateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

/**
 * The window both budgets are measured over, in seconds.
 *
 * Cloudflare's simple rate limiter accepts ONLY 10 or 60 — any other value is
 * rejected at deploy time — so this is 60 by the platform's choice as much as
 * ours. It is also the number sent back as `Retry-After`, which is the one
 * runtime use any of these constants has.
 *
 * `worker/wrangler.config.test.ts` asserts this equals the `period` on both
 * declared bindings, so a `Retry-After` that tells the caller to come back
 * before the window has actually reset cannot ship.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * REQUESTS PER MINUTE, PER CLIENT, AND THEY ARE GENEROUS ON PURPOSE.
 *
 * A corporate NAT puts an entire office behind ONE address. Every recruiter at
 * a client company sharing a single outbound IP is the normal case here, not the
 * edge case, so a limit tuned to "how many forms could one human plausibly
 * submit" would refuse real candidates as soon as two of them worked from the
 * same building.
 *
 * The asymmetry that decides these numbers: a limit set too high lets some abuse
 * through, and a limit set too low loses a legitimate lead — silently, because
 * the candidate sees an error, gives up, and we never learn they existed. This
 * project has spent its entire history eliminating silent lead loss. So the
 * numbers sit well above plausible human traffic and still far below what a
 * script produces.
 *
 * `/resume` is larger because it is browsed rather than submitted: a staff
 * member working through a morning's applications legitimately opens many CVs
 * in a few minutes, all from one office address.
 *
 * THESE CONSTANTS DO NOT ENFORCE ANYTHING. The binding in `worker/wrangler.toml`
 * does. They exist so the reasoning has somewhere to live and so
 * `worker/wrangler.config.test.ts` can assert the deployed numbers against them
 * — that test is the only thing preventing this comment from describing limits
 * the Worker does not actually have.
 */
export const SUBMIT_RATE_LIMIT_PER_MINUTE = 20;
export const RESUME_RATE_LIMIT_PER_MINUTE = 60;

/**
 * The header Cloudflare puts the real client address in.
 *
 * It is set at the edge and OVERWRITES anything the client sent, so its value
 * cannot be forged by a caller coming through Cloudflare.
 */
const CLIENT_IP_HEADER = "CF-Connecting-IP";

/**
 * The identity every request without a client address is counted under.
 *
 * A REQUEST WITHOUT `CF-Connecting-IP` DID NOT COME FROM A BROWSER. Cloudflare
 * always sets that header on edge traffic, so an absent one means a service
 * binding, `wrangler dev` in local mode, or a test harness — not a stranger who
 * found a way to strip it.
 *
 * That leaves two tempting answers and both are wrong:
 *
 *   - SKIPPING the limiter would make "send no header" the single input that
 *     buys unlimited access. Unreachable from outside today is not the same as
 *     safe, and a control with a documented hole is how the hole survives a
 *     future refactor that makes it reachable.
 *   - REFUSING outright would be a denial, and on `/submit` a denial is a lost
 *     lead. Refusing a caller because our own platform did not label it is
 *     exactly the silent failure this Worker exists to eliminate.
 *
 * So they are COUNTED, all of them together, under this one shared identity.
 * They are not exempt, and they are not refused until the shared budget is
 * genuinely spent. The blast radius is bounded to callers we operate, and a real
 * client with a real address is never affected by what they spend.
 *
 * A BLANK header is treated as an absent one, deliberately. Otherwise the empty
 * string becomes its own budget and the sentinel is side-stepped by sending the
 * header with no value.
 */
const UNIDENTIFIED_CLIENT_KEY = "unidentified-client";

/** The client this request is counted against. Never empty. */
export function rateLimitKey(request: Request): string {
  const clientIp = (request.headers.get(CLIENT_IP_HEADER) ?? "").trim();
  return clientIp === "" ? UNIDENTIFIED_CLIENT_KEY : clientIp;
}

/**
 * Has this client got budget left?
 *
 * FAIL OPEN, AND THE ASYMMETRY IS THE WHOLE ARGUMENT.
 *
 * A limiter that is unusable — never declared, or throwing at call time — leaves
 * two choices, and their costs are nowhere near each other:
 *
 *   - Fail CLOSED and `/submit` refuses every submission for as long as the
 *     outage lasts. Every lead that arrives in that window is gone, the
 *     candidate sees an error, and nothing anywhere records who we lost.
 *   - Fail OPEN and we are exactly as exposed as we were before rate limiting
 *     existed at all, which is to say: we lose the protection, and nothing else.
 *
 * The first is unrecoverable and silent. The second is recoverable and costs
 * only the mitigation. So an unusable limiter must never be able to take a route
 * down.
 *
 * This is the OPPOSITE of the direction chosen for the `/resume` credential, and
 * the difference is deliberate rather than inconsistent: a missing credential
 * publishes candidate PII, while a missing limiter publishes nothing. Fail-safe
 * direction follows what the failure costs, not a house style.
 *
 * The caught error is dropped rather than logged: it comes from a platform
 * binding and this Worker's log line is an allowlist that no error object gets
 * to join.
 */
export async function withinRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
): Promise<boolean> {
  if (limiter === undefined || limiter === null) return true;

  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
