import { describe, expect, test } from "vitest";
import { parseUserAccessDirectoryApiState, userAccessDirectoryHref, userAccessDirectoryState } from "./user-access-url-state";

describe("user Access directory URL state", () => {
  test("normalizes RSC query and page state", () => {
    expect(userAccessDirectoryState({ q: `  ${"x".repeat(120)}  `, page: "-2" })).toEqual({
      query: "x".repeat(100),
      page: 1,
      pageSize: 20,
    });
    expect(userAccessDirectoryState({ page: "10001" }).page).toBe(10_000);
  });

  test("preserves query state in both directory page links", () => {
    expect(userAccessDirectoryHref("available-models", { query: "gpt", page: 2, pageSize: 20 })).toBe("/user/access/available-models?q=gpt&page=2");
    expect(userAccessDirectoryHref("access-points", { query: "", page: 1, pageSize: 20 })).toBe("/user/access/access-points");
  });

  test("rejects public API parameters outside the shared response contract", () => {
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("q=gpt&page=2"))).toEqual({ query: "gpt", page: 2, pageSize: 20 });
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("q=gpt&page=2&pageSize=37"))).toEqual({ query: "gpt", page: 2, pageSize: 37 });
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("pageSize=201"))).toBeNull();
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("page=0"))).toBeNull();
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("page=10001"))).toBeNull();
    expect(parseUserAccessDirectoryApiState(new URLSearchParams("sort=provider"))).toBeNull();
    expect(parseUserAccessDirectoryApiState(new URLSearchParams(`q=${"x".repeat(101)}`))).toBeNull();
  });
});
