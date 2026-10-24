import { describe, expect, test } from "vitest";
import { chunkBatches } from "../src/core/batch";

describe("chunkBatches", () => {
  test("groups items until char limit is reached", () => {
    const items = ["aaaa", "bbbb", "cccc", "dd"];
    expect(chunkBatches(items, (s) => s.length, { maxChars: 8, maxItems: 10 })).toEqual([
      ["aaaa", "bbbb"],
      ["cccc", "dd"],
    ]);
  });

  test("respects item limit", () => {
    expect(chunkBatches([1, 2, 3], () => 1, { maxChars: 100, maxItems: 2 })).toEqual([[1, 2], [3]]);
  });

  test("an oversized item gets its own batch instead of being dropped", () => {
    expect(chunkBatches(["x", "y".repeat(50), "z"], (s) => s.length, { maxChars: 10, maxItems: 10 })).toEqual([
      ["x"],
      ["y".repeat(50)],
      ["z"],
    ]);
  });

  test("empty input gives no batches", () => {
    expect(chunkBatches([], () => 1, { maxChars: 10, maxItems: 10 })).toEqual([]);
  });
});
