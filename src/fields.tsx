import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { forwardRef } from "react";

/**
 * Field primitives. Each one wires up label association (`htmlFor`), the error
 * message, and the ARIA attributes (`aria-invalid`, `aria-describedby`) so the
 * form component doesn't have to repeat that plumbing per field.
 */

interface FieldWrapperProps {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  children: ReactNode;
}

function errorId(id: string) {
  return `${id}-error`;
}

export function FieldWrapper({
  id,
  label,
  optional,
  error,
  children,
}: FieldWrapperProps) {
  return (
    <div className="aag-form-field form_field-wrapper">
      <label className="aag-form-label form_label" htmlFor={id}>
        {label}
        {optional ? <span className="aag-form-optional"> (Optional)</span> : null}
      </label>
      {children}
      {error ? (
        <p className="aag-form-error" id={errorId(id)} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type TextFieldProps = {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ id, label, optional, error, ...inputProps }, ref) {
    return (
      <FieldWrapper id={id} label={label} optional={optional} error={error}>
        <input
          {...inputProps}
          id={id}
          ref={ref}
          className="form_input w-input"
          required={!optional}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId(id) : undefined}
        />
      </FieldWrapper>
    );
  },
);

type SelectFieldProps = {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  placeholder?: string;
  options: readonly string[];
} & SelectHTMLAttributes<HTMLSelectElement>;

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    { id, label, optional, error, placeholder, options, ...selectProps },
    ref,
  ) {
    return (
      <FieldWrapper id={id} label={label} optional={optional} error={error}>
        <select
          {...selectProps}
          id={id}
          ref={ref}
          className="form_input is-select-input w-select"
          defaultValue=""
          required={!optional}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId(id) : undefined}
        >
          <option value="" disabled={!optional}>
            {placeholder ?? "Select an option"}
          </option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FieldWrapper>
    );
  },
);

type TextareaFieldProps = {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField({ id, label, optional, error, ...textareaProps }, ref) {
    return (
      <FieldWrapper id={id} label={label} optional={optional} error={error}>
        <textarea
          {...textareaProps}
          id={id}
          ref={ref}
          className="form_input is-text-area w-input"
          required={!optional}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId(id) : undefined}
        />
      </FieldWrapper>
    );
  },
);

type FileFieldProps = {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export const FileField = forwardRef<HTMLInputElement, FileFieldProps>(
  function FileField({ id, label, optional, error, ...inputProps }, ref) {
    return (
      <FieldWrapper id={id} label={label} optional={optional} error={error}>
        <input
          {...inputProps}
          id={id}
          ref={ref}
          type="file"
          className="aag-form-file"
          required={!optional}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId(id) : undefined}
        />
      </FieldWrapper>
    );
  },
);
