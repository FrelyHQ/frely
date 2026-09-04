export const navItems = [
  { label: "Overview", children: [{ label: "Dashboard", href: "/owner" }] },
  {
    label: "Identity",
    children: [
      { label: "Teams", href: "/owner/teams" },
      { label: "Users", href: "/owner/users" },
      { label: "Keys", href: "/owner/keys" },
      { label: "Credits", href: "/owner/credits" }
    ]
  },
  {
    label: "Access",
    children: [
      { label: "Providers", href: "/owner/providers" },
      { label: "Access Points", href: "/owner/access-points" },
      { label: "Pricing", href: "/owner/pricing" }
    ]
  },
  {
    label: "Plans & Budgets",
    children: [
      { label: "Authority Products", href: "/owner/authority-products" },
      { label: "Plans", href: "/owner/plans-and-budgets/plans" },
      { label: "Plan Payments", href: "/owner/plans-and-budgets/plan-purchases" },
      { label: "Subscriptions", href: "/owner/plans/subscriptions" },
      { label: "Batch Grants", href: "/owner/operations/grants" },
      { label: "Card Activations", href: "/owner/operations/card-activations" },
      { label: "Budget Policies", href: "/owner/plans-and-budgets/budget-policies" },
      { label: "Governance Budgets", href: "/owner/plans-and-budgets/governance-budgets" }
    ]
  },
  {
    label: "Observability",
    children: [
      { label: "Request Logs", href: "/owner/request-logs" },
      { label: "Audit Logs", href: "/owner/audit-logs" }
    ]
  },
  {
    label: "Tools",
    children: [
      { label: "API Test", href: "/owner/tools/api-test" },
      { label: "Access Resolution", href: "/owner/tools/access-resolution" }
    ]
  },
  { label: "System", children: [{ label: "System Settings", href: "/owner/system-settings" }] }
];
