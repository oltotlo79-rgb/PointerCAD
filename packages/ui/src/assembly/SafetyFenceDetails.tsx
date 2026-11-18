/**
 * 選ぶ窓の「安全柵を作る」(E-12)。床の平面の線と高さ・柱の間隔の上限・横の材・パネル・足を入れ、柱(この窓で選んでいる行)・
 * 横の材・パネル・足を 1 回で置く。欄の中身と予告は safetyFenceInput.ts、置く動作は safetyFencePlacement.ts。
 * 第 2 段: 床の線は 3D の画面で点を打っても入れられる(E-08 の点を打つ状態を、持ち主「安全柵」で使う)。置いた後は、柵の部材の接続のうち
 * 留めていない数を出す(接合チェックの関数を読むだけ)。
 * 柵の部材を並べるだけで、安全の規格への適合は確かめない(その事を窓に出す。統括の決定 2026-11-18 15:2x)。
 */
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import type { FrameStrokeDraft } from '../store/frameStrokeActions.js';
import { useAppStore } from '../store/useAppStore.js';
import { runFrameJointCheck } from './frameJointCheckView.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';
import {
  FENCE_FOOT_FAMILIES, FENCE_PANEL_FAMILY, fencePointsOrNull, INITIAL_SAFETY_FENCE, safetyFenceView, withFenceStroke, type SafetyFenceState,
} from './safetyFenceInput.js';
import { placeSafetyFence } from './safetyFencePlacement.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

type TextKey = 'height' | 'spacing' | 'railHeights' | 'panelGap';
const TEXT_FIELDS: readonly { readonly key: TextKey; readonly label: MessageKey; readonly guide: MessageKey }[] = [
  { key: 'height', label: 'catalog.fence.height', guide: 'catalog.fence.heightGuide' },
  { key: 'spacing', label: 'catalog.fence.spacing', guide: 'catalog.fence.spacingGuide' },
  { key: 'railHeights', label: 'catalog.fence.railHeights', guide: 'catalog.fence.railHeightsGuide' },
  { key: 'panelGap', label: 'catalog.fence.panelGap', guide: 'catalog.fence.panelGapGuide' },
];
const textPatch = (key: TextKey, value: string): Partial<SafetyFenceState> => key === 'height' ? { height: value }
  : key === 'spacing' ? { spacing: value } : key === 'railHeights' ? { railHeights: value } : { panelGap: value };
/** 遅れて読む族(パネルの板・足の板・アジャスター)。 */
const LAZY_FAMILIES = [FENCE_PANEL_FAMILY, FENCE_FOOT_FAMILIES.base, FENCE_FOOT_FAMILIES.adjuster];
const FOOT_KINDS: readonly SafetyFenceState['footKind'][] = ['none', 'base', 'adjuster'];

/** 3D の画面で点を打つ(①): 打ち始める・最後の点を消す・打つのをやめる。打った点は床の線の点の欄に入る。 */
function FenceStrokeFields({ state, stroke }: { readonly state: SafetyFenceState; readonly stroke: FrameStrokeDraft | null }): React.JSX.Element {
  const begin = (): void => {
    const app = useAppStore.getState();
    if (stroke !== null) { app.updateFrameStroke({ active: true }, 'fence'); return; }
    const points = fencePointsOrNull(state.pointsText) ?? [];
    app.beginFrameStroke({ points, closed: state.closed && points.length >= 3 }, 'z', 'fence');
  };
  return stroke?.active !== true
    ? <button type="button" className="pcad-button" title={t('catalog.fence.strokeGuide')} onClick={begin}>{t('catalog.fence.stroke')}</button>
    : <>
      <p aria-live="polite">{t('catalog.fence.strokeActive').replace('{count}', String(stroke.points.length))}</p>
      <button type="button" className="pcad-button" disabled={stroke.points.length === 0 && !stroke.closed}
        title={t('catalog.frameLayout.stroke.undoGuide')}
        onClick={() => { useAppStore.getState().undoFrameStrokePoint(); }}>{t('catalog.frameLayout.stroke.undo')}</button>
      <button type="button" className="pcad-button" title={t('catalog.frameLayout.stroke.endGuide')}
        onClick={() => { useAppStore.getState().pauseFrameStroke(); }}>
        {t('catalog.frameLayout.stroke.end')}</button>
    </>;
}

/** 足(②): 種類・行・アジャスターの時の床から柱の下端までの高さ。 */
function FenceFootFields({ state, ready, update }: { readonly state: SafetyFenceState; readonly ready: boolean;
  readonly update: (patch: Partial<SafetyFenceState>) => void }): React.JSX.Element {
  const rows = !ready || state.footKind === 'none' ? [] : PRODUCT_CATALOG_REGISTRY.loaded(FENCE_FOOT_FAMILIES[state.footKind])?.rows ?? [];
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.fence.foot')}</span>
      <select title={t('catalog.fence.footGuide')} className="pcad-field__input" value={state.footKind}
        onChange={(event) => { update({ footKind: FOOT_KINDS.find((kind) => kind === event.currentTarget.value) ?? 'none', footItemKey: null }); }}>
        {FOOT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`catalog.fence.foot.${kind}`)}</option>)}
      </select>
    </label>
    {state.footKind === 'none' ? null : <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.fence.footRow')}</span>
      <select title={t('catalog.fence.footRowGuide')} className="pcad-field__input" value={state.footItemKey ?? ''}
        onChange={(event) => { update({ footItemKey: event.currentTarget.value === '' ? null : event.currentTarget.value }); }}>
        <option value="">{t('catalog.fence.footRowNone')}</option>
        {rows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
      </select>
    </label>}
    {state.footKind === 'adjuster' ? <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.fence.footHeight')}</span>
      <input title={t('catalog.fence.footHeightGuide')} className="pcad-field__input" value={state.footHeight} onKeyDown={keepEnter}
        onChange={(event) => { update({ footHeight: event.currentTarget.value }); }} />
      <span className="pcad-field__unit">mm</span>
    </label> : null}
  </>;
}

/** 区画ごとの指定(第 3 段): 全体と同じ・パネル無し・出入口(横の材もパネルも無し)・別の板の行。 */
function FenceBayFields({ bays, state, rows, update }: { readonly bays: number; readonly state: SafetyFenceState;
  readonly rows: readonly { readonly key: string; readonly size: string }[]; readonly update: (patch: Partial<SafetyFenceState>) => void }):
  React.JSX.Element {
  const set = (bay: number, value: string): void => {
    const next = Object.fromEntries(Object.entries(state.bayOverrides).filter(([key]) => key !== String(bay)));
    update({ bayOverrides: value === '' ? next : { ...next, [String(bay)]: value } });
  };
  return <details>
    <summary>{t('catalog.fence.bays')}</summary>
    {Array.from({ length: bays }, (_, bay) => <label key={bay} className="pcad-field">
      <span className="pcad-field__label">{t('catalog.fence.bay').replace('{n}', String(bay + 1))}</span>
      <select title={t('catalog.fence.bayGuide')} className="pcad-field__input" value={state.bayOverrides[String(bay)] ?? ''}
        onChange={(event) => { set(bay, event.currentTarget.value); }}>
        <option value="">{t('catalog.fence.bay.same')}</option>
        <option value="none">{t('catalog.fence.bay.none')}</option>
        <option value="open">{t('catalog.fence.bay.open')}</option>
        {rows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
      </select>
    </label>)}
  </details>;
}

export function SafetyFenceDetails({ member }: { readonly member: FrameMemberChoice }): React.JSX.Element {
  const [local, setState] = useState<SafetyFenceState>(INITIAL_SAFETY_FENCE);
  const [message, setMessage] = useState<{ readonly role: 'status' | 'alert'; readonly text: string } | null>(null);
  const [placedIds, setPlacedIds] = useState<readonly string[] | null>(null);
  const [ready, setReady] = useState(LAZY_FAMILIES.every((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined));
  const stroke = useAppStore((app) => app.frameStroke?.owner === 'fence' ? app.frameStroke : null);
  const assembly = useAppStore((app) => app.assembly);
  const assemblyView = useAppStore((app) => app.assemblyView);
  // パネルの板・足の族は、この欄を初めて出した時に読み込む(行の一覧を選ぶ欄に出す)。窓を閉じたら、柵の点を打つのをやめる。
  useEffect(() => {
    if (ready) return;
    let live = true;
    void PRODUCT_CATALOG_REGISTRY.ensure(LAZY_FAMILIES).then(() => { if (live) setReady(true); }, () => {});
    return () => { live = false; };
  }, [ready]);
  useEffect(() => () => { useAppStore.getState().endFrameStroke('fence'); }, []);
  // 打った点は床の線の点の欄に重ねて見せる(同じ点の列を表す文字はそのまま)。
  const state = stroke === null ? local : withFenceStroke(local, stroke);
  const view = safetyFenceView(state, member);
  // 置いた後、表示が新しくなったら、柵の部材の接続のうち留めていない数(④)。
  const unfastened = useMemo(() => {
    if (placedIds === null || assembly === null || assemblyView?.sourceDocument !== assembly) return null;
    const checked = runFrameJointCheck(assembly, assemblyView, false, () => globalThis.performance.now());
    if (!checked.result.ok) return null;
    const ids = new Set(placedIds);
    return checked.result.statuses.filter((status) => status.fastening === 'none' || status.fastening === 'oneSided')
      .filter((status) => status.joint.members.some((entry) => ids.has(entry.componentId))).length;
  }, [placedIds, assembly, assemblyView]);
  const railRows = member.kind === 'catalogItem' ? PRODUCT_CATALOG_REGISTRY.loaded(member.familyId)?.rows ?? [] : [];
  const panelRows = ready ? PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY)?.rows ?? [] : [];
  const update = (patch: Partial<SafetyFenceState>): void => {
    // 区画の並びが変わる欄(点・閉じる・間隔・板)を替えたら、区画ごとの指定は初めに戻す(第 3 段)。
    const reshaped = ['pointsText', 'closed', 'spacing', 'panelItemKey'].some((key) => key in patch);
    setState({ ...state, ...patch, ...(reshaped ? { bayOverrides: {} } : {}) });
    setMessage(null);
    // 打っている点の列も、欄の直しに合わせる(読めない途中の文字の間は直さない)。
    const points = patch.pointsText === undefined ? null : fencePointsOrNull(patch.pointsText);
    useAppStore.getState().updateFrameStroke({ ...(points === null ? {} : { points }),
      ...(patch.closed === undefined ? {} : { closed: patch.closed }) }, 'fence');
  };
  const place = (): void => {
    if (view.kind !== 'ready') return;
    const placed = placeSafetyFence(view.request);
    if (placed.ok) {
      setPlacedIds(placed.componentIds);
      useAppStore.getState().updateFrameStroke({ points: [], closed: false }, 'fence');
    }
    setMessage(placed.ok ? { role: 'status', text: t('catalog.fence.placed').replace('{count}', String(placed.componentIds.length)) }
      : { role: 'alert', text: t(placed.reason === 'unavailable' ? 'catalog.fence.error.unavailable' : 'catalog.fence.error.invalidOption') });
  };
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.fence.title')}</summary>
      <p>{t('catalog.fence.hint')}</p>
      <p role="note">{t('catalog.fence.notice')}</p>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.fence.points')}</span>
        <textarea title={t('catalog.fence.pointsGuide')} className="pcad-field__input" rows={4} value={state.pointsText}
          onChange={(event) => { update({ pointsText: event.currentTarget.value }); }} />
      </label>
      <FenceStrokeFields state={state} stroke={stroke} />
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.fence.closed')}</span>
        <input type="checkbox" title={t('catalog.fence.closedGuide')} checked={state.closed}
          onChange={(event) => { update({ closed: event.currentTarget.checked }); }} />
      </label>
      {TEXT_FIELDS.map((field) => <label key={field.key} className="pcad-field">
        <span className="pcad-field__label">{t(field.label)}</span>
        <input title={t(field.guide)} className="pcad-field__input" value={state[field.key]} onKeyDown={keepEnter}
          onChange={(event) => { update(textPatch(field.key, event.currentTarget.value)); }} />
        <span className="pcad-field__unit">mm</span>
      </label>)}
      {member.kind === 'catalogItem' ? <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.fence.rail')}</span>
        <select title={t('catalog.fence.railGuide')} className="pcad-field__input" value={state.railItemKey ?? ''}
          onChange={(event) => { update({ railItemKey: event.currentTarget.value === '' ? null : event.currentTarget.value }); }}>
          <option value="">{t('catalog.fence.railSameAsPost')}</option>
          {railRows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
        </select>
      </label> : null}
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.fence.panel')}</span>
        <select title={t('catalog.fence.panelGuide')} className="pcad-field__input" value={state.panelItemKey ?? ''}
          onChange={(event) => { update({ panelItemKey: event.currentTarget.value === '' ? null : event.currentTarget.value }); }}>
          <option value="">{t('catalog.fence.panelNone')}</option>
          {panelRows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
        </select>
      </label>
      <FenceFootFields state={state} ready={ready} update={update} />
      {view.kind === 'ready' ? <FenceBayFields bays={view.request.plan.bays} state={state} rows={panelRows} update={update} /> : null}
      {view.kind === 'error' ? <p className="pcad-field__message" role="alert">{view.message}</p> : null}
      {view.kind === 'ready' ? <p>{view.summary}</p> : null}
      <button type="button" className="pcad-button pcad-button--action" disabled={view.kind !== 'ready'}
        title={t('catalog.fence.placeGuide')} onClick={place}>{t('catalog.fence.place')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
      {unfastened === null ? null : <p>{t('catalog.fence.check').replace('{count}', String(unfastened))}</p>}
    </details>
  );
}
