import { describe, expect, it } from "vitest";
import {
  contactFormSchema,
  MAX_RESUME_BYTES,
  resumeFileSchema,
} from "./schema";

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
