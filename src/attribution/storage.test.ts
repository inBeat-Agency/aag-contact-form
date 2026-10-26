import { afterEach, describe, expect, it } from "vitest";
import { MAX_TEXT_FIELD_CHARS } from "../../worker/src/limits";
import { resolveTouch } from "./source";
import { ATTRIBUTION_STORAGE_KEY, readState, writeState } from "./storage";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const touch = resolveTouch({
  url: "https://www.alphaapexgroup.com/?gclid=g-1",
  referrer: "",
  now: NOW,
});

afterEach(() => {
  window.localStorage.clear();
});

describe("readState — stored value is untrusted", () => {
  it("reads back a state it wrote", () => {
    writeState(window.localStorage, { first: touch, last: touch }, NOW);

    expect(readState(window.localStorage, NOW)).toEqual({ first: touch, last: touch });
  });

  it("treats a value longer than the Worker's field limit as no history and leaves it in place", () => {
    writeState(window.localStorage, { first: touch, last: touch }, NOW);
    const stored = JSON.parse(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY) ?? "{}");
    stored.first.source = "s".repeat(MAX_TEXT_FIELD_CHARS + 1);
    const raw = JSON.stringify(stored);
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, raw);

    expect(readState(window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBe(raw);
  });

  it("accepts a value exactly at the Worker's field limit", () => {
    const atLimit = { ...touch, landingPage: "u".repeat(MAX_TEXT_FIELD_CHARS) };
    writeState(window.localStorage, { first: atLimit, last: atLimit }, NOW);

    expect(readState(window.localStorage, NOW)?.first.landingPage).toHaveLength(MAX_TEXT_FIELD_CHARS);
  });
});
