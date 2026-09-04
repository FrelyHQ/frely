"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { Tooltip } from "@frely/ui/components/tooltip";

export interface SearchSelectOption {
  value: string;
  label: string;
  description?: string;
  metadata?: string;
  searchText?: string;
  className?: string;
  disabled?: boolean;
}

export interface SearchSelectPagination {
  page: number;
  totalPages: number;
  pending?: boolean;
  onPageChange: (page: number) => void;
}

export interface SearchSelectProps {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  options: SearchSelectOption[];
  onValueChange?: (value: string) => void;
  onSearchChange?: (query: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  allowCustomValue?: boolean;
  clearOnFocus?: boolean;
  ariaLabel?: string;
  pagination?: SearchSelectPagination;
}

type OptionMenuItem = {
  kind: "option";
  option: SearchSelectOption;
};

type CustomMenuItem = {
  kind: "custom";
  value: string;
};

type MenuItem = OptionMenuItem | CustomMenuItem;

export function SearchSelect(props: SearchSelectProps) {
  const {
    id,
    name,
    value,
    defaultValue = "",
    options,
    onValueChange,
    onSearchChange,
    onBlur,
    onFocus,
    onOpenChange,
    placeholder,
    disabled = false,
    searchable = true,
    allowCustomValue = false,
    clearOnFocus = true,
    ariaLabel,
    pagination
  } = props;
  const generatedId = useId().replace(/:/g, "");
  const inputId = id ?? `search-select-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const paginationId = `${inputId}-pagination`;
  const controlled = value !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const committedValue = controlled ? value : uncontrolledValue;
  const selectedOption = useMemo(
    () => options.find((option) => option.value === committedValue),
    [committedValue, options]
  );
  const selectedLabel = selectedOption?.label ?? (allowCustomValue ? committedValue : "");
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const formMirrorRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(false);

  const filteredOptions = useMemo<OptionMenuItem[]>(() => {
    const normalizedQuery = searchable ? query.trim().toLowerCase() : "";
    return options.flatMap((option) => {
      if (!normalizedQuery) return [{ kind: "option" as const, option }];
      const haystack = `${option.label} ${option.description ?? ""} ${option.metadata ?? ""} ${option.searchText ?? ""} ${option.value}`.toLowerCase();
      return haystack.includes(normalizedQuery) ? [{ kind: "option" as const, option }] : [];
    });
  }, [options, query, searchable]);
  const customQuery = query.trim();
  const canUseCustomValue = Boolean(
    searchable
      && allowCustomValue
      && customQuery
      && !options.some((option) => option.value === customQuery || option.label === customQuery)
  );
  const menuItems = useMemo<MenuItem[]>(
    () => canUseCustomValue
      ? [{ kind: "custom", value: customQuery }, ...filteredOptions]
      : filteredOptions,
    [canUseCustomValue, customQuery, filteredOptions]
  );
  const activeItem = menuItems[activeIndex];
  const activeDescendant = open && activeItem ? menuItemId(activeItem) : undefined;
  const paginationPage = pagination?.page ?? 1;
  const paginationTotalPages = Math.max(1, pagination?.totalPages ?? 1);
  const paginationPending = pagination?.pending ?? false;
  const showPagination = Boolean(
    pagination && (paginationPending || paginationPage > 1 || paginationTotalPages > 1)
  );

  const setOpenValue = useCallback((nextOpen: boolean) => {
    if (openRef.current === nextOpen) return;
    openRef.current = nextOpen;
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange]);

  const updateMenuStyle = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 4;
    const viewportMargin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableBelow = viewportHeight - rect.bottom - gap - viewportMargin;
    const availableAbove = rect.top - gap - viewportMargin;
    const placeAbove = availableBelow < 160 && availableAbove > availableBelow;
    const availableHeight = Math.max(72, placeAbove ? availableAbove : availableBelow);
    const menuWidth = Math.min(rect.width, viewportWidth - viewportMargin * 2);
    const menuLeft = Math.min(
      Math.max(viewportMargin, rect.left),
      Math.max(viewportMargin, viewportWidth - viewportMargin - menuWidth)
    );
    setMenuStyle({
      position: "fixed",
      top: placeAbove ? "auto" : rect.bottom + gap,
      bottom: placeAbove ? viewportHeight - rect.top + gap : "auto",
      left: menuLeft,
      right: "auto",
      width: menuWidth,
      maxHeight: Math.min(220, availableHeight),
      zIndex: 1000
    });
  }, []);

  const firstEnabledIndex = useCallback((items: MenuItem[] = menuItems) => (
    items.findIndex(isEnabledMenuItem)
  ), [menuItems]);

  const lastEnabledIndex = useCallback((items: MenuItem[] = menuItems) => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (isEnabledMenuItem(items[index])) return index;
    }
    return -1;
  }, [menuItems]);

  const selectedMenuIndex = useCallback((items: MenuItem[] = menuItems) => {
    const index = items.findIndex((item) => item.kind === "option" && item.option.value === committedValue && !item.option.disabled);
    return index >= 0 ? index : firstEnabledIndex(items);
  }, [committedValue, firstEnabledIndex, menuItems]);

  const prepareOpenState = useCallback(() => {
    const nextQuery = searchable
      ? clearOnFocus ? "" : selectedLabel
      : "";
    setQuery(nextQuery);
    onSearchChange?.(nextQuery);
    const normalizedQuery = searchable ? nextQuery.trim().toLowerCase() : "";
    const nextOptions = options.flatMap((option) => {
      if (!normalizedQuery) return [{ kind: "option" as const, option }];
      const haystack = `${option.label} ${option.description ?? ""} ${option.metadata ?? ""} ${option.searchText ?? ""} ${option.value}`.toLowerCase();
      return haystack.includes(normalizedQuery) ? [{ kind: "option" as const, option }] : [];
    });
    setActiveIndex(selectedMenuIndex(nextOptions));
    updateMenuStyle();
    setOpenValue(true);
  }, [clearOnFocus, onSearchChange, options, searchable, selectedLabel, selectedMenuIndex, setOpenValue, updateMenuStyle]);

  const closeMenu = useCallback(() => {
    setQuery(selectedLabel);
    setActiveIndex(-1);
    setOpenValue(false);
  }, [selectedLabel, setOpenValue]);

  useEffect(() => {
    if (!open) setQuery(selectedLabel);
  }, [open, selectedLabel]);

  useEffect(() => {
    if (!open) return;
    updateMenuStyle();
    window.addEventListener("resize", updateMenuStyle);
    window.addEventListener("scroll", updateMenuStyle, true);
    return () => {
      window.removeEventListener("resize", updateMenuStyle);
      window.removeEventListener("scroll", updateMenuStyle, true);
    };
  }, [open, updateMenuStyle]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex < 0 || activeIndex >= menuItems.length || !isEnabledMenuItem(menuItems[activeIndex])) {
      setActiveIndex(firstEnabledIndex());
    }
  }, [activeIndex, firstEnabledIndex, menuItems, open]);

  useEffect(() => {
    if (!open || !pagination) return;
    setActiveIndex(firstEnabledIndex());
  }, [firstEnabledIndex, open, pagination, paginationPage]);

  useEffect(() => {
    if (!activeDescendant) return;
    document.getElementById(activeDescendant)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDescendant]);

  useEffect(() => {
    if (!disabled) return;
    closeMenu();
  }, [closeMenu, disabled]);

  useEffect(() => {
    const form = formMirrorRef.current?.form;
    if (!form) return;
    const handleReset = () => {
      if (!controlled) setUncontrolledValue(defaultValue);
      const resetOption = options.find((option) => option.value === (controlled ? committedValue : defaultValue));
      setQuery(resetOption?.label ?? (allowCustomValue ? controlled ? committedValue : defaultValue : ""));
      setActiveIndex(-1);
      setOpenValue(false);
    };
    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [allowCustomValue, committedValue, controlled, defaultValue, options, setOpenValue]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (value !== undefined && props.defaultValue !== undefined) {
      console.error("SearchSelect cannot use both value and defaultValue as value sources.");
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.value)) {
        console.error(`SearchSelect option values must be unique; duplicate value: ${option.value}`);
        break;
      }
      seen.add(option.value);
    }
  }, [options, props.defaultValue, value]);

  const menu = (
    <div
      id={listboxId}
      className="combobox-menu"
      role="listbox"
      aria-label={ariaLabel}
      aria-busy={paginationPending || undefined}
      aria-describedby={showPagination ? paginationId : undefined}
      data-search-select-overlay
      style={menuStyle}
    >
      <div
        className="combobox-listbox"
        role="presentation"
        onWheel={(event) => {
          const distance = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? event.deltaY * 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? event.deltaY * event.currentTarget.clientHeight
              : event.deltaY;
          event.currentTarget.scrollTop += distance;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {menuItems.map((item, index) => item.kind === "custom" ? (
          <Tooltip content="Custom value" key="custom-value">
            <Button
              id={menuItemId(item)}
              variant="ghost"
              size="sm"
              className={optionClassName("custom-value", index === activeIndex)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={item.value === committedValue}
              onMouseDown={(event) => {
                event.preventDefault();
                commitItem(item);
              }}
            >
              <strong>Use &quot;{item.value}&quot;</strong>
              <span>Custom value</span>
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={item.option.description} key={item.option.value}>
            <Button
              id={menuItemId(item)}
              variant="ghost"
              size="sm"
              className={optionClassName(item.option.className, index === activeIndex)}
              type="button"
              role="option"
              tabIndex={-1}
              disabled={item.option.disabled}
              aria-selected={item.option.value === committedValue}
              aria-disabled={item.option.disabled || undefined}
              onMouseEnter={() => {
                if (!item.option.disabled) setActiveIndex(index);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                if (!item.option.disabled) commitItem(item);
              }}
            >
              <strong>{item.option.label}</strong>
              {item.option.description ? <span>{item.option.description}</span> : null}
              {item.option.metadata ? <span>{item.option.metadata}</span> : null}
            </Button>
          </Tooltip>
        ))}
        {menuItems.length === 0 ? <span className="combobox-empty">No matching options.</span> : null}
      </div>
      {showPagination ? (
        <div className="combobox-pagination" role="presentation">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            tabIndex={-1}
            disabled={paginationPage <= 1 || paginationPending}
            aria-label="Previous page"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => changePage(paginationPage - 1)}
          >
            Previous
          </Button>
          <span id={paginationId} className="combobox-pagination-status" role="status" aria-live="polite">
            {paginationPending ? `Loading page ${paginationPage}…` : `Page ${paginationPage} / ${paginationTotalPages}`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            tabIndex={-1}
            disabled={paginationPage >= paginationTotalPages || paginationPending}
            aria-label="Next page"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => changePage(paginationPage + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <span className="combobox-field">
      <Input
        id={inputId}
        ref={inputRef}
        value={open ? query : selectedLabel}
        onFocus={() => {
          onFocus?.();
          prepareOpenState();
        }}
        onClick={() => {
          if (!openRef.current) prepareOpenState();
        }}
        onChange={(event) => {
          if (!searchable) return;
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          onSearchChange?.(nextQuery);
          setActiveIndex(-1);
          updateMenuStyle();
          setOpenValue(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          closeMenu();
          onBlur?.();
        }}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={!searchable}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-autocomplete={searchable ? "list" : "none"}
        aria-keyshortcuts={pagination ? "PageUp PageDown" : undefined}
      />
      <input ref={formMirrorRef} type="hidden" name={name} value={committedValue} disabled={disabled} readOnly />
      {open ? createPortal(menu, document.body) : null}
    </span>
  );

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key === "Escape") {
      if (openRef.current) event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!openRef.current) {
        prepareOpenState();
        return;
      }
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" && openRef.current) {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex());
      return;
    }
    if (event.key === "End" && openRef.current) {
      event.preventDefault();
      setActiveIndex(lastEnabledIndex());
      return;
    }
    if (pagination && openRef.current && (event.key === "PageDown" || event.key === "PageUp")) {
      event.preventDefault();
      changePage(paginationPage + (event.key === "PageDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!openRef.current) {
        prepareOpenState();
        return;
      }
      if (activeItem && isEnabledMenuItem(activeItem)) commitItem(activeItem);
      return;
    }
    if (!searchable && event.key === " ") {
      event.preventDefault();
      if (openRef.current) closeMenu();
      else prepareOpenState();
    }
  }

  function moveActive(delta: 1 | -1) {
    if (!menuItems.some(isEnabledMenuItem)) {
      setActiveIndex(-1);
      return;
    }
    let nextIndex = activeIndex;
    for (let count = 0; count < menuItems.length; count += 1) {
      nextIndex = (nextIndex + delta + menuItems.length) % menuItems.length;
      if (isEnabledMenuItem(menuItems[nextIndex])) {
        setActiveIndex(nextIndex);
        return;
      }
    }
  }

  function commitItem(item: MenuItem) {
    const nextValue = item.kind === "custom" ? item.value : item.option.value;
    const nextLabel = item.kind === "custom" ? item.value : item.option.label;
    if (!controlled) setUncontrolledValue(nextValue);
    if (nextValue !== committedValue) onValueChange?.(nextValue);
    setQuery(nextLabel);
    setActiveIndex(-1);
    setOpenValue(false);
  }

  function changePage(nextPage: number) {
    if (
      !pagination
      || paginationPending
      || nextPage < 1
      || nextPage > paginationTotalPages
      || nextPage === paginationPage
    ) return;
    setActiveIndex(-1);
    pagination.onPageChange(nextPage);
  }

  function menuItemId(item: MenuItem) {
    return item.kind === "custom"
      ? `${listboxId}-custom`
      : `${listboxId}-option-${encodeURIComponent(item.option.value)}`;
  }
}

function isEnabledMenuItem(item: MenuItem | undefined): item is MenuItem {
  return Boolean(item && (item.kind === "custom" || !item.option.disabled));
}

function optionClassName(className: string | undefined, active: boolean) {
  return ["combobox-option", className, active ? "is-active" : undefined].filter(Boolean).join(" ");
}
