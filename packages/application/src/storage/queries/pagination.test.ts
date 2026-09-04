import { describe, expect, test } from "vitest";
import {
  DEFAULT_DIRECTORY_PAGE_SIZE,
  DIRECTORY_PAGE_SIZES,
  normalizeDirectoryPage,
  normalizeDirectoryPageSize,
  pageResult
} from "./pagination.js";

describe("directory pagination contract", () => {
  test("keeps the common presets and accepts bounded custom page sizes", () => {
    expect(DIRECTORY_PAGE_SIZES).toEqual([20, 50, 100, 200]);
    expect(DEFAULT_DIRECTORY_PAGE_SIZE).toBe(20);
    expect(normalizeDirectoryPageSize(20)).toBe(20);
    expect(normalizeDirectoryPageSize(50)).toBe(50);
    expect(normalizeDirectoryPageSize(100)).toBe(100);
    expect(normalizeDirectoryPageSize(200)).toBe(200);
    expect(normalizeDirectoryPageSize(21)).toBe(21);
    expect(normalizeDirectoryPageSize(37)).toBe(37);
    expect(normalizeDirectoryPageSize(0)).toBe(20);
    expect(normalizeDirectoryPageSize(201)).toBe(20);
    expect(normalizeDirectoryPageSize(1.5)).toBe(20);
    expect(normalizeDirectoryPageSize(undefined, 50)).toBe(50);
    expect(normalizeDirectoryPageSize(undefined, 500)).toBe(20);
  });

  test("keeps the empty result and out-of-range page contract stable", () => {
    expect(pageResult([], 0, 20, 42)).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
    expect(normalizeDirectoryPage(99, 2)).toBe(2);
  });
});
