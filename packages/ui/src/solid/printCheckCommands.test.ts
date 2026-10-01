/**
 * 3D プリントの点検を 1 回頼む判断(`printCheckCommands.ts`、FR-815、P6 タスク46)の検査。
 *
 * カーネルは起こさず、`PartInspector` の偽物で「何を頼むか」「断りをどう出すか」だけを
 * 確かめる(`measureCommands.test.ts` と同じ流儀)。実カーネルとの往復は model の
 * `part/importedShapeKernel.test.ts` が箱 1 個で確かめている。
 */

import { createEmptyPartDocument, createOffsetCache, createProjectionCache, createSubShapeCache, type PartDocument } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import {
  printCheckTargets,
  createPartInspector,
  DEFAULT_PRINT_CHECK_DRAFT,
  evaluatePrintCheckDraft,
  runPrintCheck,
  type PartInspector,
  type PrintCheckBody,
  type PartInspectorDeps,
} from './printCheckCommands.js';
import type { FieldUnits } from '../shell/propertyFieldUnits.js';

const DOCUMENT: PartDocument = createEmptyPartDocument();

function bodyOf(featureId: string, triangleCount: number): PrintCheckBody {
  return { featureId, mesh: { triangleCount } };
}

/** 三角形 `count` 枚ぶんの、中身を見ない偽の結果。 */
function inspected(count: number): PartInspector {
  return () =>
    Promise.resolve({
      kind: 'inspected',
      report: {
        triangleCount: count,
        thinTriangles: new Uint8Array(Math.ceil(count / 8)),
        overhangTriangles: new Uint8Array(Math.ceil(count / 8)),
        openEdgeTriangles: new Uint8Array(Math.ceil(count / 8)),
        summary: {
          triangleCount: count,
          degenerateCount: 0,
          inspectedTriangleCount: count,
          thinCount: 0,
          overhangCount: 0,
          openEdgeCount: 0,
          openEdgeTriangleCount: 0,
          watertight: true,
          minThicknessFoundMm: 20,
          minThicknessMm: 0.8,
          overhangAngleDeg: 45,
          cellSizeMm: 1.6,
        },
        cancelled: false,
      },
    });
}

describe('点検する立体を決める(FR-815)', () => {
  const BODIES = [bodyOf('box-1', 12), bodyOf('box-2', 8), bodyOf('box-3', 6)];

  it('何も選んでいなければ全部を点検する(押しても何も起きない、を避ける)', () => {
    expect(printCheckTargets(BODIES, []).map((body) => body.featureId)).toEqual([
      'box-1',
      'box-2',
      'box-3',
    ]);
  });

  it('立体を選んでいればその立体だけ。並びは選んだ順ではなく一覧の順', () => {
    expect(printCheckTargets(BODIES, ['box-3', 'box-1']).map((body) => body.featureId)).toEqual([
      'box-1',
      'box-3',
    ]);
  });

  it('立体でないものだけを選んでいるときは全部を点検する', () => {
    // 面・辺・点やスケッチの要素の id は立体の id と重ならない(§0.a-0.8)。
    expect(printCheckTargets(BODIES, ['box-1#face:2']).map((body) => body.featureId)).toEqual([
      'box-1',
      'box-2',
      'box-3',
    ]);
  });

  it('立体が 1 つも無ければ空', () => {
    expect(printCheckTargets([], ['box-1'])).toEqual([]);
  });
});

describe('FIX-02 print criteria input and forwarding', () => {
  const units: FieldUnits = { variables: new Map(), exactVariables: new Map(), nonLengthVariables: new Set(),
    pendingVariables: new Set(), lengthUnit: 'mm' };
  it('starts at 0.8 mm / 45 degrees and evaluates both expressions', () => {
    expect(evaluatePrintCheckDraft(DEFAULT_PRINT_CHECK_DRAFT, units).criteria).toEqual({ minThicknessMm: 0.8, overhangAngleDeg: 45 });
    expect(evaluatePrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: '1/2', overhangAngleSource: '30+30' }, units).criteria)
      .toEqual({ minThicknessMm: 0.5, overhangAngleDeg: 60 });
  });
  it('retains the original length unit while the display changes', () => {
    const inch = { ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessUnit: 'inch' as const, minThicknessSource: '1/2' };
    expect(evaluatePrintCheckDraft(inch, units).criteria?.minThicknessMm).toBeCloseTo(12.7, 12);
    expect(evaluatePrintCheckDraft(DEFAULT_PRINT_CHECK_DRAFT, { ...units, lengthUnit: 'inch' }).criteria?.minThicknessMm).toBe(0.8);
    expect(evaluatePrintCheckDraft({ ...inch, minThicknessSource: '0.8mm' }, units).criteria?.minThicknessMm).toBe(0.8);
  });
  it.each(['0', '-1', '-1/2', 'Infinity', '1/0', '', 'unknown_name', '1+'])('rejects thickness %s with a field reason', source => {
    const result = evaluatePrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: source }, units);
    expect(result.criteria).toBeNull();
    expect(result.thicknessError).toBeTruthy();
    expect(result.angleError).toBeNull();
  });
  it.each(['-1', '90+1', 'Infinity', '1/0', '', 'unknown_name'])('rejects angle %s with a field reason', source => {
    const result = evaluatePrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, overhangAngleSource: source }, units);
    expect(result.criteria).toBeNull();
    expect(result.angleError).toBeTruthy();
    expect(result.thicknessError).toBeNull();
  });
  it.each(['0', '90'])('accepts the angle boundary %s', source => {
    expect(evaluatePrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, overhangAngleSource: source }, units).criteria?.overhangAngleDeg).toBe(Number(source));
  });
  it('does not use the stale value of a pending geometry parameter', () => {
    const result = evaluatePrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: 'wall' },
      { ...units, variables: new Map([['wall', 2]]), pendingVariables: new Set(['wall']) });
    expect(result.criteria).toBeNull();
    expect(result.thicknessPending).toBe(true);
  });
  it('forwards numeric criteria and cancellation through the application inspector to the bridge', async () => {
    const inspectPrintability = vi.fn<PartInspectorDeps['inspectPrintability']>(() => inspected(12)(DOCUMENT, ['box-1']));
    const inspector = createPartInspector({ offsets: createOffsetCache(), projections: createProjectionCache(),
      subShapes: createSubShapeCache(), inspectPrintability });
    const shouldCancel = (): boolean => false;
    const criteria = { minThicknessMm: 1.2, overhangAngleDeg: 60 };
    const result = await runPrintCheck({ document: DOCUMENT, bodies: [bodyOf('box-1', 12)], selection: [], inspector, shouldCancel, criteria });
    expect(result.ok).toBe(true);
    expect(inspectPrintability).toHaveBeenCalledExactlyOnceWith([], { bodies: ['box-1'], shouldCancel, ...criteria });
  });
  it.each([{ minThicknessMm: 0, overhangAngleDeg: 45 }, { minThicknessMm: 0.8, overhangAngleDeg: 91 },
    { minThicknessMm: Infinity, overhangAngleDeg: 45 }, { minThicknessMm: 0.8, overhangAngleDeg: NaN }])('refuses invalid numeric criteria before calling the inspector: %j', async criteria => {
    const inspector = vi.fn<PartInspector>(inspected(12));
    const outcome = await runPrintCheck({ document: DOCUMENT, bodies: [bodyOf('box-1', 12)], selection: [], inspector, criteria });
    expect(outcome.ok).toBe(false);
    expect(inspector).not.toHaveBeenCalled();
  });
  it('reports a rejected inspection rather than leaving an unhandled promise', async () => {
    const inspector: PartInspector = () => Promise.reject(new Error('worker unavailable'));
    await expect(runPrintCheck({ document: DOCUMENT, bodies: [bodyOf('box-1', 12)], selection: [], inspector }))
      .resolves.toEqual({ ok: false, message: t('propertyPanel.printCheckFailed') });
  });
});

describe('点検を 1 回走らせる(FR-815)', () => {
  it('立体が 1 つも無ければカーネルを呼ばずに断る(NFR-UX-5)', async () => {
    const inspector = vi.fn<PartInspector>(inspected(12));
    const outcome = await runPrintCheck({
      document: DOCUMENT,
      bodies: [],
      selection: [],
      inspector,
    });

    expect(outcome).toEqual({ ok: false, message: t('printCheck.noBody') });
    expect(inspector).not.toHaveBeenCalled();
  });

  it('点検の口が差し出されていなければ理由つきで断る', async () => {
    const outcome = await runPrintCheck({
      document: DOCUMENT,
      bodies: [bodyOf('box-1', 12)],
      selection: [],
      inspector: null,
    });

    expect(outcome).toEqual({ ok: false, message: t('printCheck.unavailable') });
  });

  it('頼んだ順に立体ごとの先頭の三角形の番号を作る(色を塗る相手)', async () => {
    const inspector = vi.fn<PartInspector>(inspected(20));
    const outcome = await runPrintCheck({
      document: DOCUMENT,
      bodies: [bodyOf('box-1', 12), bodyOf('box-2', 8)],
      selection: [],
      inspector,
    });

    // 第 3 引数は中止の口。この検査は渡していないので undefined。
    expect(inspector).toHaveBeenCalledWith(DOCUMENT, ['box-1', 'box-2'], undefined);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.offsets.get('box-1')).toBe(0);
    expect(outcome.offsets.get('box-2')).toBe(12);
    expect(outcome.report.triangleCount).toBe(20);
  });

  it('カーネルの断りはそのまま持ち回る(文言の正本を 2 か所に書かない)', async () => {
    const inspector: PartInspector = () =>
      Promise.resolve({ kind: 'failed', message: '点検できる形がありません。' });
    const outcome = await runPrintCheck({
      document: DOCUMENT,
      bodies: [bodyOf('box-1', 12)],
      selection: [],
      inspector,
    });

    expect(outcome).toEqual({ ok: false, message: '点検できる形がありません。' });
  });
});
