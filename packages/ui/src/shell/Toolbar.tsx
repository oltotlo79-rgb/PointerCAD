import type { WorkPlaneId } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import {
  createNumericInput,
  type NumericInputStep,
  type SketchToolId,
} from '../sketch/numericInput.js';
import type { SnapKind } from '../sketch/snapMath.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  ArcToolIcon,
  ChainIcon,
  CubeIcon,
  CursorIcon,
  FaceToolIcon,
  GridIcon,
  HomeIcon,
  LineToolIcon,
  OrthographicIcon,
  PerspectiveIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  ShadedIcon,
  ShadedWithEdgesIcon,
  SnapIcon,
  WireframeIcon,
  type IconProps,
} from './icons.js';

/** スケッチの道具(FR-301〜309)。並びがそのまま画面の左からの順になる。 */
const TOOLS = [
  {
    id: 'select',
    labelKey: 'toolbar.tool.select',
    tooltipKey: 'toolbar.tool.selectTooltip',
    Icon: CursorIcon,
  },
  {
    id: 'point',
    labelKey: 'toolbar.tool.point',
    tooltipKey: 'toolbar.tool.pointTooltip',
    Icon: PlotPointIcon,
  },
  {
    id: 'line',
    labelKey: 'toolbar.tool.line',
    tooltipKey: 'toolbar.tool.lineTooltip',
    Icon: LineToolIcon,
  },
  {
    id: 'arc',
    labelKey: 'toolbar.tool.arc',
    tooltipKey: 'toolbar.tool.arcTooltip',
    Icon: ArcToolIcon,
  },
  {
    id: 'pointArray',
    labelKey: 'toolbar.tool.pointArray',
    tooltipKey: 'toolbar.tool.pointArrayTooltip',
    Icon: PointArrayToolIcon,
  },
  {
    id: 'face',
    labelKey: 'toolbar.tool.face',
    tooltipKey: 'toolbar.tool.faceTooltip',
    Icon: FaceToolIcon,
  },
] as const satisfies readonly {
  readonly id: SketchToolId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: (props: IconProps) => React.JSX.Element;
}[];

/** 作図面(要件§4.3、§0.a-0.3)。既定は XY。 */
const PLANES = [
  { id: 'xy', labelKey: 'toolbar.plane.xy', tooltipKey: 'toolbar.plane.xyTooltip' },
  { id: 'xz', labelKey: 'toolbar.plane.xz', tooltipKey: 'toolbar.plane.xzTooltip' },
  { id: 'yz', labelKey: 'toolbar.plane.yz', tooltipKey: 'toolbar.plane.yzTooltip' },
] as const satisfies readonly {
  readonly id: WorkPlaneId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/** 吸着の種別(FR-107、§0.a-0.10)。畳まずに並べて、いま何が効くかを一目で分かるようにする。 */
const SNAP_KINDS_UI = [
  {
    kind: 'endpoint',
    labelKey: 'toolbar.snap.endpoint',
    tooltipKey: 'toolbar.snap.endpointTooltip',
  },
  {
    kind: 'intersection',
    labelKey: 'toolbar.snap.intersection',
    tooltipKey: 'toolbar.snap.intersectionTooltip',
  },
  {
    kind: 'midpoint',
    labelKey: 'toolbar.snap.midpoint',
    tooltipKey: 'toolbar.snap.midpointTooltip',
  },
  { kind: 'center', labelKey: 'toolbar.snap.center', tooltipKey: 'toolbar.snap.centerTooltip' },
  { kind: 'grid', labelKey: 'toolbar.snap.grid', tooltipKey: 'toolbar.snap.gridTooltip' },
] as const satisfies readonly {
  readonly kind: SnapKind;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/**
 * 道具を選んだ直後に開く入力の段階(§2.9「出るきっかけ①ツールを選ぶ→すぐ出る」)。
 * 選択と面は数値ではなくクリックで進めるので開かない。
 */
const INITIAL_STEPS = {
  select: null,
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  face: null,
} as const satisfies Record<SketchToolId, NumericInputStep | null>;

/** ビューポートの大きさがまだ分からないときに使う基準位置(画素)。 */
const FALLBACK_ANCHOR_PIXELS = 160;

/**
 * ポップアップを出す基準の画面座標(§2.9「表示位置」)。
 *
 * 道具を選んだ直後はまだどこもクリックしていないので、ビューポートのほぼ中央を基準にする。
 * 大きさは `AppShell` が実寸を入れたストアから読む(DOM を直接探しに行かない、
 * rules/04-設計の規律.md)。はみ出しの折り返しはポップアップ側(`clampAnchor`)が行う。
 */
function viewportCenterAnchor(): readonly [number, number] {
  const [width, height] = useAppStore.getState().viewportSize;
  if (width <= 0 || height <= 0) {
    return [FALLBACK_ANCHOR_PIXELS, FALLBACK_ANCHOR_PIXELS];
  }
  return [Math.round(width / 2), Math.round(height / 2)];
}

/**
 * 道具のボタンを押したときの処理。
 *
 * 同じ道具をもう一度押したら解除して選択へ戻す(取りかけの操作を残さない、NFR-UX-3)。
 * 数値で位置を決める道具は、選んだ時点で入力欄を開く(NFR-UX-1)。
 */
function activateTool(id: SketchToolId, pressed: boolean): void {
  const store = useAppStore.getState();
  const next: SketchToolId = pressed && id !== 'select' ? 'select' : id;
  // 道具を変えると入力中のポップアップは閉じるので、開き直すのはこの後。
  store.setActiveTool(next);
  const step = INITIAL_STEPS[next];
  if (step !== null) {
    store.openNumericInput(createNumericInput(next, step), viewportCenterAnchor());
    return;
  }
  // 選択と面はクリックとキーで進める道具。押した直後の焦点はボタンに残るので、
  // ビューポートへ戻してもらう。そうしないと面を選んだ直後の Enter が効かない(NFR-UX-4)。
  store.requestViewportFocus();
}

/**
 * 画面上端のツールバー(要件§7.1)。
 *
 * 左から「製品名 → モードのタブ → スケッチ → 作図面」、右へ「投影 / 表示 / 補助 / 吸着 / 視点」
 * の機能グループを並べる。どのグループも区画名を頭に置き、いま選ばれているものを
 * アクセント色の面で示す(NFR-UX-7)。状態の正本は Zustand ストア1本(rules/04-設計の規律.md)。
 */
export function Toolbar(): React.JSX.Element {
  const projection = useAppStore((state) => state.projection);
  const displayStyle = useAppStore((state) => state.displayStyle);
  const showGrid = useAppStore((state) => state.showGrid);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapKinds = useAppStore((state) => state.snapKinds);
  const chaining = useAppStore((state) => state.chaining);

  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>

      {/* モードのタブ。今はモデリングだけが使える。 */}
      <nav className="pcad-toolbar__modes" aria-label={t('toolbar.mode.groupLabel')}>
        <button type="button" className="pcad-tab" aria-pressed={true}>
          {t('toolbar.mode.modeling')}
        </button>
        <button
          type="button"
          className="pcad-tab"
          aria-disabled={true}
          title={t('toolbar.mode.comingSoon')}
        >
          {t('toolbar.mode.assembly')}
        </button>
        <button
          type="button"
          className="pcad-tab"
          aria-disabled={true}
          title={t('toolbar.mode.comingSoon')}
        >
          {t('toolbar.mode.drawing')}
        </button>
      </nav>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.sketch.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.sketch.tooltip')}>
          {t('toolbar.sketch.groupLabel')}
        </span>
        <div className="pcad-segmented">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateTool(tool.id, activeTool === tool.id);
              }}
            >
              <tool.Icon />
              {t(tool.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.plane.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.plane.tooltip')}>
          {t('toolbar.plane.groupLabel')}
        </span>
        <div className="pcad-segmented">
          {PLANES.map((plane) => (
            <button
              key={plane.id}
              type="button"
              className="pcad-button"
              title={t(plane.tooltipKey)}
              aria-pressed={workPlaneId === plane.id}
              onClick={() => {
                useAppStore.getState().setWorkPlane(plane.id);
              }}
            >
              {t(plane.labelKey)}
            </button>
          ))}
          {/*
            いま見ている向きに最も近い作図面へ移る(§0.a-0.3)。視点の正本はビューポートの
            中にあるので、ここでは要求を数えるだけにしてビューポートに応えてもらう。
          */}
          <button
            type="button"
            className="pcad-button pcad-button--compact"
            title={t('toolbar.plane.matchViewTooltip')}
            onClick={() => {
              useAppStore.getState().requestMatchWorkPlaneToView();
            }}
          >
            {t('toolbar.plane.matchView')}
          </button>
        </div>
      </div>

      <span className="pcad-toolbar__spacer" />

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.projection.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.projection.tooltip')}>
          {t('toolbar.projection.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.projection.perspective')}
            aria-pressed={projection === 'perspective'}
            onClick={() => {
              useAppStore.getState().setProjection('perspective');
            }}
          >
            <PerspectiveIcon />
            {t('toolbar.projection.perspectiveShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.projection.orthographic')}
            aria-pressed={projection === 'orthographic'}
            onClick={() => {
              useAppStore.getState().setProjection('orthographic');
            }}
          >
            <OrthographicIcon />
            {t('toolbar.projection.orthographicShort')}
          </button>
        </div>
      </div>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.displayStyle.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.displayStyle.tooltip')}>
          {t('toolbar.displayStyle.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.shaded')}
            aria-pressed={displayStyle === 'shaded'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shaded');
            }}
          >
            <ShadedIcon />
            {t('toolbar.displayStyle.shadedShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.shadedWithEdges')}
            aria-pressed={displayStyle === 'shadedWithEdges'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shadedWithEdges');
            }}
          >
            <ShadedWithEdgesIcon />
            {t('toolbar.displayStyle.shadedWithEdgesShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.wireframe')}
            aria-pressed={displayStyle === 'wireframe'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('wireframe');
            }}
          >
            <WireframeIcon />
            {t('toolbar.displayStyle.wireframeShort')}
          </button>
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.support.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.support.tooltip')}>
          {t('toolbar.support.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.grid.tooltip')}
            aria-pressed={showGrid}
            onClick={() => {
              useAppStore.getState().setShowGrid(!showGrid);
            }}
          >
            <GridIcon />
            {t('toolbar.grid.label')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.chain.tooltip')}
            aria-pressed={chaining}
            onClick={() => {
              useAppStore.getState().setChaining(!chaining);
            }}
          >
            <ChainIcon />
            {t('toolbar.chain.label')}
          </button>
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.snap.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.snap.tooltip')}>
          {t('toolbar.snap.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.snap.tooltip')}
            aria-pressed={snapEnabled}
            onClick={() => {
              useAppStore.getState().setSnapEnabled(!snapEnabled);
            }}
          >
            <SnapIcon />
            {t('toolbar.snap.label')}
          </button>
          {SNAP_KINDS_UI.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="pcad-button pcad-button--compact"
              title={t(entry.tooltipKey)}
              aria-pressed={snapKinds.includes(entry.kind)}
              aria-disabled={!snapEnabled}
              onClick={() => {
                // 吸着が切のときは押しても何も起きない(NFR-UX-5「実行前に分かる」)。
                if (snapEnabled) {
                  useAppStore.getState().toggleSnapKind(entry.kind);
                }
              }}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.view.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.view.tooltip')}>
          {t('toolbar.view.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--action"
            title={t('toolbar.home.tooltip')}
            onClick={() => {
              useAppStore.getState().requestHomeView();
            }}
          >
            <HomeIcon />
            {t('toolbar.home.shortLabel')}
          </button>
        </div>
      </div>
    </header>
  );
}
