import { describe, expect, it } from "vitest";
import { ATTRIBUTION_FIELD_KEYS, attributionFields } from "./fields";
import { MAX_TEXT_FIELD_CHARS } from "../../worker/src/limits";
import { resolveTouch } from "./source";
import type { AttributionState } from "./touches";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_DATE = new Date("2026-10-20T09:00:00.000Z");
const CONVERSION_PAGE = "https://www.alphaapexgroup.com/contact";

const paidFirst = resolveTouch({
  url: "https://www.alphaapexgroup.com/?utm_source=google&utm_medium=cpc&utm_campaign=q4&utm_term=hiring&utm_content=ad1&gclid=abc123",
  referrer: "https://www.google.com/",
  now: FIRST_DATE,
});
const organicLast = resolveTouch({
  url: "https://www.alphaapexgroup.com/services",
  referrer: "https://www.google.com/",
  now: new Date(FIRST_DATE.getTime() + 2 * DAY_MS),
});
const crossSession: AttributionState = { first: paidFirst, last: organicLast };

function toRecord(pairs: ReadonlyArray<readonly [string, string]>) {
  return Object.fromEntries(pairs);
}

describe("attributionFields", () => {
  it("emits the 22 wire keys in the exact contract order", () => {
    const expected = [
      "ft_channel",
      "ft_source",
      "ft_medium",
      "ft_campaign",
      "ft_term",
      "ft_content",
      "ft_click_id",
      "ft_landing_page",
      "ft_referrer",
      "ft_date",
      "lt_channel",
      "lt_source",
      "lt_medium",
      "lt_campaign",
      "lt_term",
      "lt_content",
      "lt_click_id",
      "lt_landing_page",
      "lt_referrer",
      "lt_date",
      "conversion_page",
      "days_to_convert",
    ];

    expect(ATTRIBUTION_FIELD_KEYS).toEqual(expected);
    expect(
      attributionFields(crossSession, new Date(), CONVERSION_PAGE).map(([key]) => key),
    ).toEqual(expected);
  });

  it("maps ft_ from the first touch and lt_ from the last touch across sessions", () => {
    const submittedAt = new Date(FIRST_DATE.getTime() + 2 * DAY_MS + 60_000);

    expect(toRecord(attributionFields(crossSession, submittedAt, CONVERSION_PAGE))).toEqual({
      ft_channel: "Paid Search",
      ft_source: "google",
      ft_medium: "cpc",
      ft_campaign: "q4",
      ft_term: "hiring",
      ft_content: "ad1",
      ft_click_id: "abc123",
      ft_landing_page: paidFirst.landingPage,
      ft_referrer: "https://www.google.com/",
      ft_date: "2026-10-20T09:00:00.000Z",
      lt_channel: "Organic Search",
      lt_source: "google",
      lt_medium: "organic",
      lt_campaign: "",
      lt_term: "",
      lt_content: "",
      lt_click_id: "",
      lt_landing_page: "https://www.alphaapexgroup.com/services",
      lt_referrer: "https://www.google.com/",
      lt_date: "2026-10-22T09:00:00.000Z",
      conversion_page: CONVERSION_PAGE,
      days_to_convert: "2",
    });
  });

  it.each([
    [0, "0"],
    [DAY_MS - 1, "0"],
    [DAY_MS, "1"],
    [2 * DAY_MS + DAY_MS / 2, "2"],
  ])("floors days_to_convert to whole days (%i ms after ft_date)", (elapsed, days) => {
    const fields = toRecord(
      attributionFields(crossSession, new Date(FIRST_DATE.getTime() + elapsed), CONVERSION_PAGE),
    );

    expect(fields.days_to_convert).toBe(days);
  });

  it("never reports negative days when the visitor's clock moved backwards", () => {
    const fields = toRecord(
      attributionFields(crossSession, new Date(FIRST_DATE.getTime() - DAY_MS), CONVERSION_PAGE),
    );

    expect(fields.days_to_convert).toBe("0");
  });

  it("sends identical ft_ and lt_ values for a first-visit conversion", () => {
    const fields = toRecord(
      attributionFields({ first: paidFirst, last: paidFirst }, FIRST_DATE, CONVERSION_PAGE),
    );

    for (const key of ATTRIBUTION_FIELD_KEYS.filter((name) => name.startsWith("ft_"))) {
      expect(fields[key.replace(/^ft_/, "lt_")]).toBe(fields[key]);
    }
    expect(fields.ft_campaign).toBe("q4");
    expect(fields.days_to_convert).toBe("0");
  });

  it("sends every key as an empty string when there is no stored state", () => {
    const pairs = attributionFields(null, FIRST_DATE, "");

    expect(pairs).toHaveLength(22);
    expect(pairs.every(([, value]) => value === "")).toBe(true);
  });

  it("still reports the conversion page without a stored state", () => {
    const fields = toRecord(attributionFields(null, FIRST_DATE, CONVERSION_PAGE));

    expect(fields.conversion_page).toBe(CONVERSION_PAGE);
    expect(fields.days_to_convert).toBe("");
  });

  it("keeps a long conversion_page whole below the Worker's field limit", () => {
    const longPage = `${CONVERSION_PAGE}?q=${"x".repeat(2100)}`;
    const fields = toRecord(attributionFields(null, FIRST_DATE, longPage));

    expect(fields.conversion_page).toBe(longPage);
  });

  it("cuts conversion_page only at the Worker's per-field limit", () => {
    const longPage = `${CONVERSION_PAGE}?q=${"x".repeat(MAX_TEXT_FIELD_CHARS)}`;
    const fields = toRecord(attributionFields(null, FIRST_DATE, longPage));

    expect(fields.conversion_page).toBe(longPage.slice(0, MAX_TEXT_FIELD_CHARS));
  });
});
