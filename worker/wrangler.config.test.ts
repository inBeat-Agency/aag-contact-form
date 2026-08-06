import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RATE_LIMIT_WINDOW_SECONDS,
  RESUME_RATE_LIMIT_PER_MINUTE,
  SUBMIT_RATE_LIMIT_PER_MINUTE,
} from "./src/rate-limit";

/**
 * The deploy config and the test runtime must agree on compatibility date.
 *
 * The worker suite used to print, on every single run:
 *
 *   [mf:warn] The latest compatibility date supported by the installed
 *   Cloudflare Workers Runtime is "2026-03-10", but you've requested
 *   "2026-07-23". Falling back to "2026-03-10"...
 *
 * Every test then passed against runtime semantics DIFFERENT from the ones the
 * deploy asks for, and CI read the whole thing as green. Compatibility dates
 * exist precisely to change behaviour, so a suite that silently validates the
 * wrong set of semantics is testing a Worker we are not shipping.
 *
 * This is asserted rather than eyeballed because the warning is a warning: it
 * scrolls past, it does not fail anything, and nobody reads a green log.
 */
// Resolved as the root package would resolve it, rather than from this file's
// URL: the jsdom environment does not give test modules a file:// import.meta.
const require = createRequire(join(process.cwd(), "package.json"));

/** `workerd@1.20260310.1` encodes the newest date its runtime understands. */
function installedRuntimeCompatibilityDate(): string {
  const { version } = require("workerd/package.json") as { version: string };
  const stamp = version.split(".")[1];

  expect(stamp).toMatch(/^\d{8}$/);
  return `${stamp!.slice(0, 4)}-${stamp!.slice(4, 6)}-${stamp!.slice(6, 8)}`;
}

function deployConfig(): string {
  return readFileSync(join(process.cwd(), "worker", "wrangler.toml"), "utf8");
}

function configuredCompatibilityDate(): string {
  const match = /^compatibility_date\s*=\s*"([\d-]+)"/m.exec(deployConfig());

  expect(match).not.toBeNull();
  return match![1]!;
}

function configuredAllowedOrigins(): string[] {
  const match = /^ALLOWED_ORIGINS\s*=\s*"([^"]*)"/m.exec(deployConfig());

  expect(match).not.toBeNull();
  return match![1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

describe("worker compatibility date", () => {
  it("reads a real date out of both the runtime and the deploy config", () => {
    expect(installedRuntimeCompatibilityDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(configuredCompatibilityDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * ISO dates compare correctly as strings, so no parsing is needed and no
   * timezone can move the boundary.
   */
  it("requests semantics the installed runtime can actually provide", () => {
    const requested = configuredCompatibilityDate();
    const supported = installedRuntimeCompatibilityDate();

    expect(
      requested <= supported,
      `worker/wrangler.toml requests compatibility_date "${requested}" but the ` +
        `installed workerd only supports up to "${supported}", so every worker ` +
        `test runs against different semantics than the deploy asks for.`,
    ).toBe(true);
  });
});

/**
 * THE VALUE THAT ACTUALLY SHIPS, WRITTEN OUT BY HAND.
 *
 * The runtime suite proves the MECHANISM - a listed origin is echoed, an
 * unlisted one is not - but it reads its own test binding, so it structurally
 * cannot notice `wrangler.toml` losing an origin. That drift is the outage:
 * multipart is CORS-safelisted, so a dropped origin still delivers the lead and
 * stores the CV while hiding the response, and the candidate resubmits.
 *
 * These two literals are therefore not imported, not parsed out of anything, and
 * not shared with the runtime suite. They are the deployment promise, typed
 * again, and this is the only test that can see the two drift apart.
 */
describe("worker allowed origins", () => {
  const AAG_PRODUCTION_ORIGIN = "https://www.alphaapexgroup.com";
  const AAG_STAGING_ORIGIN = "https://alpha-apex-group.webflow.io";

  /**
   * Asserted as a complete ordered list rather than "contains". During the
   * migration window the widget is mounted on BOTH names - production still
   * serves Squarespace - so either one going missing takes half the submissions
   * down, and an extra one nobody noticed is an origin allowed to read our
   * responses.
   */
  it("declares an allowlist covering production AND staging, and nothing else", () => {
    expect(configuredAllowedOrigins()).toEqual([
      AAG_PRODUCTION_ORIGIN,
      AAG_STAGING_ORIGIN,
    ]);
  });
});

type ConfiguredRateLimit = {
  name: string;
  namespaceId: string;
  limit: number;
  period: number;
};

/**
 * Every `[[ratelimits]]` block in the deploy config, in declaration order.
 *
 * Comment lines are stripped before parsing. The block above these declarations
 * talks about limits and periods in prose, and a regex that reads a number out
 * of a comment would happily assert that the documentation is correct while the
 * shipped value is anything at all.
 */
function configuredRateLimits(): ConfiguredRateLimit[] {
  const withoutComments = deployConfig()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  return withoutComments
    .split(/^\[\[ratelimits\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      // Stop at the next table header so one block cannot read the next one's
      // keys when a field is missing.
      const body = block.split(/^\[/m)[0] ?? "";
      return {
        name: /^name\s*=\s*"([^"]*)"/m.exec(body)?.[1] ?? "<missing>",
        namespaceId:
          /^namespace_id\s*=\s*"([^"]*)"/m.exec(body)?.[1] ?? "<missing>",
        limit: Number(/\blimit\s*=\s*(\d+)/.exec(body)?.[1] ?? NaN),
        period: Number(/\bperiod\s*=\s*(\d+)/.exec(body)?.[1] ?? NaN),
      };
    });
}

/**
 * THE REQUEST BUDGETS THAT ACTUALLY SHIP, WRITTEN OUT BY HAND.
 *
 * The runtime suite proves the MECHANISM — a client inside its budget is served,
 * the one past it gets 429 with `Retry-After`, and the two routes do not share a
 * counter. It cannot prove the NUMBERS, because it reads the same bindings the
 * Worker does. Change `limit = 20` to `limit = 0` in `worker/wrangler.toml` and
 * a suite that derives its expectations from the binding stays green while the
 * public form refuses every candidate who ever finds it.
 *
 * So the numbers are typed again here, deliberately not imported, not parsed out
 * of the file under test, and not shared with the runtime suite. This is the
 * only place the deployment promise and the deployed value can be seen to
 * disagree.
 */
describe("worker rate limiting", () => {
  const SUBMIT_LIMITER_NAME = "SUBMIT_LIMITER";
  const RESUME_LIMITER_NAME = "RESUME_LIMITER";
  const SUBMIT_LIMITER_NAMESPACE = "1001";
  const RESUME_LIMITER_NAMESPACE = "1002";
  const SUBMIT_REQUESTS_PER_WINDOW = 20;
  const RESUME_REQUESTS_PER_WINDOW = 60;
  const WINDOW_SECONDS = 60;

  /**
   * Asserted as a complete ordered list rather than "contains". A missing block
   * means the route it belonged to ships with NO limit at all — and the Worker
   * fails open by design, so nothing at runtime would say so.
   */
  it("declares exactly the two budgets the Worker reads, and nothing else", () => {
    expect(configuredRateLimits()).toEqual([
      {
        name: SUBMIT_LIMITER_NAME,
        namespaceId: SUBMIT_LIMITER_NAMESPACE,
        limit: SUBMIT_REQUESTS_PER_WINDOW,
        period: WINDOW_SECONDS,
      },
      {
        name: RESUME_LIMITER_NAME,
        namespaceId: RESUME_LIMITER_NAMESPACE,
        limit: RESUME_REQUESTS_PER_WINDOW,
        period: WINDOW_SECONDS,
      },
    ]);
  });

  /**
   * Two namespaces, or the budgets are one budget. Shared, a burst of form spam
   * locks staff out of every CV they need to read that morning — one endpoint's
   * abuse taking down an unrelated one, which is exactly what splitting the
   * limiters was for.
   */
  it("keeps the two budgets in separate namespaces", () => {
    const namespaces = configuredRateLimits().map(
      (entry) => entry.namespaceId,
    );

    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  /**
   * THE BRIDGE BETWEEN THE NUMBERS AND THE REASONING.
   *
   * `worker/src/rate-limit.ts` explains at length WHY these limits are generous
   * — the corporate NAT, the silent lead loss — but it does not enforce
   * anything: the binding does. Without this assertion that file is a comment
   * describing limits the Worker might not have, and a reader would trust it.
   */
  it("ships the numbers the Worker's own constants document", () => {
    expect({
      submit: SUBMIT_RATE_LIMIT_PER_MINUTE,
      resume: RESUME_RATE_LIMIT_PER_MINUTE,
      window: RATE_LIMIT_WINDOW_SECONDS,
    }).toEqual({
      submit: SUBMIT_REQUESTS_PER_WINDOW,
      resume: RESUME_REQUESTS_PER_WINDOW,
      window: WINDOW_SECONDS,
    });
  });

  /**
   * Cloudflare accepts ONLY 10 or 60 for `period`. Anything else is rejected at
   * deploy time — which is a fine place to find out, except that the deploy in
   * question is usually the one shipping something else entirely.
   */
  it("requests a window the platform actually accepts", () => {
    const periods = configuredRateLimits().map((entry) => entry.period);

    expect(periods).toEqual(periods.map(() => WINDOW_SECONDS));
    expect([10, 60]).toContain(WINDOW_SECONDS);
  });
});
