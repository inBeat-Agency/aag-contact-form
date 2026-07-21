import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContactForm } from "./ContactForm";
import "./styles.css";

const MOUNT_ID = "aag-contact-form";

/**
 * Self-mounting entry point. Finds the host div, reads its configuration from
 * data attributes, and renders the widget. If the div is absent, it does
 * nothing (no crash) — this lets the script live safely in <head> across pages.
 */
function mount() {
  const el = document.getElementById(MOUNT_ID);
  if (!el) return;

  // Guard against double-mounting if the script is included more than once.
  if (el.getAttribute("data-aag-mounted") === "true") return;

  const endpoint = el.getAttribute("data-endpoint");
  if (!endpoint) {
    // Misconfiguration: without an endpoint the form can't submit anywhere.
    console.warn(
      "[aag-contact-form] Missing required data-endpoint attribute; widget not mounted.",
    );
    return;
  }

  const source = el.getAttribute("data-source");
  el.setAttribute("data-aag-mounted", "true");

  createRoot(el).render(
    <StrictMode>
      <ContactForm endpoint={endpoint} source={source} />
    </StrictMode>,
  );
}

// The script may load before or after the mount div is parsed. Handle both.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
