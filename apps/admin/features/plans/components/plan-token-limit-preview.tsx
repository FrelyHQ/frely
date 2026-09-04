import React from "react";
import type { PlanTokenLimitPreview as PlanTokenLimitPreviewModel, TokenLimitPreviewItem } from "../form/plan-model";

export function PlanTokenLimitPreview({ preview }: { preview: PlanTokenLimitPreviewModel }) {
  const hasBothLimitScopes = preview.userLimits.length > 0 && preview.subscriptionLimits.length > 0;

  return (
    <section className="template-token-limit-preview" aria-labelledby="configured-token-limits-title">
      <div className="template-rule-heading">
        <div>
          <strong id="configured-token-limits-title">Configured token limits</strong>
          <p className="muted">Preview of token limits in this Plan draft. This is not a real-time remaining balance.</p>
        </div>
      </div>
      <div className="template-token-limit-grid">
        <TokenLimitGroup
          title="Each user · User limits"
          limits={preview.userLimits}
          empty="No per-user token limit configured."
          description="Usage across the same user's API keys is combined."
        />
        <TokenLimitGroup
          title="Entire team · Subscription limits"
          limits={preview.subscriptionLimits}
          empty="No shared Subscription token limit configured."
          description="Shared by all users when this Plan is subscribed at Team scope."
        />
      </div>
      {hasBothLimitScopes ? (
        <p className="template-token-limit-explanation">
          Both limits apply. One user is constrained by both their own remaining limit and the remaining shared Subscription limit.
        </p>
      ) : null}
      {preview.incompleteRuleIndexes.length > 0 ? (
        <div className="template-token-limit-incomplete" role="status">
          {preview.incompleteRuleIndexes.map((index) => <p key={index}>Limit {index + 1}: Complete this token limit to preview it.</p>)}
        </div>
      ) : null}
    </section>
  );
}

function TokenLimitGroup({ title, limits, empty, description }: { title: string; limits: TokenLimitPreviewItem[]; empty: string; description: string }) {
  return (
    <section className="template-token-limit-group" aria-label={title}>
      <strong>{title}</strong>
      {limits.length > 0 ? (
        <ul>
          {limits.map((limit) => <li key={`${limit.sourceIndex}-${limit.windowType}`}>{limit.label}</li>)}
        </ul>
      ) : <p className="muted">{empty}</p>}
      <p className="muted">{description}</p>
    </section>
  );
}
