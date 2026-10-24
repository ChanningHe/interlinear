export interface BatchLimits {
  readonly maxChars: number;
  readonly maxItems: number;
}

/** Splits items into consecutive batches bounded by total size and count. Order is preserved. */
export function chunkBatches<T>(items: readonly T[], size: (item: T) => number, limits: BatchLimits): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    const full = current.length >= limits.maxItems || (current.length > 0 && chars + n > limits.maxChars);
    if (full) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current = [...current, item];
    chars += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
