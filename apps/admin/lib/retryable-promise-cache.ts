export function createRetryablePromiseCache<T>() {
  let pending: Promise<T> | undefined;
  return {
    get(factory: () => Promise<T>): Promise<T> {
      if (!pending) {
        const next = factory();
        pending = next;
        next.catch(() => {
          if (pending === next) pending = undefined;
        });
      }
      return pending;
    },
  };
}
