import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const examples = [
  { path: 'packages/model/src/kernelBridge/subShapeMatching.ts',
    allowed: "import { matchFace, matchEdge, matchVertex } from '@pointercad/kernel';",
    denied: ["import { createKernelWorker } from '@pointercad/kernel';", "import * as kernel from '@pointercad/kernel';",
      "import { bridge } from '../kernelBridge.js';", "import * as Comlink from 'comlink';",
      "new Worker('worker.js');", "import('@pointercad/kernel');", "async function compute() {}"] },
  { path: 'packages/model/src/part/solidSketchReferences.ts',
    allowed: "import type { Value } from '@pointercad/expression';",
    denied: ["import { resolve } from './resolvePart.js';", "import { view } from '@pointercad/ui';"] },
  ...['solidPlanKeyGeometry.ts', 'solidPlanKeyMaterial.ts'].map(name => ({
    path: `packages/model/src/part/${name}`,
    allowed: "import type { SolidStepPlan } from './resolvePart.js';",
    denied: ["import { resolvePart } from './resolvePart.js';", "export { resolvePart } from './resolvePart.js';",
      "export * from './resolvePart.js';", "import('./resolvePart.js');", "import { create } from '@pointercad/kernel';",
      "import * as Comlink from 'comlink';", "new Worker('worker.js');", "async function resolve() {}"],
  })),
  ...readdirSync(new URL('../../../packages/model/src/kernelBridge/', import.meta.url))
    .filter(name => name.endsWith('Conversions.ts')).sort().map(name => ({
      path: `packages/model/src/kernelBridge/${name}`,
      allowed: "import type { Step } from '@pointercad/kernel';",
      denied: ["import { create } from '@pointercad/kernel';", "new Worker('worker.js');", "import { view } from '@pointercad/ui';",
        "import { bridge } from '../kernelBridge.js';", "import * as Comlink from 'comlink';", "async function request() {}"],
    })),
  { path: 'packages/ui/src/solid/solidReferenceNames.ts',
    allowed: "import { findSolid } from '@pointercad/model';",
    denied: ["import { summary } from './solidSummary.js';", "export * from './solidSummary.js';",
      "import { state } from '../app/store.js';", "import { useState } from 'react';",
      "import('./solidSummary.js');", "new Worker('worker.js');", "fetch('/');", "async function load() {}"] },
  { path: 'packages/ui/src/solid/springPropertyUpdates.ts',
    allowed: "import { deriveSpringValue } from './springExpressions.js';",
    denied: ["import { update } from './solidSummary.js';", "export * from './solidSummary.js';",
      "import { state } from '../app/store.js';", "import { useState } from 'react';",
      "import('./springExpressions.js');", "new Worker('worker.js');", "fetch('/');", "async function load() {}"] },
  { path: 'packages/ui/src/solid/holeThreadPropertyUpdates.ts',
    allowed: "import { expressionValueFromNumber } from '@pointercad/expression'; import { findMetricThread } from '@pointercad/model';",
    denied: ["import { update } from './solidSummary.js';", "export * from './solidSummary.js';",
      "import { state } from '../app/store.js';", "import { useState } from 'react';",
      "import('@pointercad/model');", "new Worker('worker.js');", "fetch('/');", "async function load() {}"] },
  { path: 'packages/ui/src/solid/chamferPropertyUpdates.ts',
    allowed: "import { expressionValueFromNumber } from '@pointercad/expression'; import { findMetricThread } from '@pointercad/model';",
    denied: ["import { update } from './solidSummary.js';", "export * from './solidSummary.js';",
      "import { state } from '../app/store.js';", "import { useState } from 'react';",
      "import('@pointercad/model');", "new Worker('worker.js');", "fetch('/');", "async function load() {}"] },
  { path: 'packages/ui/src/solid/referenceSummary.ts',
    allowed: "import type { PartDocument } from '@pointercad/model';",
    denied: ["export { summary } from './solidSummary.js';", "import { shape } from '@pointercad/kernel';"] },
  { path: 'packages/ui/src/appearance/AppearanceSection.tsx',
    allowed: "import { value } from './appearancePropertyValues.js';",
    denied: ["import { Panel } from '../shell/PropertyPanel.js';", "import { create } from '@pointercad/expression/math/worker';", "import { shape } from '@pointercad/kernel';"] },
  { path: 'packages/ui/src/appearance/appearancePropertyValues.ts',
    allowed: "import { value } from '@pointercad/model';",
    denied: ["import { state } from '../app/store.js';", "import('../shell/PropertyPanel.js');", "export * from '@pointercad/expression/math/worker';"] },
  { path: 'packages/ui/src/sketch/numericFieldUnits.ts',
    allowed: "import type { Step } from './numericInputTools.js';",
    denied: ["import { input } from './numericInput.js';", "import { shape } from '@pointercad/kernel';", "import('@pointercad/expression/math/geometry');"] },
  { path: 'packages/ui/src/sketch/numericInputPresentation.ts',
    allowed: "import { toDisplayLength } from '@pointercad/model';",
    denied: ["import { input } from './numericInput.js';", "import { state } from '../app/store.js';", "import { shape } from '@pointercad/kernel';"] },
  { path: 'packages/ui/src/sketch/numericInputTools.ts',
    allowed: "export type Tool = 'point' | 'line';",
    denied: ["import type { Step } from './numericInput.js';", "export * from '../app/store.js';", "import('@pointercad/expression/math/worker');"] },
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Use the effective, merged project settings; later overrides must not erase existing guards. */
function guardedRules(value: unknown): Linter.RulesRecord {
  if (!record(value) || !record(value.rules)) throw new Error('Missing effective ESLint rules');
  const result: Linter.RulesRecord = {};
  for (const name of ['no-restricted-imports', 'no-restricted-syntax', 'max-lines', 'max-lines-per-function', 'no-multiple-empty-lines']) {
    const setting: unknown = value.rules[name];
    if (setting === undefined) continue;
    if (!Array.isArray(setting)) throw new Error('Expected a configured boundary rule');
    const parts: readonly unknown[] = setting;
    if (parts[0] !== 2 && parts[0] !== 'error') throw new Error('The boundary rule is not enforced');
    result[name] = [2, ...parts.slice(1)];
  }
  if (!result['no-restricted-imports'] || !result['max-lines']) throw new Error('Missing layer or module size guard');
  return result;
}
const configurations = new Map<string, Linter.Config>();
beforeAll(async () => {
  const eslint = new ESLint({ cwd: root });
  for (const example of examples) {
    const effective: unknown = await eslint.calculateConfigForFile(example.path);
    configurations.set(example.path, { files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' }, rules: guardedRules(effective) });
  }
});

describe('レビューで分離した担当へ呼出元・通信・下層への直結を戻せない', () => {
  for (const example of examples) {
    it(example.path, () => {
      const config = configurations.get(example.path);
      if (!config) throw new Error('Missing the actual module configuration');
      const lint = (source: string) => new Linter().verify(source, [config], { filename: example.path });
      expect(lint(example.allowed)).toEqual([]);
      expect(lint(example.allowed+'\n\n').some(message=>message.ruleId==='no-multiple-empty-lines')).toBe(true);
      for (const source of example.denied) {
        const messages = lint(source);
        expect(messages.some(message => message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax'), source).toBe(true);
        expect(messages.some(message => message.fatal)).toBe(false);
      }
      // Newly split modules must themselves stay within the enforced responsibilities and sizes.
      expect(lint(readFileSync(new URL(example.path, new URL('../../../', import.meta.url)), 'utf8'))).toEqual([]);
    });
  }
});
