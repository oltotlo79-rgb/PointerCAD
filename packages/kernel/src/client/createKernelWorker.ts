/**
 * 幾何カーネルの Worker を起動する。
 * new Worker(new URL(...), { type: 'module' }) はこの字面のままでバンドラが解釈するため、
 * 変数へ切り出したり文字列を組み立てたりしてはいけない。
 */
export function createKernelWorker(): Worker {
  return new Worker(new URL('../worker/kernel.worker.js', import.meta.url), {
    type: 'module',
    name: 'pointercad-kernel',
  });
}
