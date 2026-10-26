import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFromBrowser } from "./browser";
import { ATTRIBUTION_STORAGE_KEY } from "./storage";

function setReferrer(referrer: string) {
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/services?utm_source=google&utm_medium=cpc&utm_campaign=q4");
  setReferrer("https://www.google.com/");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  setReferrer("");
});

describe("captureFromBrowser", () => {
  it("captures the current page URL and document.referrer into localStorage", () => {
    const state = captureFromBrowser(window);

    expect(state.first).toMatchObject({
      channel: "Paid Search",
      campaign: "q4",
      landingPage: window.location.href,
      referrer: "https://www.google.com/",
    });
    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toContain('"campaign":"q4"');
  });

  it("still returns the landing when the browser blocks storage access", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(captureFromBrowser(window).first).toMatchObject({ campaign: "q4" });
  });
});
