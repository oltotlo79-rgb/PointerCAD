import { beforeAll, describe, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { runMachiningRoundtrip } from './cylindricalMachiningRoundtrip.testSupport.js';

beforeAll(async () => { await loadOcctForNode(); }, 180_000);

describe('EX-05.PERSIST: counterbores and threads regenerate after JSON and PCAD ZIP reload', () => {
  for (const transformation of ['rigid', 'mirrorYZ', 'scaleThread'] as const) {
    it.each(['counterbore', 'simplified', 'modeled'] as const)(`${transformation}: %s`, async (kind) => {
      await runMachiningRoundtrip(transformation, kind);
    }, 180_000);
  }
});
