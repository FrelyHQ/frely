import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import UserNotFound from "./not-found";

vi.mock("@web/navigation", () => ({ default: "a" }));

describe("Web not-found navigation", () => {
  it("returns the user audience to its home", () => {
    const userMarkup = renderToStaticMarkup(<UserNotFound />);

    expect(userMarkup).toContain('href="/user"');
  });
});
