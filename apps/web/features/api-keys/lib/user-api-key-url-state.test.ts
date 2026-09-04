import { describe, expect, test } from "vitest";
import { parseUserApiKeyDirectoryApiState, userApiKeyDirectoryHref, userApiKeyDirectoryState } from "./user-api-key-url-state";

describe("user API Key directory URL state", () => {
  test("normalizes page and bounded query values", () => {
    expect(userApiKeyDirectoryState({ q: `  ${"x".repeat(120)}  `, page: "-4" })).toEqual({
      query: "x".repeat(100),
      page: 1,
      pageSize: 20,
    });
    expect(userApiKeyDirectoryState({ page: "10001" }).page).toBe(10_000);
  });

  test("preserves response-affecting state in page links", () => {
    expect(userApiKeyDirectoryHref({ query: "prod key", page: 2, pageSize: 20 })).toBe("/user/keys?q=prod+key&page=2");
    expect(userApiKeyDirectoryHref({ query: "", page: 1, pageSize: 20 })).toBe("/user/keys");
  });

  test("rejects public API parameters outside the directory contract", () => {
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("q=prod&page=2"))).toEqual({ query: "prod", page: 2, pageSize: 20 });
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("q=prod&page=2&pageSize=37"))).toEqual({ query: "prod", page: 2, pageSize: 37 });
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("pageSize=201"))).toBeNull();
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("page=0"))).toBeNull();
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("page=10001"))).toBeNull();
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams("sort=secret"))).toBeNull();
    expect(parseUserApiKeyDirectoryApiState(new URLSearchParams(`q=${"x".repeat(101)}`))).toBeNull();
  });
});
