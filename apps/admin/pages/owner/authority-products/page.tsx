import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { Card } from "@frely/ui/components/card";
import { AuthorityProductLifecycleActions, AuthorityProductManagement } from "../../../features/authority-products";
import { PageHeading, StatusBadge } from "../_components/ui";
import type { AdminPageData } from "./page.server";

export default function AuthorityProductsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { products } = loaded;
  return <>
    <PageHeading eyebrow="Owner / Authority" title="Authority Products" description="Manage versioned Team creation and custom Provider access products.">
      <StatusBadge tone="info">Typed effect only</StatusBadge>
    </PageHeading>
    <section className="split-grid">
      <AuthorityProductManagement />
      <Card className="panel hierarchy-panel">
        <div className="panel-heading"><div><h2>Product Versions</h2><p className="muted">Listed versions are purchasable; commercial terms freeze after listing.</p></div></div>
        <MaterialTable
          columns={["Product", "Units / Price", "Validity", "Status", "Action"].map((header) => ({ header }))}
          rows={products.items.map((product) => ({
            id: product.id,
            cells: [
              <><strong>{product.displayName}</strong><code>{product.code}@{product.version} · {product.effectCode}</code></>,
              <>{product.grantUnits} / {Number(product.purchaseAmountUnits)}</>,
              <>{product.grantDurationSeconds}s</>,
              <StatusBadge tone={product.lifecycle === "listed" ? "good" : product.lifecycle === "draft" ? "info" : "neutral"}>{product.lifecycle}</StatusBadge>,
              <AuthorityProductLifecycleActions id={product.id} lifecycle={product.lifecycle} />
            ]
          }))}
          emptyState={{ title: "No Authority Product versions." }}
        />
        <MaterialTablePagination page={products.page} pageSize={products.pageSize} totalPages={products.totalPages} total={products.total} previousHref={products.page > 1 ? href(products.page - 1, products.pageSize) : ""} nextHref={products.page < products.totalPages ? href(products.page + 1, products.pageSize) : ""} noun="product versions" />
      </Card>
    </section>
  </>;
}

function href(page: number, pageSize: TablePageSize): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  return `/owner/authority-products${params.size ? `?${params}` : ""}`;
}
