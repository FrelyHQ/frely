"use client";

import { Tooltip } from "@frely/ui/components/tooltip";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const hiddenMenuStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  zIndex: 1000,
  visibility: "hidden",
};

export interface PortalMenuProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  menuAriaLabel?: string;
  tooltip?: string;
  triggerClassName?: string;
  triggerContent: ReactNode;
}

export function PortalMenu({
  ariaLabel,
  children,
  className,
  contentClassName,
  disabled = false,
  menuAriaLabel = `${ariaLabel} menu`,
  tooltip,
  triggerClassName,
  triggerContent,
}: PortalMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>(hiddenMenuStyle);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const updateMenuPosition = useCallback(() => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    if (!triggerRect || !menuRect) return;

    const gap = 6;
    const viewportMargin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableWidth = Math.max(0, viewportWidth - viewportMargin * 2);
    const spaceBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - viewportMargin);
    const spaceAbove = Math.max(0, triggerRect.top - gap - viewportMargin);
    const openAbove = menuRect.height > spaceBelow && spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;
    const menuHeight = Math.min(menuRect.height, availableHeight);
    const menuWidth = Math.min(Math.max(triggerRect.width, menuRect.width), availableWidth);
    const top = openAbove
      ? triggerRect.top - gap - menuHeight
      : triggerRect.bottom + gap;
    const left = Math.min(
      Math.max(viewportMargin, triggerRect.right - menuWidth),
      Math.max(viewportMargin, viewportWidth - viewportMargin - menuWidth),
    );

    setMenuStyle({
      position: "fixed",
      top: Math.max(viewportMargin, top),
      left,
      maxWidth: availableWidth,
      maxHeight: availableHeight,
      overflowY: menuRect.height > availableHeight ? "auto" : undefined,
      zIndex: 1000,
      visibility: "visible",
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')
      ?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [closeMenu, open, updateMenuPosition]);

  useEffect(() => {
    if (disabled && open) closeMenu();
  }, [closeMenu, disabled, open]);

  const trigger = (
    <button
      ref={triggerRef}
      className={triggerClassName}
      type="button"
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => {
        if (open) {
          closeMenu();
          return;
        }
        setMenuStyle(hiddenMenuStyle);
        setOpen(true);
      }}
    >
      {triggerContent}
    </button>
  );

  const menu = (
    <div
      ref={menuRef}
      className={contentClassName}
      role="menu"
      aria-label={menuAriaLabel}
      style={menuStyle}
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        const item = event.target.closest<HTMLElement>('[role="menuitem"]');
        if (!item || item.matches(":disabled") || item.getAttribute("aria-disabled") === "true") return;
        closeMenu(true);
      }}
    >
      {children}
    </div>
  );

  return (
    <div className={className}>
      {tooltip ? <Tooltip content={tooltip}>{trigger}</Tooltip> : trigger}
      {open ? createPortal(menu, document.body) : null}
    </div>
  );
}
