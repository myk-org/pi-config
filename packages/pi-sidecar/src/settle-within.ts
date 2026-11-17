/**
 * Await `work`, but never longer than `timeoutMs`. Shutdown uses this for
 * `server.close()` (#1019): an open SSE feed holds its socket, so the close
 * would otherwise wait out the whole drain timeout instead of returning as
 * soon as the feeds are closed. `onTimeout` force-drops what is left.
 *
 * Returns true when `work` settled on its own, false when the timeout won.
 */
export async function settlesWithin(
  work: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
