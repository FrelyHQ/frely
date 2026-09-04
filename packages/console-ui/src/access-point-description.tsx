"use client";

import { Tooltip } from "@frely/ui/components/tooltip";

export function AccessPointDescription({
  description,
  className,
}: {
  description: string | null | undefined;
  className?: string;
}) {
  const classes = ["access-point-description", className].filter(Boolean).join(" ");
  if (!description) return <span className={`${classes} access-point-description-empty`}>—</span>;
  return (
    <Tooltip content={<span className="access-point-description-tooltip">{description}</span>}>
      <span className={classes} tabIndex={0}>{description}</span>
    </Tooltip>
  );
}
