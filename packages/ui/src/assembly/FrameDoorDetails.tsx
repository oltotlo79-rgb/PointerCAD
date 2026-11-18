/**
 * 選ぶ窓の「選んだ枠に扉を付ける」(E-10 第 2 段)。ビューか木で枠の部材 4 本を選び、板・扉の枠・ヒンジの行と、ヒンジを付ける側・位置・隙間を
 * 選ぶと、扉の寸法を予告し、扉の枠 4 本・板・ヒンジ 2 つを 1 回で置く(元に戻す 1 回で戻る)。流れは frameDoorActions.ts。
 * 第 3 段: 板の押さえ(行と間隔)・平たいつなぎ(行)は、行を選んだ時だけ一緒に置く。扉の部品は互いに固定した組にまとめる(開閉のジョイントは作らない)。
 */
import { evaluateExpression } from '@pointercad/expression';
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { useEffect, useState, type KeyboardEvent } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  DOOR_CONNECTOR_PREFIX, DOOR_FAMILIES, DOOR_HINGE_PREFIX, DOOR_HOLDER_PREFIX, frameDoorPlan, frameDoorReasonText, placeFrameDoor,
  type FrameDoorChoices,
} from './frameDoorActions.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };
const FAMILIES = [FENCE_PANEL_FAMILY, DOOR_FAMILIES.frame, DOOR_FAMILIES.hinge];
const SIDES: readonly FrameDoorChoices['side'][] = ['start', 'end'];

/** 族の行を選ぶ欄(行の鍵の頭で絞れる)。 */
function RowSelect({ label, guide, familyId, prefix, ready, value, onChange, none = 'catalog.framePanel.panelNone' }: {
  readonly label: MessageKey; readonly guide: MessageKey; readonly familyId: string; readonly prefix?: string; readonly ready: boolean;
  readonly value: string | null; readonly onChange: (key: string | null) => void; readonly none?: MessageKey }): React.JSX.Element {
  const rows = (ready ? PRODUCT_CATALOG_REGISTRY.loaded(familyId)?.rows ?? [] : []).filter((row) => prefix === undefined || row.key.startsWith(prefix));
  return <label className="pcad-field">
    <span className="pcad-field__label">{t(label)}</span>
    <select title={t(guide)} className="pcad-field__input" value={value ?? ''}
      onChange={(event) => { onChange(event.currentTarget.value === '' ? null : event.currentTarget.value); }}>
      <option value="">{t(none)}</option>
      {rows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
    </select>
  </label>;
}

export function FrameDoorDetails(): React.JSX.Element {
  const [keys, setKeys] = useState<Pick<FrameDoorChoices, 'boardKey' | 'frameKey' | 'hingeKey' | 'side' | 'holderKey' | 'connectorKey'>>(
    { boardKey: null, frameKey: null, hingeKey: null, side: 'start', holderKey: null, connectorKey: null });
  const [offsetText, setOffsetText] = useState('100');
  // 板の押さえの間隔の初めの値(資料に決まりが無いので規格の値ではない。説明に書く)。
  const [pitchText, setPitchText] = useState('300');
  const [clearanceText, setClearanceText] = useState('2');
  const [message, setMessage] = useState<{ readonly role: 'status' | 'alert'; readonly text: string } | null>(null);
  const [ready, setReady] = useState(FAMILIES.every((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined));
  // 予告は、選択・文書・表示が変わるたびに作り直す。
  useAppStore((state) => state.selection);
  useAppStore((state) => state.assemblyView);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void PRODUCT_CATALOG_REGISTRY.ensure(FAMILIES).then(() => { if (live) setReady(true); }, () => {});
    return () => { live = false; };
  }, [ready]);
  const offset = evaluateExpression(offsetText), clearance = evaluateExpression(clearanceText), pitch = evaluateExpression(pitchText);
  // 間隔は押さえを置く時だけ要る(読めない時は model が「数が正でない」で断る)。
  const choices: FrameDoorChoices | null = offset.ok && clearance.ok ? { ...keys, offset: offset.value.value, clearance: clearance.value.value,
    holderPitch: pitch.ok ? pitch.value.value : Number.NaN } : null;
  const planned = choices === null ? { ok: false as const, reason: 'invalidNumber' } : frameDoorPlan(choices);
  const update = (patch: Partial<typeof keys>): void => { setKeys({ ...keys, ...patch }); setMessage(null); };
  const place = (): void => {
    if (choices === null) return;
    const placed = placeFrameDoor(choices);
    setMessage(placed.ok ? { role: 'status', text: t('catalog.frameDoor.placed').replace('{count}', String(placed.componentIds.length)) }
      : { role: 'alert', text: frameDoorReasonText(placed.reason) });
  };
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.frameDoor.title')}</summary>
      <p>{t('catalog.frameDoor.hint')}</p>
      <p>{t('catalog.frameDoor.groupNote')}</p>
      <RowSelect label="catalog.frameDoor.board" guide="catalog.frameDoor.boardGuide" familyId={FENCE_PANEL_FAMILY} ready={ready}
        value={keys.boardKey} onChange={(key) => { update({ boardKey: key }); }} />
      <RowSelect label="catalog.frameDoor.frame" guide="catalog.frameDoor.frameGuide" familyId={DOOR_FAMILIES.frame} ready={ready}
        value={keys.frameKey} onChange={(key) => { update({ frameKey: key }); }} />
      <RowSelect label="catalog.frameDoor.hinge" guide="catalog.frameDoor.hingeGuide" familyId={DOOR_FAMILIES.hinge} prefix={DOOR_HINGE_PREFIX}
        ready={ready} value={keys.hingeKey} onChange={(key) => { update({ hingeKey: key }); }} />
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.frameDoor.side')}</span>
        <select title={t('catalog.frameDoor.sideGuide')} className="pcad-field__input" value={keys.side}
          onChange={(event) => { update({ side: SIDES.find((side) => side === event.currentTarget.value) ?? 'start' }); }}>
          {SIDES.map((side) => <option key={side} value={side}>{t(`catalog.frameDoor.side.${side}`)}</option>)}
        </select>
      </label>
      <RowSelect label="catalog.frameDoor.holder" guide="catalog.frameDoor.holderGuide" familyId={DOOR_FAMILIES.hinge} prefix={DOOR_HOLDER_PREFIX}
        ready={ready} value={keys.holderKey} none="catalog.frameDoor.none" onChange={(key) => { update({ holderKey: key }); }} />
      <RowSelect label="catalog.frameDoor.connector" guide="catalog.frameDoor.connectorGuide" familyId={DOOR_FAMILIES.hinge}
        prefix={DOOR_CONNECTOR_PREFIX} ready={ready} value={keys.connectorKey} none="catalog.frameDoor.none"
        onChange={(key) => { update({ connectorKey: key }); }} />
      {([['catalog.frameDoor.offset', 'catalog.frameDoor.offsetGuide', offsetText, setOffsetText],
        ['catalog.frameDoor.clearance', 'catalog.frameDoor.clearanceGuide', clearanceText, setClearanceText],
        ['catalog.frameDoor.pitch', 'catalog.frameDoor.pitchGuide', pitchText, setPitchText]] as const).map(([label, guide, value, set]) =>
        <label key={label} className="pcad-field">
          <span className="pcad-field__label">{t(label)}</span>
          <input title={t(guide)} className="pcad-field__input" value={value} onKeyDown={keepEnter}
            onChange={(event) => { set(event.currentTarget.value); setMessage(null); }} />
          <span className="pcad-field__unit">mm</span>
        </label>)}
      {planned.ok ? <p>{t('catalog.frameDoor.preview').replace('{width}', String(planned.plan.outer.width))
        .replace('{height}', String(planned.plan.outer.height)).replace('{boardWidth}', String(planned.plan.board.width))
        .replace('{boardHeight}', String(planned.plan.board.height))}
        {planned.plan.holders.length + planned.plan.connectors.length === 0 ? null : t('catalog.frameDoor.previewParts')
          .replace('{holders}', String(planned.plan.holders.length)).replace('{connectors}', String(planned.plan.connectors.length))}</p>
        : <p className="pcad-field__message">{frameDoorReasonText(planned.reason)}</p>}
      <button type="button" className="pcad-button pcad-button--action" disabled={!planned.ok} title={t('catalog.frameDoor.placeGuide')}
        onClick={place}>{t('catalog.frameDoor.place')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
