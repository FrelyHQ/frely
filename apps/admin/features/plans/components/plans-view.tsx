"use client";

import { PlanManagement, type PlanManagementProps } from "./plan-management";

export function PlansView(props: PlanManagementProps) {
  return <PlanManagement {...props} />;
}
