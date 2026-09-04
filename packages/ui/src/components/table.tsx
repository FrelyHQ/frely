import * as React from "react";
import { Button } from "./button.js";
import { cn } from "../lib/utils.js";

type TableSortDirection = "asc" | "desc";
type TableDensity = "default" | "compact";
type TableAlignment = "left" | "center" | "right";
type TableMinWidth = "auto" | "content" | "wide" | number | string;

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  density?: TableDensity;
  minWidth?: TableMinWidth;
  stickyHeader?: boolean;
  wrapperClassName?: string;
}

interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  align?: TableAlignment;
  defaultSortDirection?: TableSortDirection;
  minWidth?: number | string;
  sortDirection?: TableSortDirection | false;
  sortDisabled?: boolean;
  width?: number | string;
  onSortChange?: (direction: TableSortDirection) => void;
}

interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  align?: TableAlignment;
  minWidth?: number | string;
  width?: number | string;
}

interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  clickable?: boolean;
  disabled?: boolean;
  selected?: boolean;
}

interface TableEmptyRowProps extends Omit<TableRowProps, "children" | "title"> {
  action?: React.ReactNode;
  cellClassName?: string;
  colSpan: number;
  description?: React.ReactNode;
  title: React.ReactNode;
}

interface TablePaginationProps extends React.HTMLAttributes<HTMLElement> {
  linkComponent?: React.ElementType<{ children?: React.ReactNode; href: string; rel?: string }>;
  nextHref?: string;
  nextLabel?: React.ReactNode;
  noun?: string;
  onNext?: () => void;
  onPrevious?: () => void;
  page: number;
  previousHref?: string;
  previousLabel?: React.ReactNode;
  rangeEnd?: number;
  rangeStart?: number;
  total: number;
  totalPages: number;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(({
  className,
  density = "default",
  minWidth = "content",
  stickyHeader = false,
  style,
  wrapperClassName,
  ...props
}, ref) => (
  <div className={cn("table-surface", wrapperClassName)} data-table-density={density} data-sticky-header={stickyHeader || undefined}>
    <table
      ref={ref}
      className={cn("table-root", className)}
      style={{ ...style, "--table-min-width": tableMinWidth(minWidth) } as React.CSSProperties}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("table-header", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("table-body", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("table-footer", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(({ className, clickable, disabled, selected, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn("table-row", className)}
    data-clickable={clickable || undefined}
    data-disabled={disabled || undefined}
    data-state={selected ? "selected" : undefined}
    aria-disabled={disabled || undefined}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ align = "left", className, children, defaultSortDirection = "asc", minWidth, sortDirection, sortDisabled = false, style, width, onSortChange, ...props }, ref) => {
    const isSortable = sortDirection !== undefined || onSortChange !== undefined;
    const nextSortDirection = sortDirection === "asc" ? "desc" : sortDirection === "desc" ? "asc" : defaultSortDirection;
    const ariaSort = props["aria-sort"] ?? (isSortable ? toAriaSort(sortDirection || false) : undefined);

    return (
      <th
        {...props}
        ref={ref}
        aria-sort={ariaSort}
        className={cn("table-head", isSortable && "table-sort-header", className)}
        data-align={align}
        style={cellStyle(style, width, minWidth)}
      >
        {isSortable ? (
          onSortChange ? (
            <button type="button" className="table-sort-button" disabled={sortDisabled} onClick={() => onSortChange(nextSortDirection)}>
              <span className="table-sort-content">{children}</span>
              <span className="table-sort-indicator" data-direction={sortDirection || "none"} aria-hidden="true" />
            </button>
          ) : (
            <span className="table-sort-label">
              <span className="table-sort-content">{children}</span>
              <span className="table-sort-indicator" data-direction={sortDirection || "none"} aria-hidden="true" />
            </span>
          )
        ) : children}
      </th>
    );
  }
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(({ align = "left", className, minWidth, style, width, ...props }, ref) => (
  <td ref={ref} className={cn("table-cell", className)} data-align={align} style={cellStyle(style, width, minWidth)} {...props} />
));
TableCell.displayName = "TableCell";

const TableEmptyRow = React.forwardRef<HTMLTableRowElement, TableEmptyRowProps>(({ action, cellClassName, colSpan, description, title, ...props }, ref) => (
  <TableRow ref={ref} data-empty="true" {...props}>
    <TableCell colSpan={colSpan} className={cn("table-empty-cell", cellClassName)}>
      <div className="table-empty-state">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
        {action ? <div className="table-empty-action">{action}</div> : null}
      </div>
    </TableCell>
  </TableRow>
));
TableEmptyRow.displayName = "TableEmptyRow";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("table-caption", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

function TablePagination({
  className,
  linkComponent: LinkComponent = "a",
  nextHref,
  nextLabel = "Next",
  noun = "records",
  onNext,
  onPrevious,
  page,
  previousHref,
  previousLabel = "Previous",
  rangeEnd,
  rangeStart,
  total,
  totalPages,
  ...props
}: TablePaginationProps) {
  const hasPrevious = Boolean(previousHref || onPrevious);
  const hasNext = Boolean(nextHref || onNext);
  const range = rangeStart !== undefined && rangeEnd !== undefined ? ` · ${rangeStart}–${rangeEnd}` : "";
  return (
    <nav className={cn("table-pagination", className)} aria-label={`${noun} pagination`} {...props}>
      <span className="table-pagination-summary">Page {page} of {totalPages} · {total} {noun}{range}</span>
      <div className="table-pagination-actions">
        {previousHref ? <Button asChild variant="secondary" size="sm"><LinkComponent href={previousHref} rel="prev">{previousLabel}</LinkComponent></Button> : <Button type="button" variant="outline" size="sm" disabled={!hasPrevious} onClick={onPrevious}>{previousLabel}</Button>}
        {nextHref ? <Button asChild variant="secondary" size="sm"><LinkComponent href={nextHref} rel="next">{nextLabel}</LinkComponent></Button> : <Button type="button" variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>{nextLabel}</Button>}
      </div>
    </nav>
  );
}

function tableMinWidth(value: TableMinWidth): string {
  if (typeof value === "number") return `${value}px`;
  if (value === "auto") return "100%";
  if (value === "content") return "max(100%, 48rem)";
  if (value === "wide") return "max(100%, 64rem)";
  return value;
}

function cellStyle(style: React.CSSProperties | undefined, width: number | string | undefined, minWidth: number | string | undefined): React.CSSProperties | undefined {
  if (width === undefined && minWidth === undefined) return style;
  return { ...style, width: cssSize(width), minWidth: cssSize(minWidth) };
}

function cssSize(value: number | string | undefined): string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

function toAriaSort(direction: TableHeadProps["sortDirection"]): React.AriaAttributes["aria-sort"] {
  if (direction === "asc") return "ascending";
  if (direction === "desc") return "descending";
  if (direction === false) return "none";
  return undefined;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableEmptyRow, TableCaption, TablePagination };
export type { TableAlignment, TableDensity, TableMinWidth, TablePaginationProps, TableProps, TableSortDirection };
