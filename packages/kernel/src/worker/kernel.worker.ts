import * as Comlink from 'comlink';

import { loadOcctForBrowser } from '../occt/loadOcct.browser.js';
import { createKernelApi } from './kernelApi.js';

// UI スレッドでは幾何演算をしない(rules/04-設計の規律.md、NFR-PF-4)。
Comlink.expose(createKernelApi(loadOcctForBrowser));
