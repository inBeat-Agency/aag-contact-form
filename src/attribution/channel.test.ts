import { describe, expect, it } from "vitest";
import { channelFor } from "./channel";

describe("channelFor — S3 channel grouping", () => {
  it.each([
    ["google", "cpc", "Paid Search"],
    ["google", "ppc", "Paid Search"],
    ["bing", "paid_search", "Paid Search"],
    ["facebook", "paid_social", "Paid Social"],
    ["google", "organic", "Organic Search"],
    ["linkedin", "social", "Organic Social"],
    ["chatgpt", "ai", "AI Assistant"],
    ["newsletter", "email", "Email"],
    ["industry-news.com", "referral", "Referral"],
    ["(direct)", "(none)", "Direct"],
    ["partner", "display", "Other"],
    ["", "", "Other"],
  ] as const)("source %s + medium %s → %s", (source, medium, channel) => {
    expect(channelFor(source, medium)).toBe(channel);
  });

  it("matches medium case-insensitively, since UTMs are kept as typed", () => {
    expect(channelFor("Google", "CPC")).toBe("Paid Search");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "groups the inherited object key %s as a medium under Other",
    (medium) => {
      expect(channelFor("partner", medium)).toBe("Other");
    },
  );

  it("lets a medium rule win over the direct source rule", () => {
    expect(channelFor("(direct)", "email")).toBe("Email");
  });
});
