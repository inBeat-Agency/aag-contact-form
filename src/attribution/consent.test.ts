import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLanding } from "./capture";

vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  canStore: () => false,
}));

const NOW = new Date("2026-10-26T12:00:00.000Z");

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("captureLanding — S7 consent gate", () => {
  it("writes nothing to either storage when canStore refuses, and still returns this landing", () => {
    const state = captureLanding({
      url: "https://www.alphaapexgroup.com/?gclid=g-1",
      referrer: "",
      now: NOW,
      local: window.localStorage,
      session: window.sessionStorage,
    });

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(state.first).toMatchObject({
      channel: "Paid Search",
      source: "google",
      medium: "cpc",
      clickId: "g-1",
      date: NOW.toISOString(),
    });
    expect(state.last).toEqual(state.first);
  });
});
