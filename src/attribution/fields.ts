/**
 * Hidden attribution fields (brief S5): the stored first/last-touch state as
 * the 22 flat keys the form submits.
 *
 * WIRE CONTRACT: the keys and their order are read by the Worker
 * (`worker/src/payload.ts`) and mapped field by field in Zapier. The widget may
 * not import the Worker's list, so it is restated here; renaming or reordering
 * a key breaks the Zap — change both sides in the same change.
 *
 * Every key is always present. Unknown values are sent as empty strings, never
 * omitted, so the Zapier field picker sees a stable shape.
 */

import { capAttributionValue, type Touch } from "./source";
import type { AttributionState } from "./touches";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wire suffix → `Touch` property, in wire order. */
const TOUCH_FIELDS = [
  ["channel", "channel"],
  ["source", "source"],
  ["medium", "medium"],
  ["campaign", "campaign"],
  ["term", "term"],
  ["content", "content"],
  ["click_id", "clickId"],
  ["landing_page", "landingPage"],
  ["referrer", "referrer"],
  ["date", "date"],
] as const satisfies ReadonlyArray<readonly [string, keyof Touch]>;

export const ATTRIBUTION_FIELD_KEYS = [
  ...TOUCH_FIELDS.map(([suffix]) => `ft_${suffix}`),
  ...TOUCH_FIELDS.map(([suffix]) => `lt_${suffix}`),
  "conversion_page",
  "days_to_convert",
] as const;

export type AttributionFields = ReadonlyArray<readonly [string, string]>;

function touchFields(prefix: "ft" | "lt", touch: Touch | undefined) {
  return TOUCH_FIELDS.map(
    ([suffix, property]) => [`${prefix}_${suffix}`, touch?.[property] ?? ""] as const,
  );
}

/** Whole days from the first touch to `submittedAt`, floored; never negative. */
function daysToConvert(first: Touch | undefined, submittedAt: Date) {
  const firstAt = first ? Date.parse(first.date) : Number.NaN;
  if (Number.isNaN(firstAt)) return "";
  return String(Math.max(0, Math.floor((submittedAt.getTime() - firstAt) / DAY_MS)));
}

export function attributionFields(
  state: AttributionState | null,
  submittedAt: Date,
  conversionPage: string,
): AttributionFields {
  return [
    ...touchFields("ft", state?.first),
    ...touchFields("lt", state?.last),
    ["conversion_page", capAttributionValue(conversionPage)],
    ["days_to_convert", daysToConvert(state?.first, submittedAt)],
  ];
}
