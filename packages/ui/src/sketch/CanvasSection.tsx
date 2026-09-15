import { formatLength, isBaseWorkPlaneId, type BaseWorkPlaneId } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { canvasPlacementOf } from '../viewport/canvasLayer.js';

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
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionCanvas')}</h3>
      {canvases.length === 0 ? (
        <p className="pcad-panel__note">{t('propertyPanel.canvasEmpty')}</p>
      ) : (
        canvases.map((canvas) => {
          const placement = canvasPlacementOf(canvas);
          return (
            <div key={`canvas:${canvas.id}`} className="pcad-boundary">
              <dl className="pcad-properties">
                <dt className="pcad-properties__key">{t('propertyPanel.selectionSetName')}</dt>
                <dd className="pcad-properties__value">{canvas.name}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasPlane')}</dt>
                <dd className="pcad-properties__value">{canvasPlaneLabel(canvas.plane)}</dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasSize')}</dt>
                <dd className="pcad-properties__value">
                  {`${formatLength(placement.widthMm)} × ${formatLength(placement.heightMm)}`}
                </dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasCenter')}</dt>
                <dd className="pcad-properties__value">
                  {`(${formatLength(placement.centerU)}, ${formatLength(placement.centerV)})`}
                </dd>
                <dt className="pcad-properties__key">{t('propertyPanel.canvasRotation')}</dt>
                <dd className="pcad-properties__value">{`${String(placement.rotationDegrees)}°`}</dd>
              </dl>
              <div className="pcad-field">
                <span className="pcad-field__label">{t('propertyPanel.canvasOpacity')}</span>
                <input title={t('controlGuide.canvas.opacity')}
                  className="pcad-field__input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${t('propertyPanel.canvasOpacity')} ${canvas.name}`}
                  value={canvas.opacity.source}
                  onChange={(event) => {
                    // 数にならない値はストアが据え置く(NFR-RE-1。打っている途中で消さない)。
                    useAppStore.getState().setCanvasOpacity(canvas.id, Number(event.target.value));
                  }}
                />
              </div>
              <div className="pcad-appearance__actions">
                <button
                  type="button"
                  className="pcad-button"
                  aria-pressed={canvas.visible}
                  title={t('propertyPanel.canvasVisibleTooltip')}
                  onClick={() => {
                    useAppStore.getState().setCanvasVisible(canvas.id, !canvas.visible);
                  }}
                >
                  {t('propertyPanel.canvasVisible')}
                </button>
                <button
                  type="button"
                  className="pcad-button"
                  aria-pressed={scaling !== null && scaling.canvasId === canvas.id}
                  title={t('propertyPanel.canvasScaleTooltip')}
                  onClick={() => {
                    useAppStore.getState().startCanvasScale(canvas.id);
                  }}
                >
                  {t('propertyPanel.canvasScale')}
                </button>
                <button
                  type="button"
                  className="pcad-button"
                  title={t('propertyPanel.canvasRemoveTooltip')}
                  onClick={() => {
                    useAppStore.getState().removeCanvas(canvas.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
