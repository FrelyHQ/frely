import type { ReactNode } from "react";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";

interface DirectoryPanelProps {
  title: string;
  description: string;
  action: string;
  query: string;
  placeholder: string;
  emptyLabel: string;
  hasRows: boolean;
  hiddenParams?: Record<string, string | number | undefined>;
  children: ReactNode;
}

export function DirectoryPanel({ title, description, action, query, placeholder, emptyLabel, hasRows, hiddenParams, children }: DirectoryPanelProps) {
  return (
    <Card className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p className="muted">{description}</p>
        </div>
        <form className="directory-tools" action={action}>
          {Object.entries(hiddenParams ?? {}).flatMap(([name, value]) => value === undefined || value === "" ? [] : (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label className="search-field">
            <span className="search-icon">S</span>
            <Input name="q" defaultValue={query} placeholder={placeholder} />
          </label>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {hasRows ? children : <div className="empty-state" data-ui-surface-empty-state="true">{emptyLabel}</div>}
    </Card>
  );
}
