import { attachOcctModuleBroker, closeOcctModuleBroker } from './occtModuleBroker.js';

/**
 * 幾何カーネルの Worker を起動する。
 * new Worker(new URL(...), { type: 'module' }) はこの字面のままでバンドラが解釈するため、
 * 変数へ切り出したり文字列を組み立てたりしてはいけない。
 */
export function createKernelWorker(): Worker {
  const worker = new Worker(new URL('../worker/kernel.worker.js', import.meta.url), {
    type: 'module',
    name: 'pointercad-kernel',
  });
  attachOcctModuleBroker(worker);
  const terminate = worker.terminate.bind(worker);
  worker.terminate = (): void => {
    closeOcctModuleBroker(worker);
    terminate();
  };
  return worker;
}
