/**
 * Channel grouping (brief S3): roll a source/medium pair up into the fixed list
 * of channels the first-touch and last-touch reports group by.
 *
 * PUBLIC CONTRACT WITH LOXO: `ft_channel` and `lt_channel` are dropdowns whose
 * options are exactly {@link CHANNELS}. Renaming one leaves every new lead with
 * a value the dropdown does not contain — update Loxo and Airtable in the same
 * change.
 */

export const CHANNELS = [
  "Paid Search",
  "Paid Social",
  "Organic Search",
  "Organic Social",
  "AI Assistant",
  "Email",
  "Referral",
  "Direct",
  "Other",
] as const;

export type Channel = (typeof CHANNELS)[number];

export const DIRECT_SOURCE = "(direct)";
export const DIRECT_MEDIUM = "(none)";

/** A `Map`, not an object literal: a medium such as `constructor` must not find an inherited key. */
const CHANNEL_BY_MEDIUM: ReadonlyMap<string, Channel> = new Map([
  ["cpc", "Paid Search"],
  ["ppc", "Paid Search"],
  ["paid_search", "Paid Search"],
  ["paid_social", "Paid Social"],
  ["organic", "Organic Search"],
  ["social", "Organic Social"],
  ["ai", "AI Assistant"],
  ["email", "Email"],
  ["referral", "Referral"],
]);

/**
 * Medium rules are checked before the direct rule, in the brief's table order.
 * Medium is compared case-insensitively: UTM values are stored exactly as the
 * campaign link typed them, and `CPC` is still a paid click.
 */
export function channelFor(source: string, medium: string): Channel {
  const byMedium = CHANNEL_BY_MEDIUM.get(medium.trim().toLowerCase());
  if (byMedium) return byMedium;
  if (source === DIRECT_SOURCE) return "Direct";
  return "Other";
}
