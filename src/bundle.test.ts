import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const BUNDLE_PATH = resolve(PROJECT_ROOT, "dist/aag-contact-form.js");
const WIDGET_SRC = resolve(PROJECT_ROOT, "src");

/**
 * The ONLY module the widget's production source graph may import from
 * `worker/`. Named literally, not matched by a pattern: a rule like "no worker
 * imports except limits-ish things" would have let the Zapier transform back in
 * under a different filename. Any other cross-boundary import fails the test.
 *
 * `worker/src/limits.ts` is shared on purpose — the size, extension and MIME
 * rules must be the SAME values on both sides, and duplicating them is how the
 * client and server silently drift apart.
 */
const PERMITTED_WORKER_IMPORTS = ["../worker/src/limits"];

/**
 * Strings that exist ONLY in `worker/src/payload.ts`, the server-side Zapier
 * transform. They are wire-contract keys the widget never produces: the Worker
 * builds the flat payload, so if any of these appear in the browser bundle the
 * transform has crossed the boundary again.
 *
 * Deliberately NOT the whole 15-key contract: `resumeUrl` is legitimately read
 * from the Worker's response by `src/submit.ts`, so asserting the full key set
 * absent would be a false alarm.
 */
const SERVER_ONLY_PAYLOAD_KEYS = ["resumeFileName", "submittedAt"];

/** Every `.ts`/`.tsx` file under `src/` that ships, i.e. excluding tests. */
function productionSourceFiles(): string[] {
  return readdirSync(WIDGET_SRC, { recursive: true, encoding: "utf8" })
    .map((entry) => join(WIDGET_SRC, entry))
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
}

/** Import specifiers reaching into `worker/`, unique and sorted. */
function crossBoundaryImports(): string[] {
  const specifiers = new Set<string>();

  for (const file of productionSourceFiles()) {
    const source = readFileSync(file, "utf8");
    // Static `from "…"` (import and re-export) plus dynamic `import("…")`.
    const matches = source.matchAll(
      /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
    );
    for (const [, specifier] of matches) {
      if (specifier.includes("worker/")) specifiers.add(specifier);
    }
  }

  return [...specifiers].sort();
}

describe("widget/worker boundary", () => {
  it("imports exactly one module from worker/, and it is worker/src/limits", () => {
    // Exact set, not "contains" — a NEW cross-boundary import must fail here,
    // and so must losing the shared limits module. Both directions matter: the
    // widget silently re-deriving its own 10MB cap is how it starts accepting
    // files the Worker rejects.
    expect(crossBoundaryImports()).toEqual([...PERMITTED_WORKER_IMPORTS].sort());
  });

  it("scans a source graph that actually contains the widget entrypoints", () => {
    // Guards the guard: if the walker silently returned nothing, the exact-set
    // assertion above would pass for the wrong reason.
    const scanned = productionSourceFiles().map((file) =>
      relative(PROJECT_ROOT, file),
    );

    expect(scanned).toContain("src/submit.ts");
    expect(scanned).toContain("src/schema.ts");
    expect(scanned).toContain("src/ContactForm.tsx");
  });
});

describe("production IIFE bundle", () => {
  it("mounts in a browser-like environment without a process polyfill", async () => {
    execFileSync("npm", ["run", "build"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "pipe",
    });

    const bundle = readFileSync(BUNDLE_PATH, "utf8");
    expect(bundle).not.toMatch(/\bprocess\b/);

    // Positive signal: the ONE permitted cross-boundary module really did ship.
    // Without this, every absence assertion below would also pass on a bundle
    // that contained no shared code at all.
    expect(bundle).toContain(".docx");

    // The Zapier transform runs on the Worker now. These keys are its
    // fingerprint; the widget posts multipart and never builds a flat payload.
    for (const key of SERVER_ONLY_PAYLOAD_KEYS) {
      expect(bundle, `server-only key "${key}" leaked into the bundle`).not.toContain(
        key,
      );
    }
    expect(bundle).not.toContain("worker/src/payload");
    expect(bundle).not.toContain("worker/fixtures");

    // The hook URL is a Worker secret. It must never be readable in the page.
    expect(bundle).not.toContain("hooks.zapier.com");
    expect(bundle).not.toContain("ZAPIER_HOOK_URL");

    const dom = new JSDOM(
      '<!doctype html><div id="aag-contact-form" data-endpoint="https://example.test/submit"></div>',
      {
        pretendToBeVisual: true,
        runScripts: "dangerously",
        url: "https://example.test/",
      },
    );

    try {
      expect(dom.window.process).toBeUndefined();
      expect(() => dom.window.eval(bundle)).not.toThrow();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const mount = dom.window.document.getElementById("aag-contact-form");
      expect(mount).toHaveAttribute("data-aag-mounted", "true");
      expect(mount?.querySelector("form")).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
