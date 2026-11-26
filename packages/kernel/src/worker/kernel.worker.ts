import * as Comlink from 'comlink';

import { loadOcctForBrowser } from '../occt/loadOcct.browser.js';
import { ShapeImportError } from '../occt/exchangeShared.js';
import { createKernelApi, type WorkerKernelApi } from './kernelApi.js';
import { OcctModulePort } from './occtModulePort.js';

// UI スレッドでは幾何演算をしない(rules/04-設計の規律.md、NFR-PF-4)。
const occtPort = new OcctModulePort();
self.addEventListener('message', (event) => occtPort.handleBootstrap(event));
const api = createKernelApi(() => loadOcctForBrowser(() => occtPort.getModule()));
const workerApi: WorkerKernelApi = {
  ...api,
  async importShape(request) {
    try {
      return await api.importShape(request);
    } catch (error) {
      if (error instanceof ShapeImportError) {
        return { kind: 'failed', message: error.message, diagnostic: error.diagnostic };
      }
      throw error;
    }
  },
};
Comlink.expose(workerApi);
