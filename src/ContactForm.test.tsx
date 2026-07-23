import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactForm } from "./ContactForm";

// The component talks to the network only through the global `fetch`. We stub it
// so no real request leaves the test and we can assert whether it was called.
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
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

describe("ContactForm — initial render (progressive disclosure)", () => {
  it("shows the header and inquiry select, but no personal fields yet", () => {
    renderForm();

    expect(
      screen.getByRole("heading", { name: "Contact Us" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Inquiry type")).toBeInTheDocument();

    // Nothing past the inquiry select is disclosed until a type is chosen.
    expect(screen.queryByLabelText("First Name")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("How can we help you?"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit/i }),
    ).not.toBeInTheDocument();
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
    expect(screen.getByLabelText(/Company Size/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Estimated Budget/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Expected Timeline/)).toBeInTheDocument();

    // No resume field for Consulting.
    expect(screen.queryByLabelText("Upload Resume")).not.toBeInTheDocument();
  });

  it("Submit Resume reveals the file input but not budget/timeline", async () => {
    renderForm();
    await selectInquiry("Submit Resume");

    expect(screen.getByLabelText("Upload Resume")).toBeInTheDocument();
    // Submit Resume shows business fields (Title/Company) but not engagement.
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Company")).toBeInTheDocument();

    expect(screen.queryByLabelText(/Estimated Budget/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Expected Timeline/),
    ).not.toBeInTheDocument();
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

describe("ContactForm — honeypot", () => {
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
