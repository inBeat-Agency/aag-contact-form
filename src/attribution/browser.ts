/**
 * Browser adapter for {@link captureLanding}: reads the live page and storage.
 *
 * Merely touching `window.localStorage` throws a `SecurityError` when the
 * browser blocks site data (some privacy settings, sandboxed iframes). The
 * scripts run inside a third-party page, so that must degrade to "no storage",
 * never to an exception.
 */

import { captureLanding } from "./capture";
import { readState } from "./storage";

type StorageName = "localStorage" | "sessionStorage";

function browserStorage(win: Window, name: StorageName) {
  try {
    return win[name];
  } catch {
    return null;
  }
}

export function captureFromBrowser(win: Window) {
  return captureLanding({
    url: win.location.href,
    referrer: win.document.referrer,
    now: new Date(),
    local: browserStorage(win, "localStorage"),
    session: browserStorage(win, "sessionStorage"),
  });
}

/** The stored state as of now, without treating this page view as a landing. */
export function readFromBrowser(win: Window) {
  return readState(browserStorage(win, "localStorage"), new Date());
}
