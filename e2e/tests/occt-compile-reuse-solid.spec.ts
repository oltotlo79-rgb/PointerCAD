import { test } from '@playwright/test';
import { assertFiveOcctPairs, browserOcctPair, type OcctPair } from './occtCompileReuseFlow.js';

for (const offline of [false, true]) {
  test.describe(`W21 actual OCCT ${offline ? 'offline' : 'online'}`, () => {
    test.describe.configure({ mode: 'serial' });
    const pairs: OcctPair[] = [];
    for (let index = 1; index <= 5; index += 1) {
      test(`cold/warm pair ${index}/5: two UI Workers and actual geometry`, async ({ playwright, browserName }, info) => {
        pairs.push(await browserOcctPair(playwright, browserName, info, offline, index));
        if (index === 5) await assertFiveOcctPairs(pairs, info);
      });
    }
  });
}
