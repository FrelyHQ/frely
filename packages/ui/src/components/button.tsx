import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[4px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--primary-strong)] bg-[var(--primary)] text-white shadow-[0_1px_2px_rgba(15,23,42,0.22)] hover:bg-[var(--primary-strong)]",
        destructive:
          "border border-[var(--bad)] bg-[var(--bad)] text-white shadow-[0_1px_2px_rgba(15,23,42,0.22)] hover:bg-[#be123c]",
        warning:
          "border border-[var(--warn)] bg-[var(--warn)] text-white shadow-[0_1px_2px_rgba(15,23,42,0.22)] hover:bg-[#b45309]",
        outline:
          "border-2 border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-[0_1px_2px_rgba(15,23,42,0.12)] hover:border-[var(--primary)] hover:bg-[var(--primary-soft)] hover:text-[var(--primary-strong)]",
        secondary:
          "border-2 border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-[0_1px_2px_rgba(15,23,42,0.12)] hover:border-[var(--primary)] hover:bg-[var(--primary-soft)] hover:text-[var(--primary-strong)]",
        ghost: "border border-transparent hover:bg-accent hover:text-accent-foreground",
        link: "h-auto border border-transparent p-0 text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-5",
        icon: "size-9 p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";

  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
