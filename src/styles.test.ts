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

describe("responsive field rows", () => {
  it("keeps paired fields in two columns through half-page desktop widths", () => {
    expect(styles).toMatch(
      /\.aag-form-row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*1fr 1fr;/s,
    );
    expect(styles).toContain("@container (max-width: 420px)");
  });

  it("collapses paired fields only for narrow containers and fallback viewports", () => {
    expect(styles).toMatch(
      /@container \(max-width: 420px\)\s*\{\s*\.aag-form-row\s*\{\s*grid-template-columns:\s*1fr;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width: 420px\)\s*\{\s*\.aag-form-row\s*\{\s*grid-template-columns:\s*1fr;/s,
    );
  });
});
