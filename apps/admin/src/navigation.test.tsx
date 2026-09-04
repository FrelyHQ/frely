import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";

const mocks = vi.hoisted(() => ({
  routerLinks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: React.forwardRef<HTMLAnchorElement, Record<string, unknown>>((props, ref) => {
    mocks.routerLinks.push(props);
    return <a ref={ref} href={String(props.to)}>{String(props.children ?? "")}</a>;
  }),
  notFound: vi.fn(),
  redirect: vi.fn(),
  useLocation: vi.fn(),
  useRouter: vi.fn(),
}));

import Link from "./navigation";

beforeEach(() => {
  mocks.routerLinks.length = 0;
});

describe("Admin navigation adapter", () => {
  test("maps scroll false to TanStack resetScroll false", () => {
    renderToStaticMarkup(<Link href="/owner/teams" scroll={false}>Teams</Link>);

    expect(mocks.routerLinks).toHaveLength(1);
    expect(mocks.routerLinks[0]).toEqual(expect.objectContaining({
      to: "/owner/teams",
      resetScroll: false,
    }));
    expect(mocks.routerLinks[0]).not.toHaveProperty("scroll");
  });

  test.each([
    <Link key="download" href="/owner/teams" download>Download</Link>,
    <Link key="blank" href="/owner/teams" target="_blank">Open</Link>,
  ])("keeps download and non-self target links as native anchors", (link) => {
    const html = renderToStaticMarkup(link);

    expect(mocks.routerLinks).toHaveLength(0);
    expect(html).toContain("<a");
  });
});
