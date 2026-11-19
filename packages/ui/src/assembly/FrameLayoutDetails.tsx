/**
 * 選ぶ窓の「線に沿って並べる」(J-01 包み 3。3D の画面で点を打つ一筆書きは E-08)。長さを持つ部材(アルミフレームの族・鋼材)の窓の中に畳んで置き、
 * 点の表(貼り付けられる 1 行に X Y Z)・閉じる・断面の向き・角の扱い・伸ばす量から予告(1 本ごとの長さと角の扱い)を出し、
 * 「並べる」で店の動作(`placeFrameMembers`)へ渡す。欄の中身と予告は `frameLayoutInput.ts` の純関数。
 */
import { useEffect, useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import type { FrameStrokeDraft } from '../store/frameStrokeActions.js';
import { useAppStore } from '../store/useAppStore.js';
import { filterFrameEdges, frameEdgeChoices, type FrameEdgeChoice, type FrameEdgeFilter } from './frameEdgeChoices.js';
import {
  frameDimensionBasisAvailable, frameEdgeText, frameLayoutView, frameRejectionText, INITIAL_FRAME_LAYOUT, toggleFrameCornerSwap,
  withPickedEdges, type FrameLayoutState,
  type FrameLayoutView, type FrameUp,
} from './frameLayoutInput.js';
import { frameMemberMiterSupported, type FrameMemberChoice } from './frameMembersPlacement.js';
import { framePointsOrNull, frameStrokeFromLayout, withStrokePoints } from './frameStroke.js';
import { AccessoryFields } from './AccessoryFields.js';
import { layoutAccessory, layoutAccessoryOptions } from './accessoryChoice.js';

const UP_CHOICES: readonly FrameUp[] = ['z', 'y', 'x'];
const CORNER_RULES: readonly FrameLayoutState['corners'][] = ['butt', 'miter', 'none'];
const TURNS: readonly number[] = [0, 1, 2, 3];
const BASES: readonly FrameLayoutState['dimensionBasis'][] = ['center', 'inner', 'outer'];
const EDGE_FILTERS: readonly FrameEdgeFilter[] = ['all', 'x', 'y', 'z', 'other'];
/** 辺がこの本数を超える時だけ、並びと向きの絞り込みを出す(統括の決定 2026-11-16)。 */
const EDGE_FILTER_THRESHOLD = 100;

/** 欄の Enter で選ぶ窓の「置く」(1 本だけ置く)が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

/** 予告: 1 本ごとの長さ・端の伸び縮みの表と、角ごとの扱い(突き当ての角は通す線を入れ替えられる)。 */
function FramePreview({ view, onSwap }: { readonly view: Extract<FrameLayoutView, { readonly kind: 'ready' }>;
  readonly onSwap: (cornerIndex: number) => void }): React.JSX.Element {
  return <>
    <p>{t('catalog.frameLayout.preview').replace('{count}', String(view.rows.length))}</p>
    <table>
      <thead><tr>{(['line', 'length', 'start', 'end'] as const).map((column) => <th key={column} scope="col">
        {t(`catalog.frameLayout.column.${column}`)}</th>)}</tr></thead>
      <tbody>{view.rows.map((row) => <tr key={row.line}>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {view.centers.length === 0 ? null : <><p>{t('catalog.frameLayout.centers')}</p>
      <ul>{view.centers.map((text) => <li key={text}>{text}</li>)}</ul></>}
    <ul>{view.corners.map((corner) => <li key={corner.index}>{corner.text}
      {corner.swappable ? <button type="button" className="pcad-button" title={t('catalog.frameLayout.swapGuide')}
        onClick={() => { onSwap(corner.index); }}>{t('catalog.frameLayout.swap')}</button> : null}</li>)}</ul>
  </>;
}

type Message = { readonly role: 'status' | 'alert'; readonly text: string } | null;

/** 点を入れる欄(貼り付けられる 1 行に X Y Z)と、閉じる。 */
function FramePointFields({ state, update }: { readonly state: FrameLayoutState;
  readonly update: (patch: Partial<FrameLayoutState>, resetSwap?: boolean) => void }): React.JSX.Element {
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.frameLayout.points')}</span>
      <textarea title={t('catalog.frameLayout.pointsGuide')} className="pcad-field__input" rows={4} value={state.pointsText}
        onChange={(event) => { update({ pointsText: event.currentTarget.value }, true); }} />
    </label>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.frameLayout.closed')}</span>
      <input type="checkbox" title={t('catalog.frameLayout.closedGuide')} checked={state.closed}
        onChange={(event) => { update({ closed: event.currentTarget.checked }, true); }} />
    </label>
  </>;
}

/**
 * 3D の画面で点を打つ(一筆書き、E-08): 打った点の数と、打ち始める・最後の点を消す・打ち直す・やめる。点の欄と閉じるは
 * 「点を入れる」と同じ欄で、数を直すと店の点の列も直す(読めない途中の文字の間は直さない)。
 */
function FrameStrokeFields({ state, stroke, update }: { readonly state: FrameLayoutState; readonly stroke: FrameStrokeDraft | null;
  readonly update: (patch: Partial<FrameLayoutState>, resetSwap?: boolean) => void }): React.JSX.Element {
  const edit = (patch: Partial<FrameLayoutState>, resetSwap?: boolean): void => {
    update(patch, resetSwap);
    const points = patch.pointsText === undefined ? null : framePointsOrNull(patch.pointsText);
    useAppStore.getState().updateFrameStroke({ ...(points === null ? {} : { points }),
      ...(patch.closed === undefined ? {} : { closed: patch.closed }) });
  };
  // やめた後に打ち始める時は、残っている点の列の続きから打つ(状態が無ければ欄の点から)。
  const begin = (): void => {
    const app = useAppStore.getState();
    if (stroke === null) app.beginFrameStroke(frameStrokeFromLayout(state), state.up);
    else app.updateFrameStroke({ active: true });
  };
  return <>
    <p aria-live="polite">{stroke?.active !== true ? t('catalog.frameLayout.stroke.idle')
      : t('catalog.frameLayout.stroke.active').replace('{count}', String(stroke.points.length))}</p>
    {stroke?.active !== true
      ? <button type="button" className="pcad-button" title={t('catalog.frameLayout.stroke.beginGuide')} onClick={begin}>
        {t('catalog.frameLayout.stroke.begin')}</button>
      : <>
        <button type="button" className="pcad-button" disabled={stroke.points.length === 0 && !stroke.closed}
          title={t('catalog.frameLayout.stroke.undoGuide')} onClick={() => { useAppStore.getState().undoFrameStrokePoint(); }}>
          {t('catalog.frameLayout.stroke.undo')}</button>
        <button type="button" className="pcad-button" disabled={stroke.points.length === 0}
          title={t('catalog.frameLayout.stroke.clearGuide')}
          onClick={() => { useAppStore.getState().updateFrameStroke({ points: [], closed: false }); }}>
          {t('catalog.frameLayout.stroke.clear')}</button>
        <button type="button" className="pcad-button" title={t('catalog.frameLayout.stroke.endGuide')}
          onClick={() => { useAppStore.getState().pauseFrameStroke(); }}>{t('catalog.frameLayout.stroke.end')}</button>
      </>}
    <FramePointFields state={state} update={edit} />
  </>;
}

/**
 * 寸法の基準(配置の補助 P-B): 打った点が芯・内側の面・外側の面のどれの角か。内側・外側は閉じた点の形の時だけ選べる(閉じていない時は
 * 選べない理由を出す)。辺から選ぶ形では出さない(辺は部品の実際の辺なので芯だけ)。
 */
function FrameBasisField({ state, update }: { readonly state: FrameLayoutState;
  readonly update: (patch: Partial<FrameLayoutState>, resetSwap?: boolean) => void }): React.JSX.Element {
  const available = frameDimensionBasisAvailable(state);
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.frameLayout.basis')}</span>
      <select title={t('catalog.frameLayout.basisGuide')} className="pcad-field__input" value={state.dimensionBasis}
        onChange={(event) => { update({ dimensionBasis: BASES.find((item) => item === event.currentTarget.value) ?? 'center' }, true); }}>
        {BASES.map((item) => <option key={item} value={item} disabled={item !== 'center' && !available}>
          {t(`catalog.frameLayout.basis.${item}`)}</option>)}
      </select>
    </label>
    {available ? null : <p>{t('catalog.frameLayout.basisUnavailable')}</p>}
  </>;
}

/** 読み込んだ辺の一覧に、3D の画面で押して足した辺(B-10)を重ねる(同じ対象の id は読み込んだ方を使う)。 */
function withAddedEdges(state: FrameLayoutState, added: readonly FrameEdgeChoice[]): FrameLayoutState {
  const fresh = added.filter((edge) => !state.edges.some((loaded) => loaded.targetId === edge.targetId));
  return fresh.length === 0 ? state : { ...state, edges: [...state.edges, ...fresh] };
}

/** 線の決め方の欄の値を読む(知らない値は点を入れる)。 */
const lineSourceOf = (value: string): FrameLayoutState['source'] => value === 'edges' || value === 'stroke' ? value : 'points';

/**
 * 選んだ部品(選択が部品 1 つの時)のまっすぐな辺を読み込み、店の「辺を選ぶ途中」を始める(3D の画面で辺をクリックしても選べる)。
 * 読めない時は理由。
 */
function loadEdges(state: FrameLayoutState): { readonly state: FrameLayoutState; readonly name: string } | string {
  const app = useAppStore.getState();
  const id = app.selection.length === 1 ? app.selection[0] : undefined;
  const component = id === undefined ? undefined : app.assembly?.components.find((candidate) => candidate.id === id);
  const edges = component === undefined || app.assembly === null || app.assemblyView === null ? null
    : frameEdgeChoices(app.assembly, app.assemblyView, component.id);
  if (component === undefined || edges === null) return t('catalog.frameLayout.error.noComponent');
  if (edges.length === 0) return t('catalog.frameLayout.error.noEdges');
  app.beginFrameEdgePick(component.id, edges.map((edge) => edge.targetId));
  return { state: { ...state, edges, checkedEdges: [], swapThrough: [] }, name: component.name };
}

/**
 * 辺の一覧(チェックで選ぶ。3D の画面で辺をクリックしても同じチェックが入れ替わる。行に乗せるとビューでその辺を強調し、
 * チェックした辺は選択として強調する)。100 本を超える時は並びと向きで絞る。チェックは店の「辺を選ぶ途中」が持つ。
 */
function FrameEdgeFields({ state, onState, onMessage }: { readonly state: FrameLayoutState;
  readonly onState: (next: FrameLayoutState) => void; readonly onMessage: (message: Message) => void }): React.JSX.Element {
  const [loadedName, setLoadedName] = useState('');
  const notice = useAppStore((app) => app.frameEdgePick?.notice ?? null);
  const shown = filterFrameEdges(state.edges, state.edgeOrder, state.edgeFilter);
  return <>
    <button type="button" className="pcad-button" title={t('catalog.frameLayout.loadEdgesGuide')} onClick={() => {
      const loaded = loadEdges(state);
      if (typeof loaded === 'string') { onMessage({ role: 'alert', text: loaded }); return; }
      setLoadedName(loaded.name); onState(loaded.state);
    }}>{t('catalog.frameLayout.loadEdges')}</button>
    {state.edges.length === 0 ? <p>{t('catalog.frameLayout.edgesDirectHint')}</p>
      : <p>{loadedName === '' ? t('catalog.frameLayout.edgesPicked').replace('{count}', String(state.edges.length))
        : t('catalog.frameLayout.edgesLoaded').replace('{name}', loadedName).replace('{count}', String(state.edges.length))}
        {' '}{t('catalog.frameLayout.edgesPickHint')}</p>}
    {notice === 'notStraight' ? <p role="alert">{t('catalog.frameLayout.error.notStraight')}</p> : null}
    {state.edges.length <= EDGE_FILTER_THRESHOLD ? null : <FrameEdgeFilters state={state} onState={onState} />}
    <ul>{shown.map((edge) => <li key={edge.targetId}>
      <label title={t('catalog.frameLayout.edgeGuide')} onMouseEnter={() => { useAppStore.getState().setHovered(edge.targetId); }}
        onMouseLeave={() => { useAppStore.getState().setHovered(null); }}>
        <input type="checkbox" checked={state.checkedEdges.includes(edge.targetId)}
          onChange={() => { useAppStore.getState().toggleFrameEdgePick(edge.targetId); }} />
        {frameEdgeText(edge)}
      </label>
    </li>)}</ul>
  </>;
}

/** 辺の並び(辺の順・長い順)と向き(すべて・X・Y・Z・斜め)。 */
function FrameEdgeFilters({ state, onState }: { readonly state: FrameLayoutState; readonly onState: (next: FrameLayoutState) => void }):
React.JSX.Element {
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.frameLayout.edgeOrder')}</span>
      <select title={t('catalog.frameLayout.edgeOrderGuide')} className="pcad-field__input" value={state.edgeOrder}
        onChange={(event) => { onState({ ...state, edgeOrder: event.currentTarget.value === 'length' ? 'length' : 'number' }); }}>
        <option value="number">{t('catalog.frameLayout.edgeOrder.number')}</option>
        <option value="length">{t('catalog.frameLayout.edgeOrder.length')}</option>
      </select>
    </label>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.frameLayout.edgeFilter')}</span>
      <select title={t('catalog.frameLayout.edgeFilterGuide')} className="pcad-field__input" value={state.edgeFilter}
        onChange={(event) => { onState({ ...state, edgeFilter: EDGE_FILTERS.find((item) => item === event.currentTarget.value) ?? 'all' }); }}>
        {EDGE_FILTERS.map((item) => <option key={item} value={item}>
          {t(item === 'all' ? 'catalog.frameLayout.edgeFilter.all' : `catalog.frameLayout.direction.${item}`)}</option>)}
      </select>
    </label>
  </>;
}

export function FrameLayoutDetails({ member }: { readonly member: FrameMemberChoice }): React.JSX.Element {
  const [local, setState] = useState<FrameLayoutState>(INITIAL_FRAME_LAYOUT);
  const [message, setMessage] = useState<Message>(null);
  const pick = useAppStore((app) => app.frameEdgePick);
  // 安全柵の欄が持つ点は読まない(同じ窓の 2 つの欄が取り合わないため。E-12 第 2 段)。
  const stroke = useAppStore((app) => app.frameStroke?.owner === 'layout' ? app.frameStroke : null);
  // 窓を閉じた(この欄が消えた)時は、辺を選ぶ途中と点を打つ途中をやめる。
  useEffect(() => () => { const app = useAppStore.getState(); app.endFrameEdgePick(); app.endFrameStroke(); }, []);
  // 3D の画面で打った点は、点の欄の文字に入れて見せる(同じ点の列を表している文字はそのまま。欄を直すと店の点の列も直す)。
  // 辺から選ぶ形では、読み込んだ辺に 3D の画面で押して足した辺を重ねた一覧で読む(B-10)。
  const state = local.source === 'edges' ? withPickedEdges(withAddedEdges(local, pick?.added ?? []), pick?.checked ?? [])
    : local.source === 'stroke' && stroke !== null ? withStrokePoints(local, stroke) : local;
  const view = frameLayoutView(state, member);
  // 点・閉じる・角の扱いを変えると角の並びが変わるので、入れ替えは初めに戻す。辺から以外に替えたら辺を選ぶ途中をやめ、
  // 3D で点を打つ形に替えたら、点の欄の点から打ち始める(ほかに替えたらやめる)。
  const update = (patch: Partial<FrameLayoutState>, resetSwap = false): void => {
    const app = useAppStore.getState();
    if (patch.source !== undefined && patch.source !== 'edges') app.endFrameEdgePick();
    // 辺から選ぶ形にしたら、読み込まずに空で始める(3D の画面で辺を押すと、その部品の辺が一覧に入る。B-10)。
    if (patch.source === 'edges' && app.frameEdgePick === null) app.beginFrameEdgePick(null, []);
    if (patch.source !== undefined && patch.source !== 'stroke') app.endFrameStroke();
    if (patch.source === 'stroke') app.beginFrameStroke(frameStrokeFromLayout(state), state.up);
    if (patch.up !== undefined) app.updateFrameStroke({ up: patch.up });
    setState({ ...state, ...patch, ...(resetSwap ? { swapThrough: [] } : {}) });
    setMessage(null);
  };
  const place = (): void => {
    if (view.kind !== 'ready') return;
    const placed = useAppStore.getState().placeFrameMembers({ ...view.request, accessory: layoutAccessory(member) });
    // 一筆書きは、置いたら点の列を空にして、続けて次の線を打てるようにする(置いた物は元に戻す 1 回で消える)。
    if (placed.ok && state.source === 'stroke') useAppStore.getState().updateFrameStroke({ points: [], closed: false });
    setMessage(placed.ok ? { role: 'status', text: t('catalog.frameLayout.placed').replace('{count}', String(placed.componentIds.length)) }
      : { role: 'alert', text: frameRejectionText(placed) });
  };
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.frameLayout.title')}</summary>
      <p>{t('catalog.frameLayout.hint')}</p>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.frameLayout.source')}</span>
        <select title={t('catalog.frameLayout.sourceGuide')} className="pcad-field__input" value={state.source}
          onChange={(event) => { update({ source: lineSourceOf(event.currentTarget.value) }, true); }}>
          <option value="points">{t('catalog.frameLayout.source.points')}</option>
          <option value="edges">{t('catalog.frameLayout.source.edges')}</option>
          <option value="stroke">{t('catalog.frameLayout.source.stroke')}</option>
        </select>
      </label>
      {state.source === 'points' ? <FramePointFields state={state} update={update} />
        : state.source === 'stroke' ? <FrameStrokeFields state={state} stroke={stroke} update={update} />
          : <FrameEdgeFields state={state} onState={(next) => { setState(next); setMessage(null); }} onMessage={setMessage} />}
      {state.source === 'edges' ? null : <FrameBasisField state={state} update={update} />}
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.frameLayout.up')}</span>
        <select title={t('catalog.frameLayout.upGuide')} className="pcad-field__input" value={state.up}
          onChange={(event) => { update({ up: UP_CHOICES.find((item) => item === event.currentTarget.value) ?? 'z' }); }}>
          {UP_CHOICES.map((item) => <option key={item} value={item}>{`+${item.toUpperCase()}`}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.frameLayout.turn')}</span>
        <select title={t('catalog.frameLayout.turnGuide')} className="pcad-field__input" value={String(state.quarterTurns)}
          onChange={(event) => { update({ quarterTurns: Number(event.currentTarget.value) }); }}>
          {TURNS.map((turn) => <option key={turn} value={String(turn)}>{`${String(turn * 90)}°`}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.frameLayout.corners')}</span>
        <select title={t('catalog.frameLayout.cornersGuide')} className="pcad-field__input" value={state.corners}
          onChange={(event) => { update({ corners: CORNER_RULES.find((rule) => rule === event.currentTarget.value) ?? 'butt' }, true); }}>
          <option value="butt">{t('catalog.frameLayout.corners.butt')}</option>
          {/* 留めは留めの欄を持つ部材だけ(アルミフレームの族と鋼材)。 */}
          <option value="miter" disabled={!frameMemberMiterSupported(member)}>{t('catalog.frameLayout.corners.miter')}</option>
          <option value="none">{t('catalog.frameLayout.corners.none')}</option>
        </select>
      </label>
      {(['startExtension', 'endExtension'] as const).map((key) => <label key={key} className="pcad-field">
        <span className="pcad-field__label">{t(`catalog.frameLayout.${key}`)}</span>
        <input title={t('catalog.frameLayout.extensionGuide')} className="pcad-field__input" value={state[key]} onKeyDown={keepEnter}
          onChange={(event) => {
            const value = event.currentTarget.value;
            update(key === 'startExtension' ? { startExtension: value } : { endExtension: value });
          }} />
        <span className="pcad-field__unit">mm</span>
      </label>)}
      <AccessoryFields options={layoutAccessoryOptions(member)} lengthMm={null} showEnds={false} />
      {view.kind === 'error' ? <p className="pcad-field__message" role="alert">{view.message}</p> : null}
      {view.kind !== 'ready' ? null : <FramePreview view={view}
        onSwap={(index) => { setState(toggleFrameCornerSwap(state, index)); setMessage(null); }} />}
      <button type="button" className="pcad-button pcad-button--action" disabled={view.kind !== 'ready'}
        title={t('catalog.frameLayout.placeGuide')} onClick={place}>{t('catalog.frameLayout.place')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
