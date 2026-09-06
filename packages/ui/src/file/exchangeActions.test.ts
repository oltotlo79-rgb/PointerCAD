/**
 * 単位を訊く小窓の待ち合わせ(`exchangeActions.ts`、計画書 docs/plans/P6-入出力.md
 * §0.a-0.6、タスク32b)の検査。
 *
 * 対応要件: FR-802、FR-811、NFR-UX-5(2 択を「OK / キャンセル」で訊かない)。
 *
 * 画面(`ImportUnitPanel.tsx`)は押されたボタンを `answerImportUnit` へ渡すだけなので、
 * ここでは**待ち合わせ**——訊いている間は印が立ち、答えると読み込みへ値が返る——を固定する。
 */

import { describe, expect, it } from 'vitest';

import { useAppStore } from '../store/useAppStore.js';
import { answerImportUnit, createExchangeDeps } from './exchangeActions.js';

describe('単位を訊く(§0.a-0.6)', () => {
  it('訊いている間は印が立ち、答えると読み込みへ単位が返る', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    expect(useAppStore.getState().importUnitAsked).toBe(true);

    answerImportUnit('inch');
    await expect(pending).resolves.toBe('inch');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('「やめる」は null を返す(読み込みそのものが取り消しになる)', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    answerImportUnit(null);
    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('誰も待っていないときに答えても何も起きない(小窓が二重に閉じても壊れない)', () => {
    answerImportUnit('mm');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('前の問いが残ったまま次を訊いたら、前の問いは取り消しになる(答えを 2 つ待たない)', async () => {
    const first = createExchangeDeps('model').askImportUnit();
    const second = createExchangeDeps('model').askImportUnit();
    await expect(first).resolves.toBeNull();

    answerImportUnit('mm');
    await expect(second).resolves.toBe('mm');
  });
});
