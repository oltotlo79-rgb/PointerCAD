/**
 * パネルと扉(E-10 第 2 段)の店の側: アセンブリを開いていない時・行を選んでいない時は扉を置かずに理由を返し、文書を変えない事。
 * 扉の寸法は model の frameDoor.test、置く流れは画面検査(frame-door.spec.ts)で確かめる。
 */
import { createAssemblyDocument, EMPTY_PART_LIBRARY } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { frameDoorPlan, frameDoorReasonText, placeFrameDoor, type FrameDoorChoices } from './frameDoorActions.js';

const NONE: FrameDoorChoices = { boardKey: null, frameKey: null, hingeKey: null, side: 'start', offset: 100, clearance: 2,
  holderKey: null, holderPitch: 300, connectorKey: null };

beforeEach(resetTestStore);

describe('枠に扉を付ける(店の側)', () => {
  it('アセンブリを開いていない時は「いまは置けない」、開いていても表示がまだ無い時も置かず、文書を変えない', () => {
    expect(frameDoorPlan(NONE)).toEqual({ ok: false, reason: 'unavailable' });
    useAppStore.getState().openAssembly(createAssemblyDocument('扉'), EMPTY_PART_LIBRARY);
    const before = useAppStore.getState().assembly;
    expect(placeFrameDoor(NONE)).toMatchObject({ ok: false });
    expect(useAppStore.getState().assembly).toBe(before);
  });

  it('理由の文字(扉の枠の内側が無い・ヒンジが収まらない・行を選んでいない)', () => {
    expect(frameDoorReasonText('noRoom')).toBe(t('catalog.frameDoor.reason.noRoom'));
    expect(frameDoorReasonText('hingeNoRoom')).toBe(t('catalog.frameDoor.reason.hingeNoRoom'));
    expect(frameDoorReasonText('noRows')).toBe(t('catalog.frameDoor.reason.noRows'));
    expect(frameDoorReasonText('holderNoRoom')).toBe(t('catalog.frameDoor.reason.holderNoRoom'));
  });
});
