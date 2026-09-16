/** Retry a transient asset read, with a finite deadline for each complete response body. */
export async function fetchDrawingFont(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (error) {
      // Missing or malformed assets need correction, not repeated requests.
      if (attempt === 2 || (!(error instanceof TypeError) && !controller.signal.aborted)) throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, attempt === 0 ? 250 : 750));
  }
  throw new Error('Font request attempts exhausted');
}
