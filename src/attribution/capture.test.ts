import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLanding } from "./capture";
import { ATTRIBUTION_STORAGE_KEY } from "./storage";

const SITE = "https://www.alphaapexgroup.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T09:00:00.000Z");

function at(days: number) {
  return new Date(T0.getTime() + days * DAY_MS);
}

function visit(path: string, referrer: string, now: Date) {
  return captureLanding({
    url: `${SITE}${path}`,
    referrer,
    now,
    local: window.localStorage,
    session: window.sessionStorage,
  });
}

/** A browser restart: localStorage survives, sessionStorage does not. */
function endSession() {
  window.sessionStorage.clear();
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("captureLanding — S4 first and last touch", () => {
  it("writes both touches identically on the very first landing", () => {
    const state = visit("/?gclid=g-1", "", T0);

    expect(state?.first).toEqual(state?.last);
    expect(state?.first).toMatchObject({ channel: "Paid Search", source: "google", clickId: "g-1" });
  });

  it("never overwrites first touch, while a new landing with a known source overwrites last touch", () => {
    visit("/?utm_source=google&utm_medium=cpc&utm_campaign=q4", "", T0);
    endSession();
    const state = visit("/insights", "https://www.google.com/", at(3));

    expect(state?.first).toMatchObject({ channel: "Paid Search", campaign: "q4", date: T0.toISOString() });
    expect(state?.last).toMatchObject({
      channel: "Organic Search",
      source: "google",
      medium: "organic",
      date: at(3).toISOString(),
    });
  });

  it("does not let a direct return visit overwrite last touch", () => {
    visit("/", "https://www.linkedin.com/feed/", T0);
    endSession();
    const state = visit("/", "", at(1));

    expect(state?.last).toMatchObject({ channel: "Organic Social", source: "linkedin", date: T0.toISOString() });
  });

  it("still records a direct first landing as first and last touch", () => {
    const state = visit("/", "", T0);

    expect(state?.first).toMatchObject({ channel: "Direct", source: "(direct)", medium: "(none)" });
    expect(state?.last).toEqual(state?.first);
  });
});

describe("captureLanding — S1 what counts as a landing", () => {
  it("keeps the UTM values through 3+ pages of browsing in the same session", () => {
    visit("/?utm_source=google&utm_medium=cpc&utm_campaign=q4", "", T0);
    visit("/services", `${SITE}/`, at(0.01));
    visit("/about", `${SITE}/services`, at(0.02));
    const state = visit("/contact-us", `${SITE}/about`, at(0.03));

    for (const touch of [state?.first, state?.last]) {
      expect(touch).toMatchObject({
        source: "google",
        medium: "cpc",
        campaign: "q4",
        landingPage: `${SITE}/?utm_source=google&utm_medium=cpc&utm_campaign=q4`,
        date: T0.toISOString(),
      });
    }
  });

  it("treats a campaign click inside an open session as a new landing", () => {
    visit("/", "https://www.google.com/", T0);
    const state = visit("/?utm_source=newsletter&utm_medium=email", `${SITE}/`, at(0.5));

    expect(state?.first).toMatchObject({ channel: "Organic Search" });
    expect(state?.last).toMatchObject({ channel: "Email", source: "newsletter" });
  });

  it("captures one campaign page view once, even when tracker and widget both run", () => {
    const first = visit("/?gclid=a", "", T0);
    const second = visit("/?gclid=a", "", new Date(T0.getTime() + 1000));

    expect(second).toEqual(first);
    expect(second.last).toEqual(second.first);
    expect(second.last.date).toBe(T0.toISOString());
  });

  it("does not treat a reload of the same campaign URL as a new click", () => {
    visit("/?gclid=a", "", T0);
    visit("/services", `${SITE}/?gclid=a`, at(0.01));
    const state = visit("/?gclid=a", "", at(0.02));

    expect(state.last.date).toBe(T0.toISOString());
  });

  it("does not re-evaluate an external referrer once the session is open", () => {
    visit("/", "https://www.google.com/", T0);
    const state = visit("/about", "https://www.bing.com/", at(0.1));

    expect(state?.last).toMatchObject({ source: "google", date: T0.toISOString() });
  });
});

describe("captureLanding — S1 storage and 90-day expiry", () => {
  it("persists the state in first-party localStorage", () => {
    visit("/?gclid=g-1", "", T0);

    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toContain("g-1");
  });

  it("keeps the stored touches 89 days after the last landing", () => {
    visit("/?gclid=g-1", "", T0);
    endSession();
    const state = visit("/", "", at(89));

    expect(state?.first).toMatchObject({ clickId: "g-1" });
  });

  it("starts over with a new first touch once 90 days pass without a landing", () => {
    visit("/?gclid=g-1", "", T0);
    endSession();
    const state = visit("/", "https://www.bing.com/", at(91));

    expect(state?.first).toMatchObject({ source: "bing", date: at(91).toISOString() });
  });

  it("restarts the 90 days on every landing", () => {
    visit("/?gclid=g-1", "", T0);
    endSession();
    visit("/", "", at(60));
    endSession();
    const state = visit("/", "", at(120));

    expect(state?.first).toMatchObject({ clickId: "g-1" });
  });

  it("treats a corrupted stored value as no history", () => {
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, '{"first":42}');
    const state = visit("/", "https://www.google.com/", T0);

    expect(state?.first).toMatchObject({ source: "google", date: T0.toISOString() });
  });

  it("still returns this landing's touches when storage is unavailable", () => {
    const state = captureLanding({
      url: `${SITE}/?gclid=g-1`,
      referrer: "",
      now: T0,
      local: null,
      session: null,
    });

    expect(state.first).toMatchObject({ clickId: "g-1" });
    expect(state.last).toEqual(state.first);
  });
});

describe("captureLanding — a failed write never closes the session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a new campaign landing when localStorage is full and the page is captured twice", () => {
    visit("/", "https://www.google.com/", T0);
    endSession();
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage) throw new DOMException("quota exceeded", "QuotaExceededError");
      realSetItem.call(this, key, value);
    });

    visit("/?gclid=g-2", "", at(1));
    const state = visit("/?gclid=g-2", "", at(1.001));

    expect(state.first).toMatchObject({ source: "google", medium: "organic" });
    expect(state.last).toMatchObject({ channel: "Paid Search", clickId: "g-2" });
    expect(window.sessionStorage.length).toBe(0);
  });
});
