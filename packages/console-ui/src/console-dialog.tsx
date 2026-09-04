"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@frely/ui/components/dialog";
import { cn } from "@frely/ui/lib/utils";

function DialogHeading({ eyebrow, title, titleId }: { eyebrow: string; title: ReactNode; titleId: string }) {
  return (
    <div className="dialog-heading-line">
      <span className="dialog-heading-eyebrow">{eyebrow}</span>
      <span className="dialog-heading-separator">/</span>
      <DialogTitle id={titleId} className="dialog-heading-title">{title}</DialogTitle>
    </div>
  );
}

export function ConsoleDialogFooter({
  className,
  ...props
}: ComponentProps<typeof DialogFooter>) {
  return <DialogFooter className={cn("modal-footer", className)} {...props} />;
}

export function ConsoleDialog({
  observabilityKey,
  titleId,
  eyebrow,
  title,
  description,
  children,
  open = true,
  trigger,
  onOpen,
  closeDisabled = false,
  onClose
}: {
  observabilityKey: string;
  titleId: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  closeDisabled?: boolean;
  onClose: () => void;
} & (
  | { open?: never; trigger?: never; onOpen?: never }
  | { open: boolean; trigger: ReactElement; onOpen: () => void }
)) {
  return (
    <Dialog observabilityKey={observabilityKey} open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) {
        onOpen?.();
      } else if (!closeDisabled) {
        onClose();
      }
    }}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className="modal-card"
        aria-labelledby={titleId}
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (target instanceof Element && target.closest(".combobox-menu")) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="modal-header">
          <div>
            <DialogHeading eyebrow={eyebrow} title={title} titleId={titleId} />
            {description ? <DialogDescription className="muted">{description}</DialogDescription> : null}
          </div>
        </DialogHeader>
        <div className="modal-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export { ConsoleDialog as AdminDialog };
