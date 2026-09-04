"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { getSurfaceRuntime, isDialogContentReady } from "@frely/observability/client-runtime";
import { QueryClientContext } from "@tanstack/react-query";
import { cn } from "../lib/utils.js";

const DialogObservabilityContext = React.createContext<{ key: string; open: boolean } | null>(null);

function useOptionalActiveQueryCount(): number {
  const queryClient = React.useContext(QueryClientContext);
  return React.useSyncExternalStore(
    React.useCallback(
      (onStoreChange) => queryClient
        ? queryClient.getQueryCache().subscribe(() => onStoreChange())
        : () => undefined,
      [queryClient],
    ),
    () => queryClient?.isFetching() ?? 0,
    () => 0,
  );
}

function Dialog({
  observabilityKey,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { observabilityKey: string }) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const resolvedOpen = open ?? uncontrolledOpen;
  const observability = React.useMemo(
    () => ({ key: observabilityKey, open: resolvedOpen }),
    [observabilityKey, resolvedOpen],
  );

  React.useEffect(() => {
    if (resolvedOpen) getSurfaceRuntime()?.openDialog(observabilityKey);
    else getSurfaceRuntime()?.closeDialog(observabilityKey);
  }, [observabilityKey, resolvedOpen]);

  return (
    <DialogObservabilityContext.Provider value={observability}>
      <DialogPrimitive.Root
        {...props}
        {...(open === undefined ? {} : { open })}
        {...(defaultOpen === undefined ? {} : { defaultOpen })}
        onOpenChange={(nextOpen) => {
          if (open === undefined) setUncontrolledOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
      />
    </DialogObservabilityContext.Provider>
  );
}

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>((props, ref) => <DialogPrimitive.Trigger ref={ref} data-ui-dialog-trigger="true" {...props} />);
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName;

const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    autoFocusFirstElement?: boolean;
  }
>(({ className, children, autoFocusFirstElement = false, onOpenAutoFocus, ...props }, forwardedRef) => {
  const contentRef = React.useRef<React.ElementRef<typeof DialogPrimitive.Content> | null>(null);
  const observability = React.useContext(DialogObservabilityContext);
  const reportedReady = React.useRef(false);
  const activeQueryCount = useOptionalActiveQueryCount();

  const setContentRef = React.useCallback(
    (node: React.ElementRef<typeof DialogPrimitive.Content> | null) => {
      contentRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef]
  );

  React.useEffect(() => {
    const element = contentRef.current;
    if (!observability?.open) {
      reportedReady.current = false;
      return;
    }
    if (!element || reportedReady.current || activeQueryCount > 0) return;
    let cancelled = false;
    let checking = false;
    const reportWhenReady = async () => {
      if (cancelled || checking || reportedReady.current || !isDialogContentReady(element)) return;
      checking = true;
      try {
        const animations = typeof element.getAnimations === "function"
          ? element.getAnimations({ subtree: true })
          : [];
        await Promise.allSettled(animations.map((animation) => animation.finished));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (cancelled || reportedReady.current || !isDialogContentReady(element)) return;
        reportedReady.current = true;
        getSurfaceRuntime()?.dialogReady(observability.key);
      } finally {
        checking = false;
      }
    };
    const observer = new MutationObserver(() => void reportWhenReady());
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["aria-busy", "data-ui-surface-pending", "disabled", "hidden"],
      childList: true,
      subtree: true,
    });
    void reportWhenReady();
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [activeQueryCount, observability]);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setContentRef}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented || autoFocusFirstElement) return;

          event.preventDefault();
          window.requestAnimationFrame(() => contentRef.current?.focus());
        }}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border bg-card p-5 text-card-foreground shadow-lg focus-visible:outline-none",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, sticky = false, ...props }: React.HTMLAttributes<HTMLDivElement> & { sticky?: boolean }) => (
  <div className={cn("flex flex-col gap-1.5", sticky && "sticky top-0 bg-card pb-4", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  sticky = false,
  feedback,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { sticky?: boolean; feedback?: React.ReactNode }) => {
  const stickyClasses = sticky && "sticky bottom-0 border-t bg-card pt-4";
  if (feedback) {
    return (
      <div className={cn("flex flex-col gap-2", stickyClasses, className)} {...props}>
        <div className="w-full [&_.notice-box]:mt-0">{feedback}</div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>
      </div>
    );
  }
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", stickyClasses, className)} {...props}>{children}</div>;
};
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold leading-none tracking-normal", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
};
