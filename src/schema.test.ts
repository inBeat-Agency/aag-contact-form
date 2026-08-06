import { describe, expect, it } from "vitest";
import {
  contactFormSchema,
  INQUIRY_TYPES,
  MAX_RESUME_BYTES,
  resumeFileSchema,
} from "./schema";
// Imported from the Worker's module on purpose: that copy is the authoritative
// one, and reading it here is what makes drift between the two sides fail.
import {
  ALLOWED_RESUME_EXTENSIONS as SHARED_ALLOWED_RESUME_EXTENSIONS,
  hasEmailShape,
  INQUIRY_TYPES as SHARED_INQUIRY_TYPES,
  MAX_FILE_NAME_BYTES,
  MAX_RESUME_BYTES as SHARED_MAX_RESUME_BYTES,
  MAX_TEXT_FIELD_BYTES,
  MAX_TEXT_FIELD_CHARS,
  requiredTextFieldsFor,
  utf8ByteLength,
} from "../worker/src/limits";

// Helper to fabricate a File of a given size/type without allocating real bytes.
function makeFile(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const baseContact = {
  firstName: "Jane",
  lastName: "Smith",
  workEmail: "jane@company.com",
  message: "We need help with hiring.",
};

describe("General Question", () => {
  it("accepts the common fields only", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing first name", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
      firstName: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bad email", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
      workEmail: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("Consulting / Recruitment (engagement)", () => {
  const engagement = {
    ...baseContact,
    title: "Head of Talent",
    company: "Acme Inc.",
  };

  it("accepts a valid consulting submission with only required fields", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Consulting",
      ...engagement,
    });
    expect(result.success).toBe(true);
  });

  it("accepts recruitment with optional selects filled", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Recruitment / Hiring",
      ...engagement,
      phone: "+1 555 000 0000",
      companySize: "51-200",
      estimatedBudget: "$50K – $150K",
      expectedTimeline: "1-3 months",
    });
    expect(result.success).toBe(true);
  });

  it("normalizes empty optional selects to undefined", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Consulting",
      ...engagement,
      phone: "",
      companySize: "",
      estimatedBudget: "",
      expectedTimeline: "",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.inquiryType === "Consulting") {
      expect(result.data.companySize).toBeUndefined();
      expect(result.data.estimatedBudget).toBeUndefined();
      expect(result.data.phone).toBeUndefined();
    }
  });

  it("rejects a missing required company", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Consulting",
      ...baseContact,
      title: "Head of Talent",
      company: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid optional select value", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Consulting",
      ...engagement,
      companySize: "500-ish",
    });
    expect(result.success).toBe(false);
  });
});

describe("Submit Resume", () => {
  // Candidates apply as individuals: no title/company/companySize collected.
  const resumeBase = { ...baseContact };

  it("accepts a submission without any company details", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
      resume: makeFile("cv.pdf", "application/pdf", 1024),
    });
    expect(result.success).toBe(true);
  });

  it("strips company details out of the parsed payload", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
      title: "Senior Engineer",
      company: "Acme Inc.",
      companySize: "51-200",
      resume: makeFile("cv.pdf", "application/pdf", 1024),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("title");
      expect(result.data).not.toHaveProperty("company");
      expect(result.data).not.toHaveProperty("companySize");
    }
  });

  it("still accepts an optional phone number", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
      phone: "+1 555 000 0000",
      resume: makeFile("cv.pdf", "application/pdf", 1024),
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.inquiryType === "Submit Resume") {
      expect(result.data.phone).toBe("+1 555 000 0000");
    }
  });

  it("accepts a valid PDF under the size limit", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
      resume: makeFile("cv.pdf", "application/pdf", 1024),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a .docx file", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
      resume: makeFile(
        "cv.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        2048,
      ),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a file over 10MB", () => {
    const result = resumeFileSchema.safeParse(
      makeFile("cv.pdf", "application/pdf", MAX_RESUME_BYTES + 1),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("File must be 10MB or less");
    }
  });

  it("rejects a wrong file type", () => {
    const result = resumeFileSchema.safeParse(
      makeFile("cv.png", "image/png", 1024),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "Resume must be a PDF or Word document",
      );
    }
  });

  it("rejects a missing resume", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Submit Resume",
      ...resumeBase,
    });
    expect(result.success).toBe(false);
  });
});

/**
 * The widget and the Worker must enforce the SAME limits, and the Worker's copy
 * is authoritative. If the two drift, the widget starts promising something the
 * server rejects and the user gets a confusing failure after upload.
 *
 * These tests drive the widget schema's boundary from the shared module rather
 * than comparing the two constants to each other: a value comparison would still
 * pass if `src/schema.ts` kept its own hardcoded limit and merely re-exported
 * the shared one. Asserting behaviour at the boundary cannot be faked that way.
 */
describe("resume limits are shared with the Worker", () => {
  it("accepts a file of exactly the shared maximum size", () => {
    const result = resumeFileSchema.safeParse(
      makeFile("cv.pdf", "application/pdf", SHARED_MAX_RESUME_BYTES),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a file one byte over the shared maximum size", () => {
    const result = resumeFileSchema.safeParse(
      makeFile("cv.pdf", "application/pdf", SHARED_MAX_RESUME_BYTES + 1),
    );
    expect(result.success).toBe(false);
  });

  it.each(SHARED_ALLOWED_RESUME_EXTENSIONS)(
    "accepts the shared extension %s",
    (extension) => {
      const result = resumeFileSchema.safeParse(
        makeFile(`cv${extension}`, "", 1024),
      );
      expect(result.success).toBe(true);
    },
  );

  it("rejects an extension the shared list does not carry", () => {
    expect(SHARED_ALLOWED_RESUME_EXTENSIONS).not.toContain(".rtf");

    const result = resumeFileSchema.safeParse(makeFile("cv.rtf", "", 1024));
    expect(result.success).toBe(false);
  });
});

describe("discriminated union", () => {
  it("rejects an unknown inquiry type", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "Partnership",
      ...baseContact,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing inquiry type", () => {
    const result = contactFormSchema.safeParse({ ...baseContact });
    expect(result.success).toBe(false);
  });

  it("reports a human-readable error on the inquiryType path for the placeholder value", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "",
      ...baseContact,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(["inquiryType"]);
      expect(issue?.message).toBe("Please select an inquiry type");
    }
  });
});

/**
 * The widget and the Worker validate the same submission twice, and the only
 * thing that makes that safe is both sides reading one table. A field required
 * on the server but optional in the form is a submission the user is told is
 * fine and the server then throws away - the failure this project is named
 * after - so the agreement is asserted rather than assumed.
 */
describe("widget and Worker cannot diverge on the submission contract", () => {
  const REQUIRED_BY_TYPE = {
    "Recruitment / Hiring": ["title", "company"],
    Consulting: ["title", "company"],
    "General Question": [],
    "Submit Resume": [],
  } as const;

  function completeValues(type: (typeof INQUIRY_TYPES)[number]) {
    const values: Record<string, unknown> = { inquiryType: type, ...baseContact };
    for (const field of REQUIRED_BY_TYPE[type]) values[field] = "Something";
    if (type === "Submit Resume") {
      values.resume = makeFile("cv.pdf", "application/pdf", 1024);
    }
    return values;
  }

  it("offers exactly the inquiry types the shared module defines", () => {
    expect([...INQUIRY_TYPES]).toEqual([...SHARED_INQUIRY_TYPES]);
  });

  it.each(SHARED_INQUIRY_TYPES)("parses a complete %s submission", (type) => {
    expect(contactFormSchema.safeParse(completeValues(type)).success).toBe(true);
  });

  /**
   * The load-bearing direction. For every field the Worker will refuse the
   * submission over, the form must refuse it first, or the user gets a server
   * error for something the form told them was complete.
   */
  it.each(
    SHARED_INQUIRY_TYPES.flatMap((type) =>
      (requiredTextFieldsFor(type) ?? []).map(
        (field) => [type, field] as [string, string],
      ),
    ),
  )("rejects a %s submission missing %s, exactly as the Worker does", (type, field) => {
    const values = completeValues(type as (typeof INQUIRY_TYPES)[number]);
    delete values[field];

    expect(contactFormSchema.safeParse(values).success).toBe(false);
  });

  /**
   * Containment, and the direction is deliberate: the server's email check must
   * accept EVERYTHING the form accepts. A server rule stricter than the client's
   * silently refuses a candidate whose address the browser called valid.
   */
  it.each([
    "jane@company.com",
    "jane.doe@example.com",
    "jane+tag@example.co.uk",
    "j@sub.domain.example.com",
    "jane_doe-99@example-corp.com",
    "JANE.DOE@EXAMPLE.COM",
    "a@b.co",
    "first.last+filter@many.sub.domains.example.museum",
  ])("accepts %p on both sides, never in the form alone", (email) => {
    const parsed = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
      workEmail: email,
    });

    expect(parsed.success).toBe(true);
    expect(hasEmailShape(email)).toBe(true);
  });

  it.each(["not-an-email", "jane.doe@", "@example.com", "jane doe@x.com", "jane@example"])(
    "refuses %p on both sides",
    (email) => {
      const parsed = contactFormSchema.safeParse({
        inquiryType: "General Question",
        ...baseContact,
        workEmail: email,
      });

      expect(parsed.success).toBe(false);
      expect(hasEmailShape(email)).toBe(false);
    },
  );
});

/**
 * The request-size ceiling the Worker uses is derived from these limits, so if
 * the form does not enforce them the ceiling is not a bound and a legitimate
 * submission can be refused before it is even parsed.
 */
describe("text limits hold on the widget side too", () => {
  /**
   * The heaviest character per UTF-16 code unit, which is the unit zod counts.
   * A BMP character costs one code unit and three UTF-8 bytes; an emoji looks
   * bigger but is a surrogate pair, so it only costs two bytes per code unit.
   */
  const heaviestPerCodeUnit = "\u4E2D";

  it("accepts a message of exactly the shared character cap", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
      message: heaviestPerCodeUnit.repeat(MAX_TEXT_FIELD_CHARS),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a message one character over the shared cap", () => {
    const result = contactFormSchema.safeParse({
      inquiryType: "General Question",
      ...baseContact,
      message: heaviestPerCodeUnit.repeat(MAX_TEXT_FIELD_CHARS + 1),
    });

    expect(result.success).toBe(false);
  });

  /**
   * Containment, measured rather than reasoned: the largest value the form will
   * accept, in its heaviest possible encoding, must still fit the byte cap the
   * server enforces.
   */
  /** A string filled to exactly the cap in the unit zod counts. */
  function atCodeUnitCap(char: string): string {
    return char.repeat(Math.floor(MAX_TEXT_FIELD_CHARS / char.length));
  }

  it.each(["\u4E2D", "\u{1F600}", "a"])(
    "keeps the widest accepted value built from %p inside the server's byte cap",
    (char) => {
      const widest = atCodeUnitCap(char);

      // Genuinely at the boundary, so the byte assertion below is not passing
      // simply because the string is short.
      expect(widest.length).toBeGreaterThan(MAX_TEXT_FIELD_CHARS - char.length);
      expect(widest.length).toBeLessThanOrEqual(MAX_TEXT_FIELD_CHARS);

      const parsed = contactFormSchema.safeParse({
        inquiryType: "General Question",
        ...baseContact,
        message: widest,
      });

      expect(parsed.success).toBe(true);
      expect(utf8ByteLength(widest)).toBeLessThanOrEqual(MAX_TEXT_FIELD_BYTES);
    },
  );

  it("rejects a file name longer than the server accepts", () => {
    const name = `${"n".repeat(MAX_FILE_NAME_BYTES)}.pdf`;

    expect(resumeFileSchema.safeParse(makeFile(name, "application/pdf", 1024)).success).toBe(
      false,
    );
  });
});
