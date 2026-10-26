/**
 * First-party persistence for the attribution state (brief S1, S7).
 *
 * The state lives in `localStorage` under {@link ATTRIBUTION_STORAGE_KEY} with
 * a 90-day expiry that restarts on every landing, the way a first-party
 * cookie's expiry is refreshed on every write. Nothing here is sent anywhere:
 * the values only leave the browser inside a contact form submission.
 *
 * CONSENT (S7): {@link canStore} is the one consent decision. `captureLanding`
 * (`capture.ts`) asks it before every write — this state and the session
 * marker — so {@link writeState} is a plain writer. The site has no consent
 * manager today — GTM already fires GA4 and the Ads conversion linker
 * unconditionally — so it allows every write. When a consent manager is added,
 * hook it into `canStore` and nowhere else.
 *
 * The stored value is untrusted input: another script, an older bundle or the
 * visitor can change it. It is validated field by field, and anything that
 * does not match — including a value longer than the Worker's per-field limit,
 * which would get the whole lead refused — is treated as no history rather
 * than repaired.
 */

import { MAX_TEXT_FIELD_CHARS } from "../../worker/src/limits";
import { CHANNELS, type Channel } from "./channel";
import type { Touch } from "./source";
import type { AttributionState } from "./touches";

export const ATTRIBUTION_STORAGE_KEY = "aag_attribution";
export const ATTRIBUTION_TTL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const STORED_VERSION = 1;

export function canStore() {
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChannel(value: unknown): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

function isStoredText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_FIELD_CHARS;
}

function parseTouch(value: unknown): Touch | null {
  if (!isRecord(value)) return null;

  const { channel, source, medium, campaign, term, content, clickId, landingPage, referrer, date } =
    value;
  if (
    !isChannel(channel) ||
    !isStoredText(source) ||
    !isStoredText(medium) ||
    !isStoredText(campaign) ||
    !isStoredText(term) ||
    !isStoredText(content) ||
    !isStoredText(clickId) ||
    !isStoredText(landingPage) ||
    !isStoredText(referrer) ||
    !isStoredText(date) ||
    Number.isNaN(Date.parse(date))
  ) {
    return null;
  }

  return {
    channel,
    source,
    medium,
    campaign,
    term,
    content,
    clickId,
    landingPage,
    referrer,
    date,
  };
}

/** The stored state, or `null` when absent, expired, corrupted or unreadable. */
export function readState(storage: Storage | null, now: Date): AttributionState | null {
  if (!storage) return null;

  let parsed: unknown;
  try {
    const raw = storage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (raw === null) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== STORED_VERSION) return null;
  if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now.getTime()) return null;

  const first = parseTouch(parsed.first);
  const last = parseTouch(parsed.last);
  return first && last ? { first, last } : null;
}

/**
 * Persist the state for another 90 days; reports whether it was stored. Never
 * throws; quota or privacy errors drop the write. Does not ask {@link canStore}:
 * its caller does.
 */
export function writeState(storage: Storage | null, state: AttributionState, now: Date) {
  if (!storage) return false;

  try {
    storage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({
        version: STORED_VERSION,
        expiresAt: now.getTime() + ATTRIBUTION_TTL_DAYS * DAY_MS,
        first: state.first,
        last: state.last,
      }),
    );
    return true;
  } catch {
    // Storage full or blocked: this landing is still returned in memory.
    return false;
  }
}
