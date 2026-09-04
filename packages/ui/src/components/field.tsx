import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Label } from "./label.js";
import { cn } from "../lib/utils.js";

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return <fieldset data-slot="field-set" className={cn("flex flex-col gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3", className)} {...props} />;
}

function FieldLegend({ className, variant = "legend", ...props }: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return <legend data-slot="field-legend" data-variant={variant} className={cn("mb-3 font-medium data-[variant=legend]:text-base data-[variant=label]:text-sm", className)} {...props} />;
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("group/field-group @container/field-group flex w-full flex-col gap-7 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4", className)} {...props} />;
}

const fieldVariants = cva("group/field flex w-full gap-3 data-[invalid=true]:text-destructive", {
  variants: {
    orientation: {
      vertical: "flex-col [&>*]:w-full [&>.sr-only]:w-auto",
      horizontal: "flex-row items-center [&>[data-slot=field-label]]:flex-auto has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      responsive: "flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full @md/field-group:[&>*]:w-auto [&>.sr-only]:w-auto @md/field-group:[&>[data-slot=field-label]]:flex-auto @md/field-group:has-[>[data-slot=field-content]]:items-start"
    }
  },
  defaultVariants: { orientation: "vertical" }
});

function Field({ className, orientation = "vertical", ...props }: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return <div role="group" data-slot="field" data-orientation={orientation} className={cn(fieldVariants({ orientation }), className)} {...props} />;
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-content" className={cn("group/field-content flex flex-1 flex-col gap-1.5 leading-snug", className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50", className)} {...props} />;
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-label" className={cn("flex w-fit items-center gap-2 text-sm font-medium leading-snug group-data-[disabled=true]/field:opacity-50", className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-description" className={cn("text-sm font-normal leading-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary", className)} {...props} />;
}

function FieldSeparator({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="field-separator" data-content={Boolean(children)} className={cn("relative -my-2 flex h-5 items-center text-sm", className)} {...props}>
      <div role="separator" className="absolute inset-x-0 top-1/2 border-t" />
      {children ? <span data-slot="field-separator-content" className="relative mx-auto bg-background px-2 text-muted-foreground">{children}</span> : null}
    </div>
  );
}

function FieldError({ className, children, errors, ...props }: React.ComponentProps<"div"> & { errors?: Array<{ message?: string } | undefined> }) {
  const uniqueMessages = [...new Set(errors?.map((error) => error?.message).filter((message): message is string => Boolean(message)) ?? [])];
  const content = children ?? (uniqueMessages.length === 1 ? uniqueMessages[0] : uniqueMessages.length > 1 ? <ul className="ml-4 flex list-disc flex-col gap-1">{uniqueMessages.map((message) => <li key={message}>{message}</li>)}</ul> : null);
  if (!content) return null;
  return <div role="alert" data-slot="field-error" className={cn("text-sm font-normal text-destructive", className)} {...props}>{content}</div>;
}

export { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet, FieldTitle };
