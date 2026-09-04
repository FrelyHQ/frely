import { describe, expect, test } from "vitest";
import { cardsInventoryStatusHref, cardsPageHref, parseCardInventoryApiState, parseCardsUrlState } from "./cards-url-state";

describe("Cards URL state", () => {
  test("allowlists positive bounded inventory and transfer pages", () => {
    expect(parseCardsUrlState(new URLSearchParams("page=2&transferPage=3"))).toEqual({ inventoryStatus: "available", page: 2, pageSize: 20, transferPage: 3, transferPageSize: 20 });
    expect(parseCardsUrlState(new URLSearchParams("status=all&page=0&transferPage=bad"))).toEqual({ inventoryStatus: "all", page: 1, pageSize: 20, transferPage: 1, transferPageSize: 20 });
    expect(parseCardsUrlState(new URLSearchParams("status=unknown&page=999999"))).toEqual({ inventoryStatus: "available", page: 10_000, pageSize: 20, transferPage: 1, transferPageSize: 20 });
  });

  test("preserves the other collection page while navigating and removes page one", () => {
    const current = new URLSearchParams("page=4&transferPage=2&ignored=value");
    expect(cardsPageHref(current, "page", 3)).toBe("/user/cards?page=3&transferPage=2");
    expect(cardsPageHref(current, "transferPage", 1)).toBe("/user/cards?page=4");
  });

  test("resets inventory pagination when its status filter changes and preserves transfer state", () => {
    const current = new URLSearchParams("page=4&pageSize=50&transferPage=2&transferPageSize=100");
    expect(cardsInventoryStatusHref(current, "all")).toBe("/user/cards?status=all&pageSize=50&transferPage=2&transferPageSize=100");
    expect(cardsInventoryStatusHref(new URLSearchParams("status=all&page=4"), "available")).toBe("/user/cards");
  });

  test("strictly allowlists inventory API filters", () => {
    expect(parseCardInventoryApiState(new URLSearchParams())).toEqual({ inventoryStatus: "available", page: 1, pageSize: 20 });
    expect(parseCardInventoryApiState(new URLSearchParams("status=all&page=2&pageSize=50"))).toEqual({ inventoryStatus: "all", page: 2, pageSize: 50 });
    expect(parseCardInventoryApiState(new URLSearchParams("status=closed"))).toBeNull();
    expect(parseCardInventoryApiState(new URLSearchParams("transferPage=2"))).toBeNull();
    expect(parseCardInventoryApiState(new URLSearchParams("pageSize=500"))).toBeNull();
  });
});
