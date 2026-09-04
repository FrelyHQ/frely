import { describe, expect, test } from "vitest";
import { parseServiceProductDirectoryApiState } from "./service-product-url-state";

describe("service product API directory state", () => {
  test("accepts only bounded query and page parameters", () => {
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("q=annual&page=2"))).toEqual({
      query: "annual",
      page: 2,
      pageSize: 20,
    });
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("pageSize=37"))).toMatchObject({ pageSize: 37 });
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("pageSize=201"))).toBeNull();
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("page=0"))).toBeNull();
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("page=10001"))).toBeNull();
    expect(parseServiceProductDirectoryApiState(new URLSearchParams("status=disabled"))).toBeNull();
    expect(parseServiceProductDirectoryApiState(new URLSearchParams(`q=${"x".repeat(101)}`))).toBeNull();
  });
});
