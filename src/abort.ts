/** Settles like `promise`, or rejects as soon as `signal` aborts (the work itself keeps running unobserved). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((settle, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(settle, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
