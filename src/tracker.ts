import { captureFromBrowser } from "./attribution/browser";

/**
 * Site-wide attribution tracker, loaded in the `<head>` of every page through
 * Webflow's site custom code. It records the landing's traffic source so the
 * contact form can submit first and last touch, whichever page the visitor
 * landed on.
 *
 * Never throws: it runs before the page renders, on every page, and tracking is
 * best-effort.
 */
try {
  captureFromBrowser(window);
} catch {
  // Attribution must never break the page.
}
