/**
 * First-touch vs. last-touch rules (brief S4).
 *
 * - First touch is written on the visitor's very first landing and never
 *   overwritten.
 * - Last touch is overwritten on each new landing with a known source. A direct
 *   landing never overwrites it (last non-direct click).
 * - A visitor who converts on their first visit has identical touches. That is
 *   expected, not a bug.
 */

import { DIRECT_SOURCE } from "./channel";
import type { Touch } from "./source";

export type AttributionState = {
  first: Touch;
  last: Touch;
};

/**
 * The state whose last touch is more recent; `b` wins a tie. Pass storage as
 * `a` and this page's capture as `b`: when the write landed both are the same,
 * and when it failed the capture is the newer one.
 */
export function newerState(a: AttributionState | null, b: AttributionState | null) {
  if (!a || !b) return a ?? b;
  return Date.parse(b.last.date) >= Date.parse(a.last.date) ? b : a;
}

export function applyLanding(state: AttributionState | null, touch: Touch): AttributionState {
  if (!state) return { first: touch, last: touch };
  if (touch.source === DIRECT_SOURCE) return state;
  return { first: state.first, last: touch };
}
