import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUBMIT_EVENT, trackSubmission } from "./analytics";

const PII_KEYS = [
  "firstName",
  "lastName",
  "name",
  "email",
  "workEmail",
  "message",
  "phone",
  "company",
  "title",
  "estimatedBudget",
  "budget",
  "resume",
];

function setQuery(search: string) {
  window.history.replaceState(null, "", `/contact-us${search}`);
}

function lastPush(): Record<string, unknown> {
  const layer = window.dataLayer as Record<string, unknown>[];
  return layer[layer.length - 1];
}

beforeEach(() => {
  delete window.dataLayer;
  setQuery("");
});

afterEach(() => {
  delete window.dataLayer;
  setQuery("");
});

describe("trackSubmission", () => {
  it("uses the event name GTM triggers on", () => {
    expect(SUBMIT_EVENT).toBe("aag_form_submit");
  });

  it("creates dataLayer when absent and pushes the expected payload", () => {
    trackSubmission({ inquiryType: "Consulting", source: "contact-page" });

    expect(window.dataLayer).toEqual([
      {
        event: "aag_form_submit",
        inquiry_type: "Consulting",
        form_source: "contact-page",
      },
    ]);
  });

  it("appends to an existing dataLayer without replacing it", () => {
    const existing: unknown[] = [{ event: "gtm.js" }];
    window.dataLayer = existing;

    trackSubmission({ inquiryType: "General Question", source: null });

    expect(window.dataLayer).toBe(existing);
    expect(existing).toHaveLength(2);
    expect(existing[0]).toEqual({ event: "gtm.js" });
  });

  it("includes interest from the URL query string", () => {
    setQuery("?interest=talent&utm_source=blog");

    trackSubmission({ inquiryType: "Recruitment / Hiring", source: null });

    expect(lastPush().interest).toBe("talent");
  });

  it("omits interest when the query param is absent or blank", () => {
    trackSubmission({ inquiryType: "Consulting", source: null });
    expect(lastPush()).not.toHaveProperty("interest");

    setQuery("?interest=%20%20");
    trackSubmission({ inquiryType: "Consulting", source: null });
    expect(lastPush()).not.toHaveProperty("interest");
  });

  it("trims and caps interest at 64 characters", () => {
    setQuery(`?interest=${encodeURIComponent(`  ${"x".repeat(200)}  `)}`);

    trackSubmission({ inquiryType: "Consulting", source: null });

    expect(lastPush().interest).toBe("x".repeat(64));
  });

  it("omits form_source when source is null or empty", () => {
    trackSubmission({ inquiryType: "Submit Resume", source: null });
    expect(lastPush()).not.toHaveProperty("form_source");

    trackSubmission({ inquiryType: "Submit Resume", source: "" });
    expect(lastPush()).not.toHaveProperty("form_source");
  });

  it("never throws when dataLayer.push throws", () => {
    window.dataLayer = {
      push: () => {
        throw new Error("hostile host page");
      },
    } as unknown as unknown[];

    expect(() =>
      trackSubmission({ inquiryType: "Consulting", source: "x" }),
    ).not.toThrow();
  });

  it("never throws when dataLayer is not an array", () => {
    window.dataLayer = "not-an-array" as unknown as unknown[];

    expect(() =>
      trackSubmission({ inquiryType: "Consulting", source: "x" }),
    ).not.toThrow();
  });

  it("only ever emits the allow-listed, non-PII keys", () => {
    setQuery("?interest=consulting");

    trackSubmission({ inquiryType: "Consulting", source: "contact-page" });

    const keys = Object.keys(lastPush());
    expect(keys.sort()).toEqual(
      ["event", "form_source", "inquiry_type", "interest"].sort(),
    );
    for (const key of PII_KEYS) expect(keys).not.toContain(key);
  });
});
