import * as Comlink from 'comlink';

import { loadOcctForBrowser } from '../occt/loadOcct.browser.js';
import { createKernelApi } from './kernelApi.js';
import { OcctModulePort } from './occtModulePort.js';

// UI スレッドでは幾何演算をしない(rules/04-設計の規律.md、NFR-PF-4)。
const occtPort = new OcctModulePort();
self.addEventListener('message', (event) => occtPort.handleBootstrap(event));
Comlink.expose(createKernelApi(() => loadOcctForBrowser(() => occtPort.getModule())));
