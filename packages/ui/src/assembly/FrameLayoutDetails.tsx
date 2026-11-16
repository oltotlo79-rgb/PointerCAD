/**
 * 選ぶ窓の「線に沿って並べる」(J-01 包み 3)。長さを持つ部材(アルミフレームの族・鋼材)の窓の中に畳んで置き、
 * 点の表(貼り付けられる 1 行に X Y Z)・閉じる・断面の向き・角の扱い・伸ばす量から予告(1 本ごとの長さと角の扱い)を出し、
 * 「並べる」で店の動作(`placeFrameMembers`)へ渡す。欄の中身と予告は `frameLayoutInput.ts` の純関数。
 */
import { useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { filterFrameEdges, frameEdgeChoices, type FrameEdgeFilter } from './frameEdgeChoices.js';
import {
  frameEdgeText, frameLayoutView, frameRejectionText, INITIAL_FRAME_LAYOUT, toggleFrameCornerSwap, toggleFrameEdge, type FrameLayoutState,
  type FrameLayoutView, type FrameUp,
} from './frameLayoutInput.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';

const UP_CHOICES: readonly FrameUp[] = ['z', 'y', 'x'];
const TURNS: readonly number[] = [0, 1, 2, 3];
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

/** 選んだ部品(選択が部品 1 つの時)のまっすぐな辺を読み込む。読めない時は理由。 */
function loadEdges(state: FrameLayoutState): { readonly state: FrameLayoutState; readonly name: string } | string {
  const app = useAppStore.getState();
  const id = app.selection.length === 1 ? app.selection[0] : undefined;
  const component = id === undefined ? undefined : app.assembly?.components.find((candidate) => candidate.id === id);
  const edges = component === undefined || app.assembly === null || app.assemblyView === null ? null
    : frameEdgeChoices(app.assembly, app.assemblyView, component.id);
  if (component === undefined || edges === null) return t('catalog.frameLayout.error.noComponent');
  if (edges.length === 0) return t('catalog.frameLayout.error.noEdges');
  return { state: { ...state, edges, checkedEdges: [], swapThrough: [] }, name: component.name };
}

/** 辺の一覧(チェックで選ぶ。行に乗せるとビューでその辺を強調し、チェックした辺は選択として強調する)。100 本を超える時は並びと向きで絞る。 */
function FrameEdgeFields({ state, onState, onMessage }: { readonly state: FrameLayoutState;
  readonly onState: (next: FrameLayoutState) => void; readonly onMessage: (message: Message) => void }): React.JSX.Element {
  const [loadedName, setLoadedName] = useState('');
  const shown = filterFrameEdges(state.edges, state.edgeOrder, state.edgeFilter);
  const toggle = (targetId: string): void => {
    const next = toggleFrameEdge(state, targetId);
    onState(next);
    useAppStore.getState().setSelection(next.checkedEdges);
  };
  return <>
    <button type="button" className="pcad-button" title={t('catalog.frameLayout.loadEdgesGuide')} onClick={() => {
      const loaded = loadEdges(state);
      if (typeof loaded === 'string') { onMessage({ role: 'alert', text: loaded }); return; }
      setLoadedName(loaded.name); onState(loaded.state);
    }}>{t('catalog.frameLayout.loadEdges')}</button>
    {state.edges.length === 0 ? null : <p>{t('catalog.frameLayout.edgesLoaded').replace('{name}', loadedName)
      .replace('{count}', String(state.edges.length))}</p>}
    {state.edges.length <= EDGE_FILTER_THRESHOLD ? null : <FrameEdgeFilters state={state} onState={onState} />}
    <ul>{shown.map((edge) => <li key={edge.targetId}>
      <label title={t('catalog.frameLayout.edgeGuide')} onMouseEnter={() => { useAppStore.getState().setHovered(edge.targetId); }}
        onMouseLeave={() => { useAppStore.getState().setHovered(null); }}>
        <input type="checkbox" checked={state.checkedEdges.includes(edge.targetId)} onChange={() => { toggle(edge.targetId); }} />
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
  const [state, setState] = useState<FrameLayoutState>(INITIAL_FRAME_LAYOUT);
  const [message, setMessage] = useState<Message>(null);
  const view = frameLayoutView(state, member);
  // 点・閉じる・角の扱いを変えると角の並びが変わるので、入れ替えは初めに戻す。
  const update = (patch: Partial<FrameLayoutState>, resetSwap = false): void => {
    setState({ ...state, ...patch, ...(resetSwap ? { swapThrough: [] } : {}) });
    setMessage(null);
  };
  const place = (): void => {
    if (view.kind !== 'ready') return;
    const placed = useAppStore.getState().placeFrameMembers(view.request);
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
          onChange={(event) => { update({ source: event.currentTarget.value === 'edges' ? 'edges' : 'points' }, true); }}>
          <option value="points">{t('catalog.frameLayout.source.points')}</option>
          <option value="edges">{t('catalog.frameLayout.source.edges')}</option>
        </select>
      </label>
      {state.source === 'points' ? <FramePointFields state={state} update={update} />
        : <FrameEdgeFields state={state} onState={(next) => { setState(next); setMessage(null); }} onMessage={setMessage} />}
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
          onChange={(event) => { update({ corners: event.currentTarget.value === 'none' ? 'none' : 'butt' }, true); }}>
          <option value="butt">{t('catalog.frameLayout.corners.butt')}</option>
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
      {view.kind === 'error' ? <p className="pcad-field__message" role="alert">{view.message}</p> : null}
      {view.kind !== 'ready' ? null : <FramePreview view={view}
        onSwap={(index) => { setState(toggleFrameCornerSwap(state, index)); setMessage(null); }} />}
      <button type="button" className="pcad-button pcad-button--action" disabled={view.kind !== 'ready'}
        title={t('catalog.frameLayout.placeGuide')} onClick={place}>{t('catalog.frameLayout.place')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
