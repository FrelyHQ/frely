"use client";

import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import type { ComponentProps, ReactNode } from "react";

interface FormFieldFrameProps {
  label: ReactNode;
  description?: ReactNode | undefined;
  errors?: unknown[] | undefined;
  children: ReactNode;
}

export function FormFieldFrame({ label, description, errors = [], children }: FormFieldFrameProps) {
  const messages = formErrorMessages(errors);
  return (
    <label>
      {label}
      {children}
      {description ? <span>{description}</span> : null}
      {messages.map((message) => <span key={message} className="field-error">{message}</span>)}
    </label>
  );
}

export function FormTextField({ label, description, errors, ...inputProps }: ComponentProps<typeof Input> & Omit<FormFieldFrameProps, "children">) {
  return <FormFieldFrame label={label} description={description} errors={errors}><Input {...inputProps} /></FormFieldFrame>;
}

export function FormTextareaField({ label, description, errors, ...textareaProps }: ComponentProps<typeof Textarea> & Omit<FormFieldFrameProps, "children">) {
  return <FormFieldFrame label={label} description={description} errors={errors}><Textarea {...textareaProps} /></FormFieldFrame>;
}

export function FormSubmitError({ message }: { message?: string | undefined }) {
  return message ? <div className="notice-box notice-bad" role="alert">{message}</div> : null;
}

function formErrorMessages(errors: unknown[]) {
  return [...new Set(errors.flatMap((error) => {
    if (typeof error === "string") return [error];
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return [error.message];
    return [];
  }))];
}
