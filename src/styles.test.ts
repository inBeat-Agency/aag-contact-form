import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");
const fields = readFileSync("src/fields.tsx", "utf8");
const contactForm = readFileSync("src/ContactForm.tsx", "utf8");
const uncommentedStyles = styles.replace(/\/\*[\s\S]*?\*\//g, "");

type CssRule = {
  selector: string;
  declarations: string[];
};

function rulesContaining(selectorPart: string): CssRule[] {
  return [...uncommentedStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([selector]) => selector.includes(selectorPart))
    .map(([, selector, body]) => ({
      selector: selector.trim(),
      declarations: body
        .split(";")
        .map((declaration) => declaration.trim())
        .filter(Boolean),
    }));
}

function declarationNames(rule: CssRule): string[] {
  return rule.declarations.map((declaration) => declaration.split(":", 1)[0]);
}

describe("widget theme defaults", () => {
  it("uses fallbacks instead of shadowing host custom property overrides", () => {
    expect(styles).not.toMatch(
      /\.aag-form-root\s*\{(?:(?!\}).)*--aag-form-accent:/s,
    );
  });
});

describe("webflow style handover", () => {
  // The widget's runtime-injected <style> lands after Webflow's stylesheet, so
  // at equal specificity the widget wins. Adding Webflow classes is therefore
  // not enough — the competing widget declarations must stay deleted or Webflow
  // gets no control over the fields and the button.
  it("no longer styles the field and button classes Webflow now owns", () => {
    expect(styles).not.toContain(".aag-form-submit");
    expect(styles).not.toContain(".aag-form-input");
    expect(styles).not.toContain(".aag-form-select");
    expect(styles).not.toContain(".aag-form-textarea");
  });

  it("applies the Webflow style-guide classes to the fields and the button", () => {
    expect(fields).toContain('className="form_input w-input"');
    expect(fields).toContain('className="form_input is-select-input w-select"');
    expect(fields).toContain('className="form_input is-text-area w-input"');
    expect(contactForm).toContain('className="button is-form-submit w-button"');
  });

  // Webflow's base stylesheet ships `.w-form-done` and `.w-form-fail` with
  // `display: none`; Webflow's own form JS is what reveals them. This widget
  // does not load that JS — React controls visibility by conditional render —
  // so wearing those classes would make the success panel and the error banner
  // permanently invisible on the live page. The jsdom suite cannot catch this
  // because it never loads the Webflow stylesheet, hence this static guard.
  it("never wears the Webflow classes that are display:none by default", () => {
    // Assert against the rendered class lists only, so the explanatory comment
    // in ContactForm.tsx can name these classes without tripping the guard.
    const classLists = [...contactForm.matchAll(/className="([^"]*)"/g)].map(
      (match) => match[1],
    );

    expect(classLists.length).toBeGreaterThan(0);
    for (const classList of classLists) {
      expect(classList.split(/\s+/)).not.toContain("w-form-done");
      expect(classList.split(/\s+/)).not.toContain("w-form-fail");
    }
  });

  it("keeps keyboard focus visible on invalid controls Webflow otherwise clears", () => {
    expect(styles).toMatch(
      /\.aag-form-root \.form_input\[aria-invalid="true"\]:focus-visible,\s*\.aag-form-root \.aag-form-file\[aria-invalid="true"\]:focus-visible\s*\{\s*outline:\s*2px solid var\(--text-color--text-error, #d1293d\);\s*outline-offset:\s*2px;/s,
    );
  });

  it("keeps textarea resizing as widget-owned containment behaviour", () => {
    expect(styles).toMatch(
      /\.aag-form-root \.form_input\.is-text-area\s*\{\s*resize:\s*vertical;/s,
    );
  });

  it("limits form_input overrides to widget layout and invalid-state behaviour", () => {
    const formInputRules = rulesContaining(".form_input");
    const allowedDeclarations = new Set([
      "margin-bottom",
      "border-color",
      "outline",
      "outline-offset",
      "resize",
    ]);
    const webflowOwnedDeclarations = [
      "padding",
      "font-size",
      "font-family",
      "color",
      "background",
      "min-height",
      "height",
      "border-radius",
      "appearance",
      "transition",
      "box-shadow",
    ];

    expect(formInputRules.length).toBeGreaterThan(0);
    for (const rule of formInputRules) {
      const names = declarationNames(rule);

      expect(names.every((name) => allowedDeclarations.has(name))).toBe(true);
      expect(names.some((name) => webflowOwnedDeclarations.includes(name))).toBe(false);
    }
  });

  it("limits button overrides to the disabled-state and focus affordances", () => {
    // `outline` is allowed for the same reason it is allowed on `.form_input`
    // above: Webflow's style guide never declares it, it does not affect
    // layout, and it is the keyboard-accessibility affordance rather than
    // visual identity. Everything else on `.button` stays Webflow's to own.
    const allowed = ["opacity", "cursor", "outline", "outline-offset"];

    for (const rule of rulesContaining(".button")) {
      expect(declarationNames(rule).every((name) => allowed.includes(name))).toBe(true);
    }
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
