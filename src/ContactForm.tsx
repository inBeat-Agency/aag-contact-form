import { useEffect, useRef, useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BUDGETS,
  COMPANY_SIZES,
  contactFormSchema,
  INQUIRY_TYPES,
  TIMELINES,
  type ContactFormFields,
} from "./schema";
import {
  FileField,
  SelectField,
  TextareaField,
  TextField,
} from "./fields";
import { buildFormData, submitContactForm } from "./submit";
import { ALLOWED_RESUME_EXTENSIONS } from "./schema";

export interface ContactFormProps {
  /** Endpoint the multipart payload is POSTed to (from `data-endpoint`). */
  endpoint: string;
  /** Free-form origin identifier forwarded in the payload (from `data-source`). */
  source: string | null;
}

type Status = "idle" | "submitting" | "success" | "error";

const DEFAULT_VALUES: ContactFormFields = {
  inquiryType: "",
  firstName: "",
  lastName: "",
  workEmail: "",
  title: "",
  company: "",
  phone: "",
  companySize: "",
  estimatedBudget: "",
  expectedTimeline: "",
  message: "",
  resume: null,
  website: "",
};

// Which extra field groups each inquiry type reveals. Title, Company, Company
// Size, Budget and Timeline are engagement-only; Submit Resume collects a phone
// number but no company details.
const SHOWS_ENGAGEMENT_FIELDS = new Set(["Consulting", "Recruitment / Hiring"]);
const SHOWS_PHONE_FIELD = new Set([
  "Consulting",
  "Recruitment / Hiring",
  "Submit Resume",
]);

const RESUME_ACCEPT = ALLOWED_RESUME_EXTENSIONS.join(",");

export function ContactForm({ endpoint, source }: ContactFormProps) {
  const [status, setStatus] = useState<Status>("idle");
  const successRef = useRef<HTMLDivElement>(null);

  const {
    register,
    handleSubmit,
    watch,
    resetField,
    formState: { errors },
  } = useForm<ContactFormFields>({
    defaultValues: DEFAULT_VALUES,
    mode: "onSubmit",
    reValidateMode: "onChange",
    // The resolver validates against the discriminated union, narrowing on the
    // currently selected inquiry type.
    resolver: zodResolver(contactFormSchema),
  });

  const inquiryType = watch("inquiryType");
  const showEngagement = SHOWS_ENGAGEMENT_FIELDS.has(inquiryType);
  const showPhone = SHOWS_PHONE_FIELD.has(inquiryType);
  const showResume = inquiryType === "Submit Resume";

  // When the inquiry type changes, common fields persist but the type-specific
  // fields are cleared so a hidden value from a previous type can't leak into
  // the payload.
  function handleInquiryChange() {
    resetField("title");
    resetField("company");
    resetField("phone");
    resetField("companySize");
    resetField("estimatedBudget");
    resetField("expectedTimeline");
    resetField("resume");
  }

  async function onSubmit(values: ContactFormFields) {
    setStatus("submitting");
    const result = await submitContactForm(
      endpoint,
      buildFormData(values, source),
    );
    setStatus(result.outcome);
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    // Check the raw field before RHF invokes the Zod resolver. Bots that fill
    // the honeypot should receive fake success even when visible fields fail
    // validation.
    const honeypot = new FormData(event.currentTarget).get("website");
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      event.preventDefault();
      setStatus("success");
      return;
    }

    void handleSubmit(onSubmit)(event);
  }

  // Success replaces the entire form, collapsing the page by hundreds of
  // pixels, so the short success panel can end up above the viewport: the
  // visitor sees nothing and re-submits. Pull the panel into view as soon as it
  // mounts. Declared before the early return below so the hook order stays
  // stable across renders.
  useEffect(() => {
    if (status !== "success") return;

    const node = successRef.current;
    // The widget runs embedded in a third-party page, so neither API is
    // guaranteed. Scrolling is a courtesy: a submission that already succeeded
    // must never fail because the host environment lacks `scrollIntoView` or
    // `matchMedia`.
    if (!node || typeof node.scrollIntoView !== "function") return;

    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    node.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }, [status]);

  if (status === "success") {
    return (
      <div className="aag-form-root form_component w-form">
        {/*
          `form_message-success` carries the Webflow styling, but the Webflow
          base classes `w-form-done` / `w-form-fail` are deliberately NOT used:
          they ship `display: none` and are toggled by Webflow's own form JS,
          which this widget does not load. React controls visibility here.
        */}
        <div
          ref={successRef}
          className="aag-form-success form_message-success"
          role="status"
        >
          <p className="aag-form-success-title">Thanks!</p>
          <p className="aag-form-success-text">
            We&rsquo;ll get back to you within one business day.
          </p>
        </div>
      </div>
    );
  }

  const inquiryReg = register("inquiryType");

  // `.aag-form-row` is a hard two-column grid, so a lone Phone inside one would
  // render at half width with a dead gap beside it on desktop and in the
  // half-page embed. Phone keeps its Company Size partner in the engagement
  // rows; in the Submit Resume flow the same element is rendered outside the
  // row so it spans full width, like Work Email and the message textarea.
  const phoneField = showPhone ? (
    <TextField
      id="aag-form-phone"
      label="Phone"
      type="tel"
      optional
      placeholder="+1 555 000 0000"
      autoComplete="tel"
      error={errors.phone?.message}
      {...register("phone")}
    />
  ) : null;

  return (
    <div className="aag-form-root form_component w-form">
      <form
        className="aag-form-form form_form"
        onSubmit={handleFormSubmit}
        noValidate
      >
        {/* Honeypot field: visually hidden, ignored by assistive tech. */}
        <div className="aag-form-hp" aria-hidden="true">
          <label htmlFor="aag-form-website">Leave this field empty</label>
          <input
            id="aag-form-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            {...register("website")}
          />
        </div>

        <SelectField
          id="aag-form-inquiryType"
          label="Inquiry type"
          placeholder="Select an option"
          options={INQUIRY_TYPES}
          error={errors.inquiryType?.message}
          name={inquiryReg.name}
          ref={inquiryReg.ref}
          onBlur={inquiryReg.onBlur}
          onChange={(event) => {
            inquiryReg.onChange(event);
            handleInquiryChange();
          }}
        />

        {/*
          The body renders unconditionally. On the placeholder (`inquiryType`
          is "") every `show*` gate below is false, so the form previews the
          General Question field set — common fields only. This is a
          PRESENTATION default: `inquiryType` stays "" in form state, so
          submitting from here fails validation instead of silently filing the
          lead as a General Question.
        */}
        <div className="aag-form-row">
          <TextField
            id="aag-form-firstName"
            label="First Name"
            placeholder="Jane"
            autoComplete="given-name"
            error={errors.firstName?.message}
            {...register("firstName")}
          />
          <TextField
            id="aag-form-lastName"
            label="Last Name"
            placeholder="Smith"
            autoComplete="family-name"
            error={errors.lastName?.message}
            {...register("lastName")}
          />
        </div>

        <TextField
          id="aag-form-workEmail"
          label="Work Email"
          type="email"
          placeholder="jane@company.com"
          autoComplete="email"
          error={errors.workEmail?.message}
          {...register("workEmail")}
        />

        {showEngagement ? (
          <div className="aag-form-row">
            <TextField
              id="aag-form-title"
              label="Title"
              placeholder="Head of Talent"
              autoComplete="organization-title"
              error={errors.title?.message}
              {...register("title")}
            />
            <TextField
              id="aag-form-company"
              label="Company"
              placeholder="Acme Inc."
              autoComplete="organization"
              error={errors.company?.message}
              {...register("company")}
            />
          </div>
        ) : null}

        {showEngagement ? (
          <div className="aag-form-row">
            {phoneField}
            <SelectField
              id="aag-form-companySize"
              label="Company Size"
              optional
              placeholder="Select an option"
              options={COMPANY_SIZES}
              error={errors.companySize?.message}
              {...register("companySize")}
            />
          </div>
        ) : (
          phoneField
        )}

        {showEngagement ? (
          <div className="aag-form-row">
            <SelectField
              id="aag-form-estimatedBudget"
              label="Estimated Budget"
              optional
              placeholder="Select an option"
              options={BUDGETS}
              error={errors.estimatedBudget?.message}
              {...register("estimatedBudget")}
            />
            <SelectField
              id="aag-form-expectedTimeline"
              label="Expected Timeline"
              optional
              placeholder="Select an option"
              options={TIMELINES}
              error={errors.expectedTimeline?.message}
              {...register("expectedTimeline")}
            />
          </div>
        ) : null}

        {showResume ? (
          <FileField
            id="aag-form-resume"
            label="Upload Resume"
            accept={RESUME_ACCEPT}
            error={errors.resume?.message as string | undefined}
            {...register("resume")}
          />
        ) : null}

        <TextareaField
          id="aag-form-message"
          label="How can we help you?"
          placeholder="Tell us about your needs..."
          error={errors.message?.message}
          {...register("message")}
        />

        {status === "error" ? (
          <div className="aag-form-banner form_message-error" role="alert">
            Something went wrong. Please try again or email{" "}
            hello@alphaapexgroup.com.
          </div>
        ) : null}

        <button
          type="submit"
          className="button is-form-submit w-button"
          disabled={status === "submitting"}
        >
          {status === "submitting" ? "Submitting\u2026" : "Submit"}
        </button>
      </form>
    </div>
  );
}
