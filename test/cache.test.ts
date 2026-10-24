import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { createIdbCache } from "../src/background/cache";

const DAY = 24 * 60 * 60 * 1000;

describe("IndexedDB cache", () => {
  test("round-trips entries and misses unknown keys", async () => {
    const cache = createIdbCache({ dbName: "t1" });
    await cache.set([
      ["a", "甲"],
      ["b", "乙"],
    ]);
    expect(await cache.get(["b", "x", "a"])).toEqual(["乙", undefined, "甲"]);
  });

  test("expired entries are ignored and pruned", async () => {
    let now = 1_000 * DAY;
    const cache = createIdbCache({ dbName: "t2", now: () => now });
    await cache.set([["a", "old"]]);
    now += 31 * DAY;
    expect(await cache.get(["a"])).toEqual([undefined]);
    await cache.prune();
    now -= 31 * DAY;
    expect(await cache.get(["a"])).toEqual([undefined]);
  });

  test("clear removes everything", async () => {
    const cache = createIdbCache({ dbName: "t3" });
    await cache.set([["a", "1"]]);
    await cache.clear();
    expect(await cache.get(["a"])).toEqual([undefined]);
  });
});
