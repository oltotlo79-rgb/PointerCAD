/**
 * パネルと扉(E-10 第 1 段)の店の側: アセンブリを開いていない・表示が無い時は「いまは置けない」、板の行を選んでいない時は「板を選ぶ」を
 * 返して何も置かない事と、理由の文字。開口の寸法そのものは model の framePanelOpening.test、置く流れは画面検査で確かめる。
 */
import { createAssemblyDocument, EMPTY_PART_LIBRARY, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { framePanelPlan, framePanelReasonText, placeFramePanel } from './framePanelActions.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure([FENCE_PANEL_FAMILY]); });
beforeEach(resetTestStore);

describe('枠にパネルをはめる(店の側)', () => {
  it('アセンブリを開いていない時は置かず、理由は「いまは置けない」', () => {
    expect(framePanelPlan(null, 0)).toEqual({ ok: false, reason: 'unavailable' });
    expect(placeFramePanel(null, 0)).toEqual({ ok: false, reason: 'unavailable' });
    expect(framePanelReasonText('unavailable')).toBe(t('catalog.framePanel.reason.unavailable'));
  });

  it('開いていても表示がまだ無い時は置かず、文書を変えない', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('枠'), EMPTY_PART_LIBRARY);
    const before = useAppStore.getState().assembly;
    expect(placeFramePanel(null, 0)).toMatchObject({ ok: false });
    expect(useAppStore.getState().assembly).toBe(before);
    expect(framePanelReasonText('noPanel')).toBe(t('catalog.framePanel.reason.noPanel'));
  });
});
