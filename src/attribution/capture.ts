/**
 * Landing capture (brief S1): decide whether this page view is a landing, and
 * if so fold its touch into the stored first/last-touch state.
 *
 * A landing is "a new session or a new campaign click":
 *
 * - New session: no session marker in `sessionStorage`. The marker is per tab
 *   and dies with the browser session, which is what a returning visitor looks
 *   like days later.
 * - New campaign click: the URL carries a UTM or an ad click ID, even inside an
 *   open session — a second ad click is a new last touch.
 *
 * Any other page view is internal browsing and changes nothing. That is what
 * keeps a UTM landing's values intact through the pages a visitor reads before
 * reaching the contact form.
 *
 * Both the site-wide tracker and the widget call this. Calling it twice on one
 * page view is harmless: the first call opens the session, so the second one
 * is internal browsing unless the URL is a campaign click, in which case it
 * rewrites last touch with identical values.
 */

import { resolveTouch, type Landing } from "./source";
import { readState, writeState } from "./storage";
import { applyLanding, type AttributionState } from "./touches";

export const SESSION_STORAGE_KEY = "aag_attribution_session";

const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "fbclid",
  "li_fat_id",
  "ttclid",
] as const;

export type CaptureEnvironment = Landing & {
  local: Storage | null;
  session: Storage | null;
};

function isCampaignClick(url: string) {
  try {
    const params = new URL(url).searchParams;
    return CAMPAIGN_PARAMS.some((param) => params.get(param)?.trim());
  } catch {
    return false;
  }
}

/** Open the session; reports whether it was already open. Unreadable storage counts as a new session. */
function openSession(session: Storage | null) {
  if (!session) return false;
  try {
    const wasOpen = session.getItem(SESSION_STORAGE_KEY) !== null;
    session.setItem(SESSION_STORAGE_KEY, "1");
    return wasOpen;
  } catch {
    return false;
  }
}

/**
 * Returns the state after this page view. Without usable storage the state is
 * still computed from this landing, so a submission on the same page keeps it.
 */
export function captureLanding(environment: CaptureEnvironment): AttributionState {
  const { local, session, ...landing } = environment;
  const stored = readState(local, landing.now);
  const sessionWasOpen = openSession(session);

  if (stored && sessionWasOpen && !isCampaignClick(landing.url)) return stored;

  const state = applyLanding(stored, resolveTouch(landing));
  writeState(local, state, landing.now);
  return state;
}
