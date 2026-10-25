import { useId, useRef, useState } from 'react';
import { expressionValueFromNumber } from '@pointercad/expression';
import { formatLength, isBaseWorkPlaneId, toDisplayLength, type BaseWorkPlaneId, type SketchCanvas } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { canvasPlacementOf } from '../viewport/canvasLayer.js';
import { initialDraftVersionState, reconcileDraftVersion } from '../shell/fieldDraft.js';
import { canvasActionState, canvasOpacityValue } from './canvasActionState.js';

function canvasLabel(key: MessageKey, name: string): string { return t(key).replace('{name}', name); }

function CanvasOpacity({ canvas }: { readonly canvas: SketchCanvas }): React.JSX.Element {
  const inputId = useId();
  const version = useAppStore(state => state.documentVersion);
  const documentId = useAppStore(state => state.activeDocumentId);
  const composing = useRef(false);
  const [draftState, setDraftState] = useState(() => initialDraftVersionState<string>(version));
  const reconciled = reconcileDraftVersion(draftState, version);
  if (reconciled !== draftState) setDraftState(reconciled);
  const source = reconciled.draft ?? canvas.opacity.source;
  const invalid = canvasOpacityValue(source) === null;
  function commit(source: string): void {
    if (composing.current) return;
    const state = useAppStore.getState();
    const value = canvasOpacityValue(source);
    if (value === null || state.activeDocumentId !== documentId || state.documentVersion !== version
      || state.document.canvases.find(item => item.id === canvas.id)?.imageId !== canvas.imageId) return;
    state.setCanvasOpacity(canvas.id, value);
    setDraftState({ draft: null, seenVersion: version });
  }
  return <div className={invalid ? 'pcad-field pcad-field--error' : 'pcad-field'}>
    <label className="pcad-field__label" htmlFor={inputId}>{t('propertyPanel.canvasOpacity')}</label>
    <input id={inputId} title={t('controlGuide.canvas.opacity')} className="pcad-field__input"
      type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
      aria-label={`${t('propertyPanel.canvasOpacity')} ${canvas.name}`} aria-invalid={invalid}
      aria-describedby={`${inputId}-reason`} value={source}
      onChange={event => { setDraftState({ draft: event.target.value, seenVersion: version }); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onBlur={event => { commit(event.currentTarget.value); }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.stopPropagation();
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (event.key === 'Escape') setDraftState({ draft: null, seenVersion: version });
        else commit(event.currentTarget.value);
      }} />
    <p id={`${inputId}-reason`} className="pcad-field__message">
      {invalid ? t('propertyPanel.canvasOpacityInvalid') : ''}
    </p>
  </div>;
}

/**
 * 下絵を貼ってある作図面の札。基準の 3 面は `ja.json` から、任意の作業平面はその id を出す。
 *
 * **同じ対応表が `StatusBar.tsx`(`planeLabel`)にもある。** あちらは作業平面の名前まで
 * 引くので入力が違い(文書の一覧が要る)、ここは下絵の行に短く出すだけなので分けてある。
 * 1 か所へまとめるならタスク45(図柄と札の整理)でまとめて行う。
 */
const CANVAS_PLANE_LABEL_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<BaseWorkPlaneId, MessageKey>;

function canvasPlaneLabel(planeId: string): string {
  return isBaseWorkPlaneId(planeId) ? t(CANVAS_PLANE_LABEL_KEYS[planeId]) : planeId;
}

/**
 * 「下絵」の節(FR-332、§2.14、タスク39・43)。
 *
 * 敷いてある下絵を並べ、**濃さ・入切・削除・寸法合わせ**を持つ。幅・高さ・中心・向きは
 * 読むだけにしてある——これらを直す口はストアに無く(2 点の寸法合わせ `applyCanvasScale`
 * がまとめて決める)、ここで文書を直に書き換えると同じ判断が 2 か所に分かれるため。
 * **どの操作でも再計算は走らない**(§2.14 の表)。
 */
export function CanvasSection(): React.JSX.Element {
  const canvases = useAppStore((state) => state.document.canvases);
  const scaling = useAppStore((state) => state.canvasScale);
  const rectifying = useAppStore((state) => state.canvasRectification);
  const documentId = useAppStore(state => state.activeDocumentId);
  const images = useAppStore(state => state.canvases);
  const loads = useAppStore(state => state.canvasImageLoads);
  const assembly = useAppStore(state => state.assembly);
  const drawing = useAppStore(state => state.drawing);
  const document = useAppStore(state => state.document);
  const unit = useAppStore(state => state.displaySettings.lengthUnit);
  const sectionId = useId();
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionCanvas')}</h3>
      {canvases.length === 0 ? (
        <p className="pcad-panel__note">{t('propertyPanel.canvasEmpty')}</p>
      ) : (
        canvases.map((canvas) => {
          const placement = canvasPlacementOf(canvas);
          const action = canvasActionState({ document, activeDocumentId: documentId, canvases: images,
            canvasImageLoads: loads, assembly, drawing }, canvas.id);
          const reasonId = `${sectionId}-${canvas.id}-reason`;
          const statusKey = action.status === 'ready' ? 'propertyPanel.canvasStatusReady'
            : action.status === 'failed' ? 'propertyPanel.canvasStatusFailed'
            : action.status === 'missing' ? 'propertyPanel.canvasStatusMissing' : 'propertyPanel.canvasStatusLoading';
          return (
            <div key={`canvas:${canvas.id}:${canvas.imageId}`} className="pcad-boundary">
              <dl className="pcad-properties">
                <dt className="pcad-properties__key">{t('propertyPanel.canvasFileName')}</dt>
                <dd className="pcad-properties__value">{canvas.name}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasStatus')}</dt>
                <dd className="pcad-properties__value" role="status">{t(statusKey)}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasPixels')}</dt>
                <dd className="pcad-properties__value">{action.status === 'ready'
                  ? t('propertyPanel.canvasPixelsValue').replace('{width}', String(action.size.width)).replace('{height}', String(action.size.height))
                  : t('propertyPanel.canvasPixelsUnknown')}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasPlane')}</dt>
                <dd className="pcad-properties__value">{canvasPlaneLabel(canvas.plane)}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasSize')}</dt>
                <dd className="pcad-properties__value">
                  {t('propertyPanel.canvasSizeValue')
                    .replace('{width}', expressionValueFromNumber(toDisplayLength(placement.widthMm, unit)).display)
                    .replace('{height}', expressionValueFromNumber(toDisplayLength(placement.heightMm, unit)).display)
                    .replace('{unit}', unit === 'inch' ? 'in' : 'mm')}
                </dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasCenter')}</dt>
                <dd className="pcad-properties__value">
                  {`(${formatLength(placement.centerU)}, ${formatLength(placement.centerV)})`}
                </dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasRotation')}</dt>
                <dd className="pcad-properties__value">{`${String(placement.rotationDegrees)}°`}</dd>
              </dl>
              <p className="pcad-panel__note">{t('propertyPanel.canvasSizeNote')}</p>
              <CanvasOpacity canvas={canvas} />
              <p id={reasonId} className="pcad-field__message">{action.reason === null ? '' : t(action.reason)}</p>
              <div className="pcad-appearance__actions">
                <button
                  type="button"
                  className="pcad-button"
                  aria-pressed={canvas.visible}
                  aria-label={canvasLabel('propertyPanel.canvasVisibleLabel', canvas.name)}
                  title={t('propertyPanel.canvasVisibleTooltip')}
                  onClick={() => {
                    const state = useAppStore.getState();
                    const current = state.document.canvases.find(item => item.id === canvas.id && item.imageId === canvas.imageId);
                    if (state.activeDocumentId === documentId && current !== undefined) state.setCanvasVisible(canvas.id, !current.visible);
                  }}
                >
                  {t('propertyPanel.canvasVisible')}
                </button>
                <button
                  type="button"
                  className="pcad-button"
                  aria-pressed={scaling !== null && scaling.canvasId === canvas.id}
                  aria-label={canvasLabel('propertyPanel.canvasScaleLabel', canvas.name)}
                  aria-describedby={reasonId}
                  disabled={action.status !== 'ready'}
                  title={t('propertyPanel.canvasScaleTooltip')}
                  onClick={() => {
                    useAppStore.getState().startCanvasScale(canvas.id, documentId, canvas.imageId);
                  }}
                >
                  {t('propertyPanel.canvasScale')}
                </button>
                <button
                  type="button"
                  className="pcad-button"
                  aria-pressed={rectifying !== null && rectifying.canvasId === canvas.id}
                  aria-label={canvasLabel('propertyPanel.canvasRectifyLabel', canvas.name)}
                  aria-describedby={reasonId}
                  disabled={action.status !== 'ready'}
                  title={t('propertyPanel.canvasRectifyTooltip')}
                  onClick={() => {
                    useAppStore.getState().startCanvasRectification(canvas.id, documentId, canvas.imageId);
                  }}
                >{t('propertyPanel.canvasRectify')}</button>
                {canvas.rectification !== undefined ? <button
                  type="button"
                  className="pcad-button"
                  title={t('propertyPanel.canvasClearRectificationTooltip')}
                  aria-label={canvasLabel('propertyPanel.canvasClearRectificationLabel', canvas.name)}
                  disabled={action.status !== 'ready'}
                  onClick={() => {
                    useAppStore.getState().clearCanvasRectification(canvas.id, documentId, canvas.imageId);
                  }}
                >{t('propertyPanel.canvasClearRectification')}</button> : null}
                <button
                  type="button"
                  className="pcad-button"
                  title={t('propertyPanel.canvasRemoveTooltip')}
                  aria-label={canvasLabel('propertyPanel.canvasRemoveLabel', canvas.name)}
                  onClick={() => {
                    const state = useAppStore.getState();
                    if (state.activeDocumentId === documentId && state.document.canvases.some(item => item.id === canvas.id && item.imageId === canvas.imageId)) {
                      state.removeCanvas(canvas.id);
                    }
                  }}
                >
                  ×
                </button>
              </div>
              {action.status === 'failed' ? <div className="pcad-appearance__actions">
                <button type="button" className="pcad-button" title={t('propertyPanel.canvasRetryTooltip')}
                  aria-label={canvasLabel('propertyPanel.canvasRetryLabel', canvas.name)} aria-describedby={reasonId}
                  onClick={() => { useAppStore.getState().retryCanvasImage(canvas.id, documentId, canvas.imageId); }}>
                  {t('propertyPanel.canvasRetry')}
                </button>
              </div> : null}
            </div>
          );
        })
      )}
    </div>
  );
}
