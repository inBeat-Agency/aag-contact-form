import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const BUNDLE_PATH = resolve(PROJECT_ROOT, "dist/aag-contact-form.js");

describe("production IIFE bundle", () => {
  it("mounts in a browser-like environment without a process polyfill", async () => {
    execFileSync("npm", ["run", "build"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "pipe",
    });

    const bundle = readFileSync(BUNDLE_PATH, "utf8");
    expect(bundle).not.toMatch(/\bprocess\b/);

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
