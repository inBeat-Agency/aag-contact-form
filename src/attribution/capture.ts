/**
 * Landing capture (brief S1): decide whether this page view is a landing, and
 * if so fold its touch into the stored first/last-touch state.
 *
 * A landing is "a new session or a new campaign click":
 *
 * - New session: no session marker in `sessionStorage`. The marker is per tab
 *   and dies with the browser session, which is what a returning visitor looks
 *   like days later.
 * - New campaign click: the URL carries a UTM or an ad click ID and differs
 *   from the URL this session last captured, even inside an open session — a
 *   second ad click is a new last touch, a reload of the same one is not.
 *
 * The marker's value is the URL this session last captured as a landing.
 *
 * Any other page view is internal browsing and changes nothing. That is what
 * keeps a UTM landing's values intact through the pages a visitor reads before
 * reaching the contact form.
 *
 * Both the site-wide tracker and the widget call this on the same page view.
 * The second call finds its own URL in the marker, so it changes nothing and a
 * first-visit conversion keeps first and last touch identical (S4).
 *
 * CONSENT (S7): this is the one place that writes, and it asks `canStore()`
 * before every write — the stored state and the session marker alike. When it
 * refuses, nothing is written and this landing is still returned in memory.
 */

import { resolveTouch, type Landing } from "./source";
import { canStore, readState, writeState } from "./storage";
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

/** The URL this session last captured, or `null` for a new session. Unreadable storage counts as a new session. */
function readSessionLanding(session: Storage | null) {
  try {
    return session?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeSessionLanding(session: Storage | null, url: string) {
  try {
    session?.setItem(SESSION_STORAGE_KEY, url);
  } catch {
    // Storage full or blocked: the next page view counts as a new session.
  }
}

/**
 * Returns the state after this page view. Without usable storage the state is
 * still computed from this landing, so a submission on the same page keeps it.
 */
export function captureLanding(environment: CaptureEnvironment): AttributionState {
  const { local, session, ...landing } = environment;
  const stored = readState(local, landing.now);
  const sessionLanding = readSessionLanding(session);
  const isNewLanding =
    sessionLanding === null || (isCampaignClick(landing.url) && landing.url !== sessionLanding);

  if (stored && !isNewLanding) return stored;

  const state = applyLanding(stored, resolveTouch(landing));
  if (canStore()) {
    writeState(local, state, landing.now);
    writeSessionLanding(session, landing.url);
  }
  return state;
}
