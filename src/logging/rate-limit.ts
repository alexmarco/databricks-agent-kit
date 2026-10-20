/**
 * Returns a function that calls `emit` at most once per `intervalMs`. The first call emits right away with `0`; calls
 * inside the interval are counted and the next emission after it reports how many were suppressed.
 */
export function createRateLimitedLogger(
  emit: (suppressed: number) => void,
  intervalMs: number,
  now: () => number,
): () => void {
  let lastEmission: number | undefined;
  let suppressed = 0;
  return () => {
    const current = now();
    if (lastEmission !== undefined && current - lastEmission < intervalMs) {
      suppressed += 1;
      return;
    }
    lastEmission = current;
    const count = suppressed;
    suppressed = 0;
    emit(count);
  };
}
