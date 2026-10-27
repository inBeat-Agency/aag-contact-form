import { describe, expect, it } from "vitest";
import { MAX_TEXT_FIELD_CHARS } from "../../worker/src/limits";
import { resolveTouch } from "./source";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const PAGE = "https://www.alphaapexgroup.com/services";

function touchFor(url: string, referrer = "") {
  return resolveTouch({ url, referrer, now: NOW });
}

describe("resolveTouch — S2 rule 1: UTMs present", () => {
  it("uses the five UTM values as they are", () => {
    const touch = touchFor(
      `${PAGE}?utm_source=Google&utm_medium=CPC&utm_campaign=Q4 Launch&utm_term=hr consulting&utm_content=ad-b`,
      "https://www.google.com/",
    );

    expect(touch).toMatchObject({
      source: "Google",
      medium: "CPC",
      campaign: "Q4 Launch",
      term: "hr consulting",
      content: "ad-b",
      channel: "Paid Search",
    });
  });

  it("wins over a click ID and still records the click ID value", () => {
    const touch = touchFor(`${PAGE}?utm_source=newsletter&utm_medium=email&gclid=abc123`);

    expect(touch).toMatchObject({
      source: "newsletter",
      medium: "email",
      clickId: "abc123",
      channel: "Email",
    });
  });

  it("counts a single UTM parameter as UTMs present", () => {
    const touch = touchFor(`${PAGE}?utm_campaign=spring`, "https://www.google.com/");

    expect(touch).toMatchObject({ source: "", medium: "", campaign: "spring", channel: "Other" });
  });
});

describe("resolveTouch — S2 rule 2: ad click ID without UTMs", () => {
  it.each([
    ["gclid", "google"],
    ["gbraid", "google"],
    ["wbraid", "google"],
    ["msclkid", "bing"],
    ["fbclid", "facebook"],
    ["li_fat_id", "linkedin"],
    ["ttclid", "tiktok"],
  ] as const)("%s sets source %s, medium cpc and stores the ID", (param, source) => {
    const touch = touchFor(`${PAGE}?${param}=id-${param}`, "https://www.google.com/");

    expect(touch).toMatchObject({
      source,
      medium: "cpc",
      campaign: "",
      clickId: `id-${param}`,
      channel: "Paid Search",
    });
  });
});

describe("resolveTouch — S2 rule 3: search engine referrer", () => {
  it.each([
    ["https://www.google.com/", "google"],
    ["https://www.google.co.uk/", "google"],
    ["https://google.de/", "google"],
    ["https://www.bing.com/search?q=x", "bing"],
    ["https://search.yahoo.com/", "yahoo"],
    ["https://duckduckgo.com/", "duckduckgo"],
    ["https://www.baidu.com/", "baidu"],
    ["https://yandex.ru/", "yandex"],
    ["https://www.ecosia.org/", "ecosia"],
    ["https://search.brave.com/", "brave"],
  ] as const)("%s records source %s, medium organic", (referrer, source) => {
    expect(touchFor(PAGE, referrer)).toMatchObject({
      source,
      medium: "organic",
      referrer,
      channel: "Organic Search",
    });
  });
});

describe("resolveTouch — S2 rule 4: social referrer", () => {
  it.each([
    ["https://www.facebook.com/", "facebook"],
    ["https://l.facebook.com/l.php", "facebook"],
    ["https://www.instagram.com/", "instagram"],
    ["https://www.linkedin.com/feed/", "linkedin"],
    ["https://lnkd.in/abc", "linkedin"],
    ["https://t.co/xyz", "x"],
    ["https://x.com/", "x"],
    ["https://twitter.com/", "x"],
    ["https://www.youtube.com/", "youtube"],
    ["https://youtu.be/abc", "youtube"],
    ["https://www.reddit.com/r/x", "reddit"],
    ["https://www.tiktok.com/", "tiktok"],
  ] as const)("%s records source %s, medium social", (referrer, source) => {
    expect(touchFor(PAGE, referrer)).toMatchObject({
      source,
      medium: "social",
      channel: "Organic Social",
    });
  });
});

describe("resolveTouch — S2 rule 5: AI assistant referrer", () => {
  it.each([
    ["https://chatgpt.com/", "chatgpt"],
    ["https://www.perplexity.ai/", "perplexity"],
    ["https://gemini.google.com/app", "gemini"],
    ["https://copilot.microsoft.com/", "copilot"],
    ["https://claude.ai/chat/1", "claude"],
  ] as const)("%s records source %s, medium ai", (referrer, source) => {
    expect(touchFor(PAGE, referrer)).toMatchObject({
      source,
      medium: "ai",
      channel: "AI Assistant",
    });
  });
});

describe("resolveTouch — S2 rule 6: any other external referrer", () => {
  it("records the referring domain without www, medium referral", () => {
    expect(touchFor(PAGE, "https://www.industry-news.com/article/42")).toMatchObject({
      source: "industry-news.com",
      medium: "referral",
      referrer: "https://www.industry-news.com/article/42",
      channel: "Referral",
    });
  });
});

describe("resolveTouch — S2 rule 7: no referrer", () => {
  it("records (direct) / (none)", () => {
    expect(touchFor(PAGE, "")).toMatchObject({
      source: "(direct)",
      medium: "(none)",
      referrer: "",
      channel: "Direct",
    });
  });

  it("treats an unparseable referrer as no referrer", () => {
    expect(touchFor(PAGE, "not a url")).toMatchObject({ source: "(direct)", medium: "(none)" });
  });
});

describe("resolveTouch — ignored referrers", () => {
  it.each([
    "https://www.alphaapexgroup.com/about",
    "https://alphaapexgroup.com/",
    "https://careers.alphaapexgroup.com/",
    "https://accounts.google.com/signin",
    "https://login.microsoftonline.com/",
    "https://www.paypal.com/checkout",
    "https://checkout.stripe.com/pay",
  ])("%s is ignored and counts as direct", (referrer) => {
    expect(touchFor(PAGE, referrer)).toMatchObject({
      source: "(direct)",
      medium: "(none)",
      referrer: "",
      channel: "Direct",
    });
  });

  it("ignores the current host, so a staging domain never refers itself", () => {
    const touch = resolveTouch({
      url: "https://aag.webflow.io/services",
      referrer: "https://aag.webflow.io/",
      now: NOW,
    });

    expect(touch).toMatchObject({ source: "(direct)", medium: "(none)" });
  });
});

describe("resolveTouch — recorded context", () => {
  it("records the full landing URL and the landing time", () => {
    const url = `${PAGE}?utm_source=x#top`;

    expect(touchFor(url)).toMatchObject({ landingPage: url, date: NOW.toISOString() });
  });

  it("keeps UTM and click ID values exactly as received, surrounding spaces included", () => {
    const touch = touchFor(`${PAGE}?utm_source=%20Google%20&gclid=%20g-1%20`);

    expect(touch).toMatchObject({ source: " Google ", clickId: " g-1 " });
  });

  it("does not count a whitespace-only parameter as present", () => {
    const touch = touchFor(`${PAGE}?utm_source=%20&gclid=%20`, "https://www.google.com/");

    expect(touch).toMatchObject({ source: "google", medium: "organic", clickId: "" });
  });

  it("preserves a long campaign, landing URL and referrer below the Worker's field limit", () => {
    const campaign = "c".repeat(501);
    const url = `${PAGE}?utm_campaign=${campaign}&q=${"x".repeat(2100)}`;
    const referrer = `https://industry-news.com/?q=${"r".repeat(2100)}`;
    const touch = touchFor(url, referrer);

    expect(touch.campaign).toBe(campaign);
    expect(touch.landingPage).toBe(url);
    expect(touch.referrer).toBe(referrer);
  });

  it("cuts a value only at the Worker's per-field limit, so the lead is never refused", () => {
    const tooLong = MAX_TEXT_FIELD_CHARS + 100;
    const touch = touchFor(
      `${PAGE}?utm_campaign=${"a".repeat(tooLong)}&gclid=${"g".repeat(tooLong)}`,
      `https://industry-news.com/?q=${"r".repeat(tooLong)}`,
    );

    expect(touch.campaign).toHaveLength(MAX_TEXT_FIELD_CHARS);
    expect(touch.clickId).toHaveLength(MAX_TEXT_FIELD_CHARS);
    expect(touch.landingPage).toHaveLength(MAX_TEXT_FIELD_CHARS);
    expect(touch.referrer).toHaveLength(MAX_TEXT_FIELD_CHARS);
  });
});

describe("resolveTouch — whitespace-only values", () => {
  it("preserves whitespace-only content when other UTMs identify the source", () => {
    const touch = touchFor(`${PAGE}?utm_source=google&utm_medium=cpc&utm_content=%20`);

    expect(touch).toMatchObject({ source: "google", medium: "cpc", content: " " });
  });

  it("does not let whitespace-only UTMs or click IDs override the referrer", () => {
    const touch = touchFor(`${PAGE}?utm_source=%20&gclid=%20`, "https://www.google.com/");

    expect(touch).toMatchObject({ source: "google", medium: "organic", channel: "Organic Search" });
  });
});
