import { FILLET_WELD_REJECTION_CODES, type MateTarget } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { createFilletWeldDraft, FILLET_WELD_PICK_GUIDE_KEYS, type AssemblyFilletWeldDraft } from '../assembly/filletWeldDraft.js';
import { t } from '../i18n/t.js';
import { filletWeldStatus } from './statusText.js';

function picks(count: number): readonly MateTarget[] {
  return Array.from({ length: count }, (_, index): MateTarget => ({ kind: 'subShape', componentId: `component-${String(index + 1)}`,
    ref: { bodyFeatureId: 'extrude-1', index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0],
      axis: [0, 0, 1], radius: null } } }));
}

function draft(count: number, weldId: string | null = null): AssemblyFilletWeldDraft {
  return { ...createFilletWeldDraft('doc'), weldId, picks: picks(count) };
}

describe('すみ肉溶接の打ちかけの状態欄の 1 文', () => {
  it('打ちかけでなければ何も出さず、選び終えるまでは何番目かと次に選ぶものを窓と同じ文で出す', () => {
    expect(filletWeldStatus(null, null)).toBeNull();
    FILLET_WELD_PICK_GUIDE_KEYS.forEach((key, index) => {
      const status = filletWeldStatus(draft(index), null);
      expect(status?.failed).toBe(false);
      expect(status?.text).toContain(t(key));
      expect(status?.text).toContain(`${String(index + 1)}/${String(FILLET_WELD_PICK_GUIDE_KEYS.length)}`);
    });
  });

  it('直す時は選ぶ段を飛ばし、形の計算待ちは赤くせず、欄の誤りと断る理由は赤くして窓と同じ理由を出す', () => {
    expect(filletWeldStatus(draft(0, 'weld-1'), null)).toEqual({
      text: t('assembly.status.filletWeldIssue').replace('{reason}', t('assembly.filletWeld.issue.stale')), failed: false });
    expect(filletWeldStatus(draft(3), { kind: 'issue', issue: { kind: 'value', field: 'gaps' } })?.text)
      .toContain(t('assembly.filletWeld.issue.value.gaps'));
    for (const code of FILLET_WELD_REJECTION_CODES) {
      const status = filletWeldStatus(draft(3), { kind: 'plan', result: { ok: false, rejections: [{ code, detail: {} }] } });
      expect(status, code).toEqual({ text: t('assembly.status.filletWeldIssue').replace('{reason}', t(`assembly.filletWeld.reason.${code}`)),
        failed: true });
    }
  });
});

describe('すみ肉溶接の案内の文言(直角でない当たり・細すぎる断面)', () => {
  it('道具の説明は斜めの当たりも扱うと示し、角度の断りは原因(平行に近い・脚長)と直し方(脚長を短く・別の面)を示す', () => {
    // 決め打ちの角度の範囲は無い(扱えるかは脚長による条件で決まる)ので、文に固定の角度を書かない。
    expect(t('assembly.filletWeld.toolTooltip')).toContain('斜め');
    expect(t('assembly.filletWeld.toolTooltip')).not.toMatch(/\d+°/u);
    const reason = t('assembly.filletWeld.reason.unsupportedJointAngle');
    for (const part of ['平行に近', '脚長', '短く', '選んでください']) expect(reason).toContain(part);
    expect(reason).not.toMatch(/\d+°/u);
    expect(t('assembly.filletWeld.interiorAngle')).toBe('面の間の角度(°)');
  });

  it('細すぎる断面の断りは原因(薄い・許容差)と、鋭角にも鈍角にも正しい直し方(脚長を長く・直角に近い面)を示す', () => {
    // 最小の高さ = 2 × 面積 / 最も長い辺は、内角が 0° にも 180° にも近づくと小さくなる(例 160° をさらに開くと薄くなる)。
    // 「角度を開く」は鋭角にしか当たらないので、直角に近い面の組を選ぶよう案内する。
    const reason = t('assembly.filletWeld.reason.degenerateCrossSection');
    for (const part of ['薄すぎ', '許容差', '脚長を長く', '直角に近い', '選んでください']) expect(reason).toContain(part);
    expect(reason).not.toContain('開いた');
  });
});
