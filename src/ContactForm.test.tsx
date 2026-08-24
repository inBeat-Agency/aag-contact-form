import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactForm } from "./ContactForm";

// The component talks to the network only through the global `fetch`. We stub it
// so no real request leaves the test and we can assert whether it was called.
const fetchMock = vi.fn();

/**
 * A Worker-shaped success. A bare 200 is deliberately NOT used as the default:
 * the widget treats a 2xx with no `ok: true` as an error, so a bare 200 here
 * would silently exercise the failure path in every test that submits.
 */
function workerSuccess(resumeUrl = ""): Response {
  return new Response(JSON.stringify({ ok: true, resumeUrl }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(workerSuccess());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderForm() {
  return render(
    <ContactForm endpoint="https://example.test/submit" source="unit-test" />,
  );
}

async function selectInquiry(label: string) {
  const user = userEvent.setup();
  await user.selectOptions(
    screen.getByLabelText("Inquiry type"),
    label,
  );
  return user;
}

/** Fill a General Question to the point where submitting fires a real fetch. */
async function fillMinimalInquiry() {
  renderForm();
  const user = await selectInquiry("General Question");
  await user.type(screen.getByLabelText("First Name"), "Jane");
  await user.type(screen.getByLabelText("Last Name"), "Smith");
  await user.type(screen.getByLabelText("Work Email"), "jane@company.com");
  await user.type(
    screen.getByLabelText("How can we help you?"),
    "Please reach out.",
  );
  return user;
}

describe("ContactForm — initial render (placeholder preview)", () => {
  it("shows the inquiry select without a widget-owned header", () => {
    renderForm();

    expect(screen.getByLabelText("Inquiry type")).toBeInTheDocument();
    // The heading/subtitle copy intentionally lives in Webflow, not the widget.
    expect(screen.queryByText("Contact Us")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select the nature of your inquiry to get started."),
    ).not.toBeInTheDocument();

    // The placeholder previews the General Question field set on first load.
    expect(screen.getByLabelText("First Name")).toBeInTheDocument();
    expect(screen.getByLabelText("How can we help you?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit/i }),
    ).toBeInTheDocument();
  });

  it("previews exactly the General Question field set while on the placeholder", () => {
    renderForm();

    expect(screen.getByLabelText("Inquiry type")).toHaveValue("");

    // Common fields (the General Question set) are previewed.
    expect(screen.getByLabelText("First Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Last Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Work Email")).toBeInTheDocument();
    expect(screen.getByLabelText("How can we help you?")).toBeInTheDocument();

    // Nothing type-specific leaks into the preview.
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Company Size/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Estimated Budget/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Expected Timeline/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Resume")).not.toBeInTheDocument();
  });

  it("fails validation with a human-readable inquiry error when submitted on the placeholder", async () => {
    renderForm();
    const user = userEvent.setup();

    // Fill every previewed field so the ONLY thing missing is the inquiry type.
    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(screen.getByLabelText("Last Name"), "Smith");
    await user.type(screen.getByLabelText("Work Email"), "jane@company.com");
    await user.type(
      screen.getByLabelText("How can we help you?"),
      "Just a question.",
    );

    await user.click(screen.getByRole("button", { name: /submit/i }));

    // The error must land on the inquiry select itself, not float loose.
    const inquirySelect = screen.getByLabelText("Inquiry type");
    await waitFor(() =>
      expect(inquirySelect).toHaveAttribute("aria-invalid", "true"),
    );
    const describedBy = inquirySelect.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      "Please select an inquiry type",
    );

    // Zod's raw discriminator message must never reach the user.
    expect(
      screen.queryByText(/Invalid discriminator value/i),
    ).not.toBeInTheDocument();

    // A placeholder submission must never be filed as a lead.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps values typed in the preview when a real inquiry type is chosen", async () => {
    renderForm();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(screen.getByLabelText("Last Name"), "Smith");
    await user.type(screen.getByLabelText("Work Email"), "jane@company.com");
    await user.type(
      screen.getByLabelText("How can we help you?"),
      "We need help with hiring.",
    );

    await user.selectOptions(
      screen.getByLabelText("Inquiry type"),
      "Consulting",
    );

    expect(screen.getByLabelText("First Name")).toHaveValue("Jane");
    expect(screen.getByLabelText("Last Name")).toHaveValue("Smith");
    expect(screen.getByLabelText("Work Email")).toHaveValue(
      "jane@company.com",
    );
    expect(screen.getByLabelText("How can we help you?")).toHaveValue(
      "We need help with hiring.",
    );
  });
});

describe("ContactForm — conditional field disclosure", () => {
  it("General Question reveals only the common fields", async () => {
    renderForm();
    await selectInquiry("General Question");

    // Common fields appear.
    expect(screen.getByLabelText("First Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Last Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Work Email")).toBeInTheDocument();
    expect(screen.getByLabelText("How can we help you?")).toBeInTheDocument();

    // Business / engagement / resume fields must stay hidden.
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Phone")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Company Size/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Estimated Budget/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Expected Timeline/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Resume")).not.toBeInTheDocument();
  });

  it("Consulting reveals business + engagement fields alongside common ones", async () => {
    renderForm();
    await selectInquiry("Consulting");

    expect(screen.getByLabelText("First Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Work Email")).toBeInTheDocument();

    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Company")).toBeInTheDocument();
    expect(screen.getByLabelText(/Phone/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Estimated Budget/)).toBeInTheDocument();

    // No resume field for Consulting.
    expect(screen.queryByLabelText("Upload Resume")).not.toBeInTheDocument();
  });

  /**
   * Company Size and Expected Timeline were removed from the engagement flows:
   * users left them blank and the longer form hurt conversion. The shorter
   * candidate form converts measurably better, so the engagement flows now stop
   * at Estimated Budget.
   */
  it.each(["Consulting", "Recruitment / Hiring"])(
    "%s no longer renders Company Size or Expected Timeline",
    async (inquiryType) => {
      renderForm();
      await selectInquiry(inquiryType);

      expect(screen.queryByLabelText(/Company Size/)).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText(/Expected Timeline/),
      ).not.toBeInTheDocument();

      // Guard the guard: this is the flow that USED to render them, so the
      // fields that survived must still be here.
      expect(screen.getByLabelText(/^Phone/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Estimated Budget/)).toBeInTheDocument();
    },
  );

  it.each(["Consulting", "Recruitment / Hiring"])(
    "groups every %s field pair in a two-column row contract",
    async (inquiryType) => {
      renderForm();
      await selectInquiry(inquiryType);

      // Phone pairs with Estimated Budget now that Company Size and Expected
      // Timeline are gone. `.aag-form-row` is a hard 1fr 1fr grid, so leaving
      // either of these alone in a row would render it at half width with a
      // dead gap beside it.
      const pairs = [
        ["First Name", "Last Name"],
        ["Title", "Company"],
        [/^Phone/, /Estimated Budget/],
      ] as const;

      for (const [firstLabel, secondLabel] of pairs) {
        const first = screen.getByLabelText(firstLabel);
        const second = screen.getByLabelText(secondLabel);
        const row = first.closest(".aag-form-row");

        expect(row).not.toBeNull();
        expect(second.closest(".aag-form-row")).toBe(row);
      }
    },
  );

  /**
   * The pairing test above proves the fields we EXPECT together are together.
   * This proves the other half: no row was left holding a single field.
   *
   * Removing a paired select is exactly how `.aag-form-row` — a hard 1fr 1fr
   * grid — ends up rendering its lone survivor at half width with a dead gap
   * beside it on desktop and in the half-page embed. Enumerating expected pairs
   * cannot catch that, because an orphaned row simply is not in the list.
   */
  it.each([
    "General Question",
    "Consulting",
    "Recruitment / Hiring",
    "Submit Resume",
  ])("leaves no half-width orphan in a %s two-column row", async (inquiryType) => {
    const { container } = renderForm();
    await selectInquiry(inquiryType);

    const rows = [...container.querySelectorAll(".aag-form-row")];

    // Guard the guard: a flow that rendered no rows at all would pass vacuously.
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.children.length, `"${row.className}" is not a full pair`).toBe(2);
    }
  });

  it("Submit Resume reveals the file input but no company details", async () => {
    renderForm();
    await selectInquiry("Submit Resume");

    expect(screen.getByLabelText("Upload Resume")).toBeInTheDocument();
    // A candidate applies as an individual: contact details + phone, no company.
    expect(screen.getByLabelText(/^Phone/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Company Size/)).not.toBeInTheDocument();

    expect(screen.queryByLabelText(/Estimated Budget/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Expected Timeline/),
    ).not.toBeInTheDocument();
  });

  it.each(["Consulting", "Recruitment / Hiring"])(
    "%s still collects Title, Company and Estimated Budget",
    async (inquiryType) => {
      renderForm();
      await selectInquiry(inquiryType);

      expect(screen.getByLabelText("Title")).toBeInTheDocument();
      expect(screen.getByLabelText("Company")).toBeInTheDocument();
      expect(screen.getByLabelText(/Estimated Budget/)).toBeInTheDocument();
    },
  );

  it("renders the lone Submit Resume phone full-width, outside the two-column row", async () => {
    renderForm();
    await selectInquiry("Submit Resume");

    // `.aag-form-row` is a hard 1fr 1fr grid; a solo child would render at half
    // width with a dead gap beside it.
    expect(
      screen.getByLabelText(/^Phone/).closest(".aag-form-row"),
    ).toBeNull();
  });
});

describe("ContactForm — field persistence on inquiry change", () => {
  it("keeps common field values but drops type-specific fields when inquiry changes", async () => {
    renderForm();
    const user = await selectInquiry("Consulting");

    // Fill a common field and a type-specific field.
    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(
      screen.getByLabelText("Work Email"),
      "jane@company.com",
    );
    await user.type(screen.getByLabelText("Title"), "Head of Talent");

    expect(screen.getByLabelText("Title")).toHaveValue("Head of Talent");

    // Switch to a type that does not show Title.
    await user.selectOptions(
      screen.getByLabelText("Inquiry type"),
      "General Question",
    );

    // Common fields keep their values...
    expect(screen.getByLabelText("First Name")).toHaveValue("Jane");
    expect(screen.getByLabelText("Work Email")).toHaveValue(
      "jane@company.com",
    );

    // ...the type-specific field is gone (unmounted for General Question).
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();

    // Reselecting Consulting shows Title cleared (reset, not preserved).
    await user.selectOptions(
      screen.getByLabelText("Inquiry type"),
      "Consulting",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });
});

describe("ContactForm — validation", () => {
  it("marks visible required controls with native required semantics", async () => {
    renderForm();
    await selectInquiry("Submit Resume");

    for (const label of [
      "Inquiry type",
      "First Name",
      "Last Name",
      "Work Email",
      "Upload Resume",
      "How can we help you?",
    ]) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }

    expect(screen.getByLabelText(/^Phone/)).not.toBeRequired();
  });

  it("shows inline errors and does not hit the network when required fields are empty", async () => {
    renderForm();
    const user = await selectInquiry("General Question");

    await user.click(screen.getByRole("button", { name: /submit/i }));

    // At least one inline validation error surfaces via role="alert".
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(
      screen.getByText("First name is required"),
    ).toBeInTheDocument();

    // No submission attempt reached the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wires aria-invalid and aria-describedby to the error node on an errored field", async () => {
    renderForm();
    const user = await selectInquiry("General Question");

    await user.click(screen.getByRole("button", { name: /submit/i }));

    const firstName = await screen.findByLabelText("First Name");
    await waitFor(() =>
      expect(firstName).toHaveAttribute("aria-invalid", "true"),
    );

    // aria-describedby must resolve to the node holding the error message.
    const describedBy = firstName.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorNode = document.getElementById(describedBy as string);
    expect(errorNode).not.toBeNull();
    expect(errorNode).toHaveTextContent("First name is required");
  });
});

describe("ContactForm — Submit Resume submission", () => {
  it("uploads a valid file through the real input and sends it in FormData", async () => {
    renderForm();
    const user = await selectInquiry("Submit Resume");
    const resume = new File(["resume contents"], "jane-smith.pdf", {
      type: "application/pdf",
    });

    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(screen.getByLabelText("Last Name"), "Smith");
    await user.type(
      screen.getByLabelText("Work Email"),
      "jane@company.com",
    );
    await user.upload(screen.getByLabelText("Upload Resume"), resume);
    await user.type(
      screen.getByLabelText("How can we help you?"),
      "Please consider my application.",
    );

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toBeUndefined();

    const body = init.body as FormData;
    expect(body.get("inquiryType")).toBe("Submit Resume");
    expect(body.get("firstName")).toBe("Jane");
    expect(body.get("resume")).toBeInstanceOf(File);
    expect((body.get("resume") as File).name).toBe("jane-smith.pdf");
  });

  it("never sends company details, even when they were typed under a previous inquiry type", async () => {
    renderForm();
    const user = await selectInquiry("Consulting");
    const resume = new File(["resume contents"], "jane-smith.pdf", {
      type: "application/pdf",
    });

    // Fill the engagement-only fields, then switch away from that flow.
    await user.type(screen.getByLabelText("Title"), "Head of Talent");
    await user.type(screen.getByLabelText("Company"), "Acme Inc.");
    await user.selectOptions(
      screen.getByLabelText(/Estimated Budget/),
      "$50K – $150K",
    );

    await user.selectOptions(
      screen.getByLabelText("Inquiry type"),
      "Submit Resume",
    );

    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(screen.getByLabelText("Last Name"), "Smith");
    await user.type(screen.getByLabelText("Work Email"), "jane@company.com");
    await user.upload(screen.getByLabelText("Upload Resume"), resume);
    await user.type(
      screen.getByLabelText("How can we help you?"),
      "Please consider my application.",
    );

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as FormData;

    expect(body.get("inquiryType")).toBe("Submit Resume");
    // Multipart omits empty optionals outright. The Worker fills the missing
    // contract keys in when it builds the flat Zapier payload.
    expect(body.has("title")).toBe(false);
    expect(body.has("company")).toBe(false);
    expect(body.has("estimatedBudget")).toBe(false);
    // Removed from the form entirely, so no flow can ever send them.
    expect(body.has("companySize")).toBe(false);
    expect(body.has("expectedTimeline")).toBe(false);
  });
});

describe("ContactForm — which response renders the success panel", () => {
  it("renders the success panel when the Worker answers ok:true", async () => {
    fetchMock.mockResolvedValue(workerSuccess());
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("Thanks!");
  });

  it("renders the error panel when a 2xx carries an HTML body", async () => {
    // The exact shape an intercepting proxy, a parked domain or a captive
    // portal returns. The old `response.ok` contract called this a success.
    fetchMock.mockResolvedValue(
      new Response("<!doctype html><h1>Success</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Something went wrong/i,
    );
  });
});

describe("ContactForm — success panel scroll", () => {
  /**
   * jsdom implements neither `Element.prototype.scrollIntoView` nor
   * `window.matchMedia`. `scrollIntoView` is a prototype method rather than a
   * global, so `vi.stubGlobal` cannot reach it — it is assigned outright here
   * and deleted again after every test in this block.
   */
  function stubScrollIntoView() {
    const scrollIntoView = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView =
      scrollIntoView;
    return scrollIntoView;
  }

  /**
   * The component reads only `matches` off the query list, so a minimal shape
   * is enough. `vi.unstubAllGlobals` in the file-level teardown removes it.
   */
  function stubReducedMotion(matches: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches, media: query })),
    );
  }

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("scrolls the success panel into view on a successful submission", async () => {
    const scrollIntoView = stubScrollIntoView();
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    const status = await screen.findByRole("status");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    // Centring is what rescues the panel. Success replaces the whole form, so
    // the page collapses and aligning to the top can still leave the message
    // above the viewport. No `matchMedia` is stubbed here, matching a host
    // page that does not implement it: the animated default still applies.
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });

    // It must be the success panel that moves, not some other node.
    expect(scrollIntoView.mock.contexts[0]).toBe(status);
  });

  it("scrolls without animation when the visitor prefers reduced motion", async () => {
    stubReducedMotion(true);
    const scrollIntoView = stubScrollIntoView();
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
  });

  it("animates the scroll when motion is not reduced", async () => {
    stubReducedMotion(false);
    const scrollIntoView = stubScrollIntoView();
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("does not scroll while the form is idle", async () => {
    const scrollIntoView = stubScrollIntoView();
    renderForm();
    await selectInquiry("General Question");

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll while the submission is still in flight", async () => {
    const scrollIntoView = stubScrollIntoView();
    // Never settles, so the component stays in `submitting`.
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /submitting/i }),
      ).toBeDisabled(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll when the submission fails", async () => {
    const scrollIntoView = stubScrollIntoView();
    fetchMock.mockResolvedValue(
      new Response("<!doctype html><h1>Success</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Something went wrong/i,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("still renders the success panel when the host page has no scrollIntoView", async () => {
    // No stub installed on purpose: jsdom leaves `scrollIntoView` undefined,
    // which mirrors an embedding page that does not implement it. A failed
    // scroll must never take the submission down with it.
    const user = await fillMinimalInquiry();

    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("Thanks!");
  });
});

describe("ContactForm — honeypot", () => {
  it("fakes success before validation when the honeypot is filled", async () => {
    const { container } = renderForm();
    const user = await selectInquiry("General Question");

    const honeypot = container.querySelector<HTMLInputElement>(
      'input[name="website"]',
    );
    expect(honeypot).not.toBeNull();
    await user.type(honeypot as HTMLInputElement, "spam-bot-value");

    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("Thanks!");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fakes success without calling fetch when the honeypot is filled", async () => {
    const { container } = renderForm();
    const user = await selectInquiry("General Question");

    // Fill the real required fields so validation would otherwise pass and a
    // real submission would fire — proving the honeypot is what short-circuits.
    await user.type(screen.getByLabelText("First Name"), "Jane");
    await user.type(screen.getByLabelText("Last Name"), "Smith");
    await user.type(
      screen.getByLabelText("Work Email"),
      "jane@company.com",
    );
    await user.type(
      screen.getByLabelText("How can we help you?"),
      "Please reach out.",
    );

    // The honeypot is aria-hidden and has no accessible label, so query it
    // directly by name — a bot would fill it, a human never sees it.
    const honeypot = container.querySelector<HTMLInputElement>(
      'input[name="website"]',
    );
    expect(honeypot).not.toBeNull();
    await user.type(honeypot as HTMLInputElement, "spam-bot-value");

    await user.click(screen.getByRole("button", { name: /submit/i }));

    // Success screen renders and the network was never touched.
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Thanks!");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      within(status).getByText(/within one business day/i),
    ).toBeInTheDocument();
  });
});
