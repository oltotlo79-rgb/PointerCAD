import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { functionPointFlow } from './functionPointFlow.js';
import { functionCurvePointFlow } from './functionCurvePointFlow.js';
import { functionSurfacePointFlow } from './functionSurfacePointFlow.js';

interface DirectionScenario {
  readonly name: string;
  readonly run: (page: Page, info: TestInfo, app?: ElectronApplication) => Promise<void>;
}

/** Each case starts empty and creates its own curve/surface and point through the UI.
 * Point editing and direction editing keep independent 180-second test budgets.
 * All equations, XYZ bounds, tolerances, reopen operations and Undo assertions remain.
 */
export const FUNCTION_DIRECTION_SCENARIOS: readonly DirectionScenario[] = [
  { name: '座標式曲面', run: (page, info, app) => functionPointFlow(page, info, app, 'coordinate', 'direction') },
  { name: '空間等式曲面', run: (page, info, app) => functionPointFlow(page, info, app, 'implicit', 'direction') },
  { name: '媒介曲面', run: (page, info, app) => functionSurfacePointFlow(page, info, app, 'direction') },
  { name: '座標式曲線', run: (page, info, app) => functionCurvePointFlow(page, info, 'coordinate', app, 'direction') },
  { name: '媒介曲線', run: (page, info, app) => functionCurvePointFlow(page, info, 'parametric', app, 'direction') },
];
