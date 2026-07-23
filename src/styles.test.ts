import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

describe("widget theme defaults", () => {
  it("uses fallbacks instead of shadowing host custom property overrides", () => {
    expect(styles).not.toMatch(
      /\.aag-form-root\s*\{(?:(?!\}).)*--aag-form-accent:/s,
    );
    expect(styles).toContain("background: var(--aag-form-accent, #1928c8);");
  });
});
