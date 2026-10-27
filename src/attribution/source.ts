/**
 * Traffic-source resolution (brief S2): turn one landing — its URL, its
 * referrer and the time — into a {@link Touch}.
 *
 * The rules run in the brief's priority order and the first match wins:
 *
 *   1. UTMs present            → the five UTM values as they are
 *   2. ad click ID, no UTMs    → source from the ID, medium `cpc`
 *   3. search engine referrer  → engine name / `organic`
 *   4. social referrer         → network / `social`
 *   5. AI assistant referrer   → assistant / `ai`
 *   6. other external referrer → domain / `referral`
 *   7. no referrer             → `(direct)` / `(none)`
 *
 * Our own domain, the current host (staging) and payment or login domains are
 * ignored as referrers, so they fall through to rule 7. That is also what keeps
 * internal navigation from ever overwriting last touch: a direct touch never
 * does (see `touches.ts`).
 *
 * Host lists are matched on the hostname, never on a substring of the URL, so
 * `gemini.google.com` is an assistant rather than Google Search, and a referrer
 * such as `https://evil.example/?google.com` is just a referral.
 */

import { MAX_TEXT_FIELD_CHARS } from "../../worker/src/limits";
import { channelFor, DIRECT_MEDIUM, DIRECT_SOURCE, type Channel } from "./channel";

export type Touch = {
  channel: Channel;
  source: string;
  medium: string;
  campaign: string;
  term: string;
  content: string;
  /** Value of the ad click ID (gclid, msclkid, fbclid…), whenever one was present. */
  clickId: string;
  /** Full landing URL. */
  landingPage: string;
  /** The classified referrer URL; empty for direct and ignored referrers. */
  referrer: string;
  /** ISO-8601 landing time. */
  date: string;
};

export type Landing = {
  url: string;
  referrer: string;
  now: Date;
};

/** Domains that are ours, on every subdomain. */
export const OWN_DOMAINS = ["alphaapexgroup.com"] as const;

/** Payment and login hosts: a return from checkout or sign-in is not a source. */
const IGNORED_REFERRER_DOMAINS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "paypal.com",
  "stripe.com",
] as const;

const UTM_PARAMS = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  term: "utm_term",
  content: "utm_content",
} as const;

/** Ad click IDs in lookup order, with the source each one implies. */
const CLICK_ID_SOURCES = [
  ["gclid", "google"],
  ["gbraid", "google"],
  ["wbraid", "google"],
  ["msclkid", "bing"],
  ["fbclid", "facebook"],
  ["li_fat_id", "linkedin"],
  ["ttclid", "tiktok"],
] as const;

/** Exact registrable domains, matched on the host or any of its subdomains. */
const SEARCH_ENGINE_DOMAINS = [
  ["bing.com", "bing"],
  ["yahoo.com", "yahoo"],
  ["duckduckgo.com", "duckduckgo"],
  ["baidu.com", "baidu"],
  ["ecosia.org", "ecosia"],
  ["search.brave.com", "brave"],
] as const;

/**
 * Google and Yandex search live on many country TLDs (`google.co.uk`,
 * `yandex.ru`). Only the bare or `www.` host counts: Google's other products
 * (`gemini.google.com`, `accounts.google.com`) are classified elsewhere.
 */
const COUNTRY_TLD_SEARCH_ENGINES = [
  [/^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, "google"],
  [/^(www\.)?yandex\.[a-z]{2,3}(\.[a-z]{2})?$/, "yandex"],
] as const;

const SOCIAL_DOMAINS = [
  ["facebook.com", "facebook"],
  ["instagram.com", "instagram"],
  ["linkedin.com", "linkedin"],
  ["lnkd.in", "linkedin"],
  ["t.co", "x"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["reddit.com", "reddit"],
  ["tiktok.com", "tiktok"],
] as const;

const AI_ASSISTANT_DOMAINS = [
  ["chatgpt.com", "chatgpt"],
  ["chat.openai.com", "chatgpt"],
  ["perplexity.ai", "perplexity"],
  ["gemini.google.com", "gemini"],
  ["copilot.microsoft.com", "copilot"],
  ["claude.ai", "claude"],
] as const;

/**
 * Every stored value is kept as received and cut only at the Worker's per-field
 * limit: past it the Worker refuses the whole lead, so a cut value is the
 * lesser loss.
 */
export function capAttributionValue(value: string) {
  return value.slice(0, MAX_TEXT_FIELD_CHARS);
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isOnDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function lookupDomain(host: string, table: ReadonlyArray<readonly [string, string]>) {
  return table.find(([domain]) => isOnDomain(host, domain))?.[1];
}

function lookupSearchEngine(host: string) {
  const byPattern = COUNTRY_TLD_SEARCH_ENGINES.find(([pattern]) => pattern.test(host));
  return byPattern?.[1] ?? lookupDomain(host, SEARCH_ENGINE_DOMAINS);
}

function isIgnoredReferrer(host: string, currentHost: string) {
  return (
    host === currentHost ||
    OWN_DOMAINS.some((domain) => isOnDomain(host, domain)) ||
    IGNORED_REFERRER_DOMAINS.some((domain) => isOnDomain(host, domain))
  );
}

/** The parameter exactly as received, capped only at the Worker's field limit. */
function readParam(params: URLSearchParams, key: string) {
  return capAttributionValue(params.get(key) ?? "");
}

/** Whitespace-only values are kept, but never decide which rule applies. */
function isPresent(value: string) {
  return value.trim() !== "";
}

type SourceFields = Pick<Touch, "source" | "medium" | "campaign" | "term" | "content" | "referrer">;

function fromReferrer(referrer: URL | null): SourceFields {
  const empty = { campaign: "", term: "", content: "" };
  if (!referrer) {
    return { ...empty, source: DIRECT_SOURCE, medium: DIRECT_MEDIUM, referrer: "" };
  }

  const host = referrer.hostname.toLowerCase();
  const href = capAttributionValue(referrer.href);
  const ruleMatches = [
    [lookupSearchEngine(host), "organic"],
    [lookupDomain(host, SOCIAL_DOMAINS), "social"],
    [lookupDomain(host, AI_ASSISTANT_DOMAINS), "ai"],
  ] as const;
  for (const [source, medium] of ruleMatches) {
    if (source) return { ...empty, source, medium, referrer: href };
  }

  const domain = capAttributionValue(host.replace(/^www\./, ""));
  return { ...empty, source: domain, medium: "referral", referrer: href };
}

export function resolveTouch({ url, referrer, now }: Landing): Touch {
  const landing = parseUrl(url);
  const params = landing?.searchParams ?? new URLSearchParams();
  const currentHost = landing?.hostname.toLowerCase() ?? "";

  const utm = {
    source: readParam(params, UTM_PARAMS.source),
    medium: readParam(params, UTM_PARAMS.medium),
    campaign: readParam(params, UTM_PARAMS.campaign),
    term: readParam(params, UTM_PARAMS.term),
    content: readParam(params, UTM_PARAMS.content),
  };
  const hasUtm = Object.values(utm).some(isPresent);

  const clickMatch = CLICK_ID_SOURCES.map(
    ([param, source]) => [readParam(params, param), source] as const,
  ).find(([value]) => isPresent(value));
  const clickId = clickMatch?.[0] ?? "";

  const referrerUrl = parseUrl(referrer);
  const externalReferrer =
    referrerUrl && !isIgnoredReferrer(referrerUrl.hostname.toLowerCase(), currentHost)
      ? referrerUrl
      : null;
  const referrerHref = externalReferrer ? capAttributionValue(externalReferrer.href) : "";

  const fields: SourceFields = hasUtm
    ? { ...utm, referrer: referrerHref }
    : clickMatch
      ? {
          source: clickMatch[1],
          medium: "cpc",
          campaign: "",
          term: "",
          content: "",
          referrer: referrerHref,
        }
      : fromReferrer(externalReferrer);

  return {
    channel: channelFor(fields.source, fields.medium),
    ...fields,
    clickId,
    landingPage: capAttributionValue(url),
    date: now.toISOString(),
  };
}
