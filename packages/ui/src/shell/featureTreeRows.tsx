/**
 * モデルブラウザの行を描く責務(FR-501、FR-503、FR-504、FR-507)。
 *
 * 履歴の行、スケッチ 1 本の親行、フォルダの中身、名前の欄、「⋮」のボタンを描く。描くだけで状態は
 * 持たない: 入力の一時状態は `useFeatureTreeInput.ts`、ストアの更新は `featureTreeCommands.ts` が持ち、
 * ここは押された・乗せられたことを両者へつなぐ。React のコンポーネントではなく要素を返す関数にして
 * あるのは、親の `FeatureTree` が返す要素の木(行の `li` まで)を分ける前と同じに保つため。
 */
import type { Dispatch, SetStateAction } from 'react';
import {
  featureFolderMemberKey,
  featureNoteOf,
  type FeatureNoteTarget,
  type PartDocument,
  type ReferenceFeatureKind,
  type SolidLabelKey,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import type { SketchTreeKind } from '../sketch/featureSummary.js';
import type { SketchTreeGroup, TreeRow, TreeSection, TreeSectionKey } from '../solid/solidSummary.js';
import { noteTargetForRow, removeTreeRow, selectRowForMenu, selectTreeRow, switchSketch,
  type RowMenuSection } from './featureTreeCommands.js';
import {
  AlertIcon, ArcToolIcon, BoxIcon, ChamferIcon, ChevronRightIcon, CircularArrayToolIcon, CircularPatternIcon, ConeIcon,
  CoordinateSystemIcon, CopyToolIcon, CutIcon, CylinderIcon, DraftIcon, EllipseToolIcon, EmbossIcon, ExtrudeIcon,
  FaceToolIcon, FilletIcon, HoleIcon, ImportedMeshIcon, ImportedSolidIcon, IntersectIcon, LineToolIcon,
  LinearArrayToolIcon, LinearPatternIcon, LoftIcon, MirrorSolidIcon, MirrorToolIcon, OffsetToolIcon, PlaneIcon,
  PlaneSectionIcon, PlotPointIcon, PointArrayToolIcon, PointPatternIcon, PolygonToolIcon, ProjectCurveIcon,
  RectangleToolIcon, ReferenceAxisIcon, ReferencePointIcon, RevolveIcon, RibIcon, RuledIcon, ScaleIcon, SewIcon,
  SheetBaseIcon, SheetFlangeIcon, SheetLineBendIcon, SheetReliefIcon, ShellIcon, SlotToolIcon, SphereIcon,
  SplineToolIcon, SpringIcon, SubtractIcon, SurfaceIcon, SweepIcon, ThreadHoleIcon, ThreadShaftIcon, TorusIcon,
  TransformIcon, UnionIcon, type IconProps,
} from './icons.js';
import { TimelineStopHandle } from './Timeline.js';
import { beginTimelineDrag, dropMarkerFor, type TimelineRefusal } from './timelineMove.js';
import type { TimelineStop } from './timelineRail.js';
import type { FeatureTreeInput, RowMenuState } from './useFeatureTreeInput.js';

/**
 * 行の頭に出す種類の絵。道具のアイコンと同じ図柄にして、作ったものと道具を結び付ける
 * (木の行と「作る」「加工」の一覧のボタンが同じ絵になる)。
 */
const KIND_ICONS: Readonly<
  Record<
    SketchTreeKind | SolidLabelKey | ReferenceFeatureKind,
    (props: IconProps) => React.JSX.Element
  >
> = {
  sheetBase: SheetBaseIcon,
  sheetFlange: SheetFlangeIcon,
  sheetBend: SheetLineBendIcon,
  sheetRelief: SheetReliefIcon,
  point: PlotPointIcon,
  line: LineToolIcon,
  arc: ArcToolIcon,
  pointArray: PointArrayToolIcon,
  face: FaceToolIcon,
  rectangle: RectangleToolIcon,
  polygon: PolygonToolIcon,
  slot: SlotToolIcon,
  ellipse: EllipseToolIcon,
  spline: SplineToolIcon,
  functionCurve: SplineToolIcon,
  offset: OffsetToolIcon,
  // 複製(FR-324)は配置ごとに絵を変える。どの複製かが木の絵だけで分かるようにするため。
  // `copy` そのものは配置の分からない総称なので、いちばん素直な「複写」の絵にする。
  copy: CopyToolIcon,
  copyMirror: MirrorToolIcon,
  copyTranslate: CopyToolIcon,
  copyLinearArray: LinearArrayToolIcon,
  copyCircularArray: CircularArrayToolIcon,
  projectedCurve: ProjectCurveIcon,
  planeSection: PlaneSectionIcon,
  referencePlane: PlaneIcon,
  referenceAxis: ReferenceAxisIcon,
  referencePoint: ReferencePointIcon,
  referenceCoordinateSystem: CoordinateSystemIcon,
  extrude: ExtrudeIcon,
  revolve: RevolveIcon,
  sew: SewIcon,
  union: UnionIcon,
  subtract: SubtractIcon,
  intersect: IntersectIcon,
  hole: HoleIcon,
  threadHole: ThreadHoleIcon,
  fillet: FilletIcon,
  chamfer: ChamferIcon,
  linearPattern: LinearPatternIcon,
  circularPattern: CircularPatternIcon,
  spring: SpringIcon,
  // 基本形状5種(FR-429)。
  sphere: SphereIcon,
  box: BoxIcon,
  cylinder: CylinderIcon,
  cone: ConeIcon,
  torus: TorusIcon,
  // 面をつなぐ(FR-430)とロフト(FR-410)。直線で結ぶ / なめらかに結ぶの違いが絵でも分かる
  // (`icons.tsx` の注釈)。
  ruled: RuledIcon,
  loft: LoftIcon,
  mirror: MirrorSolidIcon,
  draft: DraftIcon,
  // 平らな面の移動(限られた一段)。面を押し出して足す / 削る操作なので、
  // 専用の図柄ができるまで押し出しの絵を借りる(木の名前は「面の移動」で見分けられる)。
  faceOffset: ExtrudeIcon,
  holeTranslate: TransformIcon,
  faceRotate: DraftIcon,
  transform: TransformIcon,
  scale: ScaleIcon,
  sweep: SweepIcon,
  rib: RibIcon,
  emboss: EmbossIcon,
  threadShaft: ThreadShaftIcon,
  surface: SurfaceIcon,
  functionSurface: SurfaceIcon,
  // 点パターン(FR-425)。直線・円形パターンと同じ絵では見分けが付かない。
  pointPattern: PointPatternIcon,
  // くり抜き(FR-418)。
  shell: ShellIcon,
  // 平面による切断(FR-432)。
  cut: CutIcon,
  surfaceCut: CutIcon,
  // 読み込んだ形のベースボディ 2 種(FR-802)。木の行がそのまま道具の絵になる。
  importedSolid: ImportedSolidIcon,
  importedMesh: ImportedMeshIcon,
};

/**
 * 一覧の高さの見込み(画素)。下端からはみ出すときに上へ出すかを決めるのに使う。
 * いちばん項目が多いのは基準点の行で、表示の切替・1 つ上へ・1 つ下へ・原点にする・改名・
 * 設計メモ・フォルダ移動・削除の 8 つ。
 */
const ROW_MENU_HEIGHT = 256;
/** 一覧の幅の見込み(画素)。css の .pcad-menu__item の min-width と左右の余白から。 */
const ROW_MENU_WIDTH = 132;
/** ボタンやカーソルと一覧の間の隙間、および画面の端との余白(画素)。 */
const ROW_MENU_GAP = 4;
const ROW_MENU_MARGIN = 8;

/** 画面の下からはみ出すなら上へ出す。上下どちらでも収まらないときは端に寄せる。 */
function menuTop(bottom: number, top: number): number {
  const below = bottom + ROW_MENU_GAP;
  const above = top - ROW_MENU_GAP - ROW_MENU_HEIGHT;
  const fits = below + ROW_MENU_HEIGHT <= window.innerHeight - ROW_MENU_MARGIN;
  return Math.max(ROW_MENU_MARGIN, fits ? below : above);
}

/**
 * 一覧の右端の位置。指定した場所へ右端をそろえるが、左右の端からははみ出させない。
 * モデルブラウザは画面のいちばん左にあるので、そのままでは左へはみ出すことがある。
 */
function menuRight(right: number): number {
  const smallest = ROW_MENU_WIDTH + ROW_MENU_MARGIN;
  const largest = window.innerWidth - ROW_MENU_MARGIN;
  return Math.min(Math.max(right, smallest), Math.max(smallest, largest));
}

/** 行を描くのに要るもの。1 回の描画のあいだ変わらない。 */
interface FeatureTreeRowContext {
  readonly part: PartDocument;
  readonly input: FeatureTreeInput;
  readonly selectedIds: ReadonlySet<string>;
  readonly hoveredId: string | null;
  readonly timelineStops: ReadonlyMap<string, TimelineStop>;
  readonly timelineAtEnd: boolean;
  readonly timelineRefusal: TimelineRefusal | null;
  readonly sections: readonly TreeSection[];
  readonly sketchGroups: readonly SketchTreeGroup[];
  readonly collapsedSketchIds: readonly string[];
  readonly setCollapsedSketchIds: Dispatch<SetStateAction<readonly string[]>>;
  /** フォルダへ入れた行か。入れた行はフォルダの中だけに出す。 */
  readonly ownedRow: (id: string, section: RowMenuSection, sketchId?: string) => boolean;
  /** 名前の欄の確定(Enter・欄を離れる)。名前を変えて、欄を閉じる。 */
  readonly commitRename: (featureId: string, sectionKey: RowMenuSection, name: string) => void;
}

/** 一覧を開く相手(位置は開く場所で決める)。 */
type RowMenuTarget = Omit<RowMenuState, 'x' | 'y'>;

/** 名前の欄。Enter と欄を離れることで確定し、Esc で取り消す。IME の変換中のキーは見ない。 */
function renderRenameInput(context: FeatureTreeRowContext, featureId: string, sectionKey: RowMenuSection,
  name: string): React.JSX.Element {
  return (
    <input
      className="pcad-tree__rename"
      type="text"
      autoComplete="off"
      spellCheck={false}
      defaultValue={name}
      aria-label={t('featureTree.renameLabel')}
      title={t('featureTree.renameTooltip')}
      autoFocus
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onBlur={(event) => {
        context.commitRename(featureId, sectionKey, event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          context.commitRename(featureId, sectionKey, event.currentTarget.value);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          context.input.stopRename();
        }
      }}
    />
  );
}

/**
 * 「⋮」のボタン。どの行も同じ非モーダルの一覧を開く(NFR-UX-2)。
 * 一覧の中身(抑制・改名の有無)は開いた行の節で決まる。
 */
function renderMenuButton(context: FeatureTreeRowContext, target: RowMenuTarget): React.JSX.Element {
  const { input } = context;
  return (
    <button
      type="button"
      className="pcad-tree__more"
      title={t('featureTree.menuTooltip')}
      aria-label={t('featureTree.menuTooltip')}
      aria-haspopup="menu"
      aria-expanded={input.menu !== null && input.menu.featureId === target.featureId}
      onClick={(event) => {
        input.menuTriggerRef.current = event.currentTarget;
        const rect = event.currentTarget.getBoundingClientRect();
        input.openMenu({ ...target, x: menuRight(rect.right), y: menuTop(rect.bottom, rect.top) });
      }}
    >
      {t('featureTree.menuMark')}
    </button>
  );
}

/** 設計メモを持つ行の札。メモが空なら出さない。 */
function renderNoteBadge(part: PartDocument, target: FeatureNoteTarget): React.JSX.Element | null {
  return featureNoteOf(part, target) === '' ? null
    : <span className="pcad-tree__badge" title={t('historyNote.edit')}>{t('historyNote.badge')}</span>;
}

/**
 * スケッチ 1 本の親行と、その下にぶら下がる要素の行(FR-501)。スケッチが 2 本以上あるときだけ出す。
 *
 * 押すと**作図するスケッチが切り替わり**(作図面の札とビューポートの作図面も追従する。
 * 追従の中身はストアの `setActiveSketch`)、いま作図しているスケッチをもう一度押すと
 * 中身の開閉になる。開閉だけの別のボタンを置かないのは、行の中に押せるものが増えるほど
 * 「どこを押せば切り替わるのか」が読み取りにくくなるため(NFR-UX-1)。
 */
export function renderFeatureTreeSketchGroup(context: FeatureTreeRowContext, group: SketchTreeGroup): React.JSX.Element {
  const { part, input, collapsedSketchIds, setCollapsedSketchIds } = context;
  const open = !collapsedSketchIds.includes(group.sketchId);
  const rowClassName =
    'pcad-tree__row pcad-tree__row--child pcad-tree__row--sketch' +
    (group.active ? ' pcad-tree__row--selected' : '');
  const target: RowMenuTarget = { featureId: group.sketchId, name: group.name, sectionKey: 'sketchDocument' };
  return (
    <li key={group.sketchId}>
      <div
        className={rowClassName}
        data-name-search-key={featureFolderMemberKey({ kind: 'sketch', id: group.sketchId })}
        onContextMenu={(event) => {
          event.preventDefault();
          input.menuTriggerRef.current = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
          input.openMenu({ ...target, x: menuRight(event.clientX), y: menuTop(event.clientY, event.clientY) });
        }}
      >
        {input.renamingId === group.sketchId ? renderRenameInput(context, group.sketchId, 'sketchDocument', group.name) : (
          <button
            type="button"
            className="pcad-tree__select pcad-tree__select--sketch"
            aria-pressed={group.active}
            aria-expanded={open}
            title={t('featureTree.switchSketch')}
            onClick={() => {
              if (!group.active) {
                switchSketch(group.sketchId);
                setCollapsedSketchIds((ids) => ids.filter((id) => id !== group.sketchId));
                return;
              }
              setCollapsedSketchIds((ids) =>
                ids.includes(group.sketchId)
                  ? ids.filter((id) => id !== group.sketchId)
                  : [...ids, group.sketchId],
              );
            }}
          >
            <ChevronRightIcon
              size={12}
              className={'pcad-tree__chevron' + (open ? ' pcad-tree__chevron--open' : '')}
            />
            <PlaneIcon size={14} className="pcad-tree__icon" />
            <span className="pcad-tree__label">{group.name}</span>
          </button>
        )}
        {group.active ? (
          <span className="pcad-tree__badge">{t('featureTree.sketchActive')}</span>
        ) : null}
        <span className="pcad-tree__count">{group.rows.length}</span>
        {renderNoteBadge(part, { kind: 'sketch', id: group.sketchId })}
        {renderMenuButton(context, target)}
      </div>
      {!open ? null : group.rows.length === 0 ? (
        <p className="pcad-tree__hint pcad-tree__hint--nested">{t('featureTree.sketchEmpty')}</p>
      ) : (
        <ul className="pcad-tree__children pcad-tree__children--nested">
          {group.rows.filter(row => !context.ownedRow(row.id, 'sketch', group.sketchId))
            .map((row) => renderFeatureTreeRow(context, row, 'sketch', group.sketchId))}
        </ul>
      )}
    </li>
  );
}

/**
 * 行の見た目の状態(選択・ホバー・タイムラインのつまみより後ろ・並べ替えの予告・抑制)を class へ写す。
 * つまみより後ろの行は「いまは形になっていない」ので薄く出す(抑制とは別の薄さ。抑制は保存されるが、
 * つまみの位置は保存されない)。並べ替えの予告は落ちる場所に線を引き、落とせない位置では赤くする
 * (離してから断るのではなく、離す前に見て分かるようにするため。FR-507、NFR-UX-5)。
 */
function treeRowClassName(context: FeatureTreeRowContext, row: TreeRow, selected: boolean,
  stop: TimelineStop | undefined): string {
  const { input: { drag }, hoveredId } = context;
  const ahead = stop !== undefined && stop.state === 'ahead';
  const marker = stop === undefined ? null : dropMarkerFor(drag, stop.entry.index);
  const dragging = drag !== null && drag.moved && drag.featureId === row.id;
  return 'pcad-tree__row pcad-tree__row--child' +
    (stop === undefined ? '' : ' pcad-tree__row--timeline') +
    (selected ? ' pcad-tree__row--selected' : '') +
    (hoveredId === row.id ? ' pcad-tree__row--hovered' : '') +
    (ahead ? ' pcad-tree__row--ahead' : '') +
    (dragging ? ' pcad-tree__row--dragging' : '') +
    (marker === null ? '' : ` pcad-tree__row--drop-${marker}`) +
    (marker !== null && drag !== null && drag.refusal !== null
      ? ' pcad-tree__row--drop-refused'
      : '') +
    // 画面に出していない基準(FR-329)は、抑制中の立体と同じ薄さで出して見分ける。
    (row.suppressed || row.hidden ? ' pcad-tree__row--suppressed' : '');
}

/**
 * 履歴の行 1 つ(FR-501)。行をクリックで選び、Shift/Ctrl+クリックで足す(FR-106)。指を乗せると
 * ビューポート側も光る。計算できていない行には赤い印を出し、理由をホバーで見せる(FR-504)。
 * 帯に出る行(基準ジオメトリと立体)だけがタイムラインのつまみを持ち、掴んで並べ替えられる(FR-507)。
 */
export function renderFeatureTreeRow(
  context: FeatureTreeRowContext,
  row: TreeRow,
  sectionKey: TreeSectionKey,
  sketchId?: string,
): React.JSX.Element {
  const { part, input, selectedIds, timelineStops, timelineAtEnd, timelineRefusal } = context;
  const KindIcon = KIND_ICONS[row.kind];
  const selected = selectedIds.has(row.id) && (sectionKey !== 'sketch' || (sketchId ?? part.activeSketchId) === part.activeSketchId);
  const stop: TimelineStop | undefined = timelineStops.get(row.id);
  // 断りの向け先は「壊れる側」の行(model の `blockingFeatureId`)。
  const refused = timelineRefusal !== null && timelineRefusal.blockingFeatureId === row.id;
  const noteTarget = noteTargetForRow(part, row.id, sectionKey, sketchId);
  return (
    <li key={row.id}>
      <div
        className={treeRowClassName(context, row, selected, stop)}
        // 落とし先は指の下の行から引く(`dropIndexAtPoint`)。帯に出る行だけが持つ。
        data-name-search-key={featureFolderMemberKey(noteTarget)}
        data-timeline-index={stop === undefined ? undefined : stop.entry.index}
        title={stop === undefined ? undefined : t('timeline.dragTooltip')}
        onPointerDown={(event) => {
          /*
           * 掴む(FR-507)。帯に出る行だけが掴める。左ボタン以外・つまみ・
           * 「⋮」・名前の欄の上では掴まない(それぞれ別の役目を持つため)。
           * この時点ではまだ「押しただけ」で、`DRAG_THRESHOLD_PX` を超えて動いて
           * 初めて並べ替えになる(押しただけなら行の選択)。
           */
          input.resetDragClick();
          if (stop === undefined || event.button !== 0 || event.shiftKey || event.ctrlKey || input.renamingId === row.id) {
            return;
          }
          if (
            event.target instanceof Element &&
            event.target.closest('.pcad-timeline__stop, .pcad-tree__more') !== null
          ) {
            return;
          }
          const started = beginTimelineDrag(part, row.id);
          if (started === null) {
            return;
          }
          input.beginDrag(started, event.clientX, event.clientY);
        }}
        onPointerEnter={() => {
          input.hoverRow(row.id);
        }}
        onPointerLeave={() => {
          input.leaveRow(row.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          input.menuTriggerRef.current = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
          selectRowForMenu(row.id, sketchId);
          input.openMenu({
            featureId: row.id,
            name: row.name,
            sketchId,
            sectionKey,
            x: menuRight(event.clientX),
            y: menuTop(event.clientY, event.clientY),
          });
        }}
      >
        {/*
          行の左端のつまみ(FR-507、FR-506)。行の高さも字下げも変えないよう、行の
          余白の上へ重ねて置く(画面へ足したものが区画を 1 段分押し広げないように)。
        */}
        {stop === undefined ? null : <TimelineStopHandle stop={stop} atEnd={timelineAtEnd} />}
        {input.renamingId === row.id ? renderRenameInput(context, row.id, sectionKey, row.name) : (
          <button
            type="button"
            className="pcad-tree__select"
            aria-pressed={selected}
            title={t(row.kindLabelKey)}
            onClick={(event) => {
              // 並べ替えのために掴んで動かした後にも `click` は飛んでくる。その 1 回だけは
              // 選択にしない(掴んで動かしたのに選択が入れ替わると読み取れないため)。
              if (input.consumeDragClick()) {
                return;
              }
              selectTreeRow(row.id, sketchId, event.shiftKey || event.ctrlKey);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Delete') {
                return;
              }
              // 参照していたものが壊れても消させる。理由は帯と赤い印で伝える(FR-504)。
              event.preventDefault();
              removeTreeRow(row.id, sectionKey);
            }}
          >
            <KindIcon size={14} className="pcad-tree__icon" />
            <span className="pcad-tree__label">{row.name}</span>
          </button>
        )}
        {row.suppressed ? (
          <span className="pcad-tree__badge">{t('featureTree.suppressed')}</span>
        ) : null}
        {/*
          平面や軸を決めるためだけに置かれた基準点(`visible: false`)は「補助」の札で示す。
          行そのものは消さない。消すと名前を変える・出し直す・消す(FR-503)ができなくなる。
        */}
        {row.hidden ? (
          <span className="pcad-tree__badge" title={t('featureTree.hiddenTooltip')}>
            {t('featureTree.hidden')}
          </span>
        ) : null}
        {row.consumed && !row.suppressed ? (
          <span className="pcad-tree__badge" title={t('featureTree.consumedTooltip')}>
            {t('featureTree.consumed')}
          </span>
        ) : null}
        {row.errorMessage === null ? null : (
          <span
            className="pcad-tree__alert"
            title={`${row.errorMessage} ${t('featureTree.errorTooltip')}`}
          >
            <AlertIcon size={12} />
          </span>
        )}
        {/*
          並べ替えを断った理由(FR-507、FR-504)。出す先は動かした行ではなく
          **壊れる側の行**(model の `blockingFeatureId`)。「どれが困るのか」がその場で
          分かるようにするため。同じ文はステータスバーの帯にも 1 行で出る。
        */}
        {!refused || timelineRefusal === null ? null : (
          <span
            className="pcad-tree__alert"
            title={`${timelineRefusal.message} ${t('timeline.refusalTooltip')}`}
          >
            <AlertIcon size={12} />
          </span>
        )}
        {renderNoteBadge(part, noteTarget)}
        {renderMenuButton(context, { featureId: row.id, name: row.name, sketchId, sectionKey })}
      </div>
    </li>
  );
}

/** フォルダの中の 1 件(スケッチ・スケッチの要素・基準・立体)。消えた相手は名前だけの札にする。 */
export function renderFeatureTreeFolderMember(context: FeatureTreeRowContext, member: FeatureNoteTarget): React.JSX.Element {
  const { sketchGroups, sections } = context;
  if (member.kind === 'sketch') {
    const group = sketchGroups.find(item => item.sketchId === member.id);
    if (group !== undefined) return renderFeatureTreeSketchGroup(context, group);
  } else if (member.kind === 'sketch-feature') {
    const group = sketchGroups.find(item => item.sketchId === member.sketchId);
    const row = group?.rows.find(item => item.id === member.id);
    if (row !== undefined) return renderFeatureTreeRow(context, row, 'sketch', member.sketchId);
  } else {
    const row = sections.find(section => section.key === member.kind)?.rows.find(item => item.id === member.id);
    if (row !== undefined) return renderFeatureTreeRow(context, row, member.kind);
  }
  return <li className="pcad-tree__hint">{t('historyFolder.missing').replace('{name}', member.id)}</li>;
}
