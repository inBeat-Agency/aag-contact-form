import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
