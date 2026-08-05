import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Runtime tests for the Worker, executed inside workerd by
 * `@cloudflare/vitest-pool-workers` (see `vitest.worker.config.ts`).
 *
 * Miniflare simulates the R2 binding. Nothing here touches Cloudflare: no
 * bucket is provisioned, nothing is deployed, no remote call is made.
 */

declare module "cloudflare:test" {
  interface ProvidedEnv {
    RESUMES: R2Bucket;
    ALLOWED_ORIGIN: string;
    RESUME_URL_BASE: string;
    ZAPIER_HOOK_URL: string;
    ZAPIER_SHARED_SECRET: string;
    ERASURE_SALT: string;
  }
}

const ORIGIN = "https://worker.test";

describe("POST /submit - bodyless request (deploy probe P1 contract)", () => {
  /**
   * This exact signature is load-bearing OUTSIDE the test suite. The post-deploy
   * probe asserts `400` AND `.error == "INVALID_SUBMISSION"` because that pair is
   * something only our Worker can emit — a Cloudflare Access challenge answers
   * 302, 403, 401 or HTML and fails all of them. If this response shape drifts,
   * the probe starts reporting a gated public form as healthy, which is a 100%
   * lead-loss failure shipped green. Hence its own test.
   */
  it("answers 400 with exactly {\"ok\":false,\"error\":\"INVALID_SUBMISSION\"}", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      '{"ok":false,"error":"INVALID_SUBMISSION"}',
    );
  });

  it("labels the bodyless rejection as JSON so the probe can parse it", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("CORS is scoped to /submit only", () => {
  it("answers OPTIONS /submit with 204 and the configured allowed origin", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      env.ALLOWED_ORIGIN,
    );
  });

  it("puts the allowed origin on a POST /submit response too", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      env.ALLOWED_ORIGIN,
    );
  });

  /**
   * W6. `/resume` streams candidate CVs on the origin whose session IS the
   * Access identity. Making that stream cross-origin readable would hand any
   * page the ability to read PII with the staff member's own session.
   */
  it("emits no Access-Control-Allow-Origin on a non-/submit path", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/resume/11111111-2222-4333-8444-555555555555`,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("routing", () => {
  it("answers an unknown path with 404 NOT_FOUND from the fixed enum", async () => {
    const response = await SELF.fetch(`${ORIGIN}/definitely-not-a-route`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  it("answers GET /submit with 404 - /submit accepts POST and OPTIONS only", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  /**
   * Ordering guarantee from the rollout plan (W3): the resume hostname is
   * pointed at this Worker and the Cloudflare Access app is created BEFORE any
   * `/resume` handler exists. Until then the route must answer 404, so the
   * hostname can never serve CV bytes before its gate exists. This test is what
   * keeps that window closed while S2 is in flight.
   */
  it("answers GET /resume/<key> with 404 - no handler ships in this slice", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/resume/11111111-2222-4333-8444-555555555555`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });
});
