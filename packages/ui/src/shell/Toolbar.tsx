/**
 * ツールバー(FR-901〜904、NFR-UX-7)。**ここは区画を並べるだけ**で、
 * 一覧の中身は `toolbarMenus.ts`、押したときの配線と区画の部品は `menus/` にある
 * (P6 タスク52。道具を足すときはこのファイルではなく、その一覧のファイルへ書く)。
 */
/*
 * ボディ一覧の詰め替え(`subShapeBodiesOf`)は `solid/subShapeSelection.ts` が正本
 * (作るのが `SubShapeBody` なので、その型を持つファイルに置く。P4b タスク18 で移した)。
 * ここから輸出し直してあるのは、P3 からの読み手の import をそのまま生かすため。
 */
export { subShapeBodiesOf } from '../solid/subShapeSelection.js';

import { useEffect, useState } from 'react';
import { loadRecentFiles } from '../file/recentFiles.js';
import { t } from '../i18n/t.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import {
  cancelConstraintTool,
  chooseConstraintTool,
  constraintToolReadinessOf,
} from '../sketch/constraintActions.js';
import { editToolReadiness } from '../sketch/editCommands.js';
import { workPlaneEntries } from '../sketch/referenceCommands.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { activeDocumentKind, activeFileName } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { NamedViewsMenu } from '../viewport/NamedViewsMenu.js';
import {
  ChainIcon,
  ConstraintGroupIcon,
  CubeIcon,
  EditGroupIcon,
  FileMenuIcon,
  GridIcon,
  HomeIcon,
  MatchViewIcon,
  PerspectiveIcon,
  PlaneSectionIcon,
  RedoIcon,
  ShadedIcon,
  ShadedWithEdgesIcon,
  ShapeGroupIcon,
  SnapIcon,
  UndoIcon,
  WireframeIcon,
} from './icons.js';
import {
  ExportPanelHost,
  FILE_ACTIONS,
  fileTooltip,
  loadTemplateEntries,
  runFileAction,
  runFileMenuAction,
} from './menus/fileToolbarActions.js';
import { LookGroup } from './menus/LookGroup.js';
import { AssemblyGroup } from './menus/AssemblyGroup.js';
import { PlaneMenu } from './menus/PlaneMenu.js';
import { activateEditTool, activateShapeTool, activateTool } from './menus/sketchToolActions.js';
import { TOOLS } from './menus/sketchToolTables.js';
import { SnapKindsMenu } from './menus/SnapKindsMenu.js';
import { SolidGroup } from './menus/SolidGroup.js';
import { ToolMenu } from './menus/ToolMenu.js';
import {
  CONSTRAINT_MENU_ITEMS,
  EDIT_MENU_ITEMS,
  fileMenuItems,
  type NamedMenuEntry,
  PROJECTION_MENU_ITEMS,
  SHAPE_MENU_ITEMS,
} from './toolbarMenus.js';

/**
 * 画面上端のツールバー(要件§7.1)。
 *
 * 左から「製品名 → ファイル → 元に戻す・やり直す → モードのタブ → スケッチ → ソリッド →
 * 見た目 → 作図面」、右へ「投影 / 表示 / 補助 / 吸着 / 視点」の機能グループを並べる
 * (P5 タスク51 で「加工」区画を「ソリッド」区画の中の畳んだ一覧へ寄せ、「外観」区画を
 * 「見た目」へ改めた。§0.a-0.51)。
 * 機能グループは区画名を頭に置き、いま選ばれているものをアクセント色の面で示す(NFR-UX-7)。
 * 状態の正本は Zustand ストア1本(rules/04-設計の規律.md)。
 *
 * 「スケッチ」区画は、基本の 6 道具(選択・点・線分・円弧・点列・面)の右に「作図」「編集」
 * 「拘束」の畳んだボタンを**同じ行**へ並べた 1 行にする(利用者の決定 2026-09-04、タスク32)。
 * 「ソリッド」区画も同じ作りで「作る」「合わせる」「加工」の 3 つを 1 つの溝に並べる。
 * よく使う道具は 1 クリック、それ以外は 2 クリックで届く。
 *
 * 横幅の方針: 1440 画素の窓で 1 段に収まることを条件にする(§0.a-0.15)。
 * 実測(2026-09-05、ダーク・拡大率 100%、1440×900): 高さ 68.5 画素の 1 段、1 段に必要な幅
 * 1144.3 画素、1440 画素の窓での余裕 295.7 画素(タスク51 の前は 1437.3 画素・余裕 2.7 画素)。
 * 畳んだ一覧へ道具を足しても幅は増えない(`toolbarMenus.ts` の `segmentedWidthPixels`)ので、
 * タスク18・27f・32・49 が足すボタンはすべて既存の一覧の中へ入る。
 * 図柄で分かるものは図柄だけのボタン(`pcad-button--icon`)にして詰め、
 * 文字を添えたい道具(スケッチ・続けてかく)には `pcad-button--collapsible` を付けて、
 * 窓が 1600 画素より狭いときだけ文字を畳む(appShell.css)。図柄だけになるボタンには
 * 必ず読み上げ名(aria-label)と、名前で始まるツールチップを付ける(FR-904、NFR-UX-7)。
 */
export function Toolbar(): React.JSX.Element {
  const documentKind = useAppStore(activeDocumentKind);
  const projection = useAppStore((state) => state.projection);
  const displayStyle = useAppStore((state) => state.displayStyle);
  const showGrid = useAppStore((state) => state.showGrid);
  // 断面表示(FR-111、P6 タスク35)。**入切だけ**を取り出して、切る位置が動いただけでは
  // ツールバーを描き直さない(NFR-PF-1。他の札と同じ取り出し方)。
  const sectionViewOn = useAppStore((state) => state.sectionView !== null);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapKinds = useAppStore((state) => state.snapKinds);
  // 向きの吸着の角度の刻み(FR-110)。数だけを取り出して、他の表示設定の変化では描き直さない。
  const trackAngleStep = useAppStore((state) => state.displaySettings.trackAngleStep);
  const chaining = useAppStore((state) => state.chaining);
  const partDocument = useAppStore((state) => state.document);
  // 文書にある任意の作業平面(FR-328、タスク13)。作図面の一覧に名前で並べる。
  const customPlanes = workPlaneEntries(partDocument);
  const bodies = useAppStore((state) => state.bodies);
  // ソリッド・加工の押せる条件の判定(solidToolReadiness)が要る形へ詰め替える
  // (タスク17 の後は state.bodies をそのまま渡せるようになる、subShapeBodiesOf の注釈)。
  const subShapeBodies = subShapeBodiesOf(bodies);
  const selection = useAppStore((state) => state.selection);
  // 外観(FR-1106〜1110、タスク12)の押せる条件の判定に要る。
  const selectionKind = useAppStore((state) => state.selectionKind);
  const appearanceMatches = useAppStore((state) => state.appearanceMatches);
  // 整形系(オフセット、FR-321、タスク21)の押せる条件の判定に要る。
  const resolvedSketch = useAppStore((state) => state.resolvedSketch);
  const canUndo = useAppStore((state) => state.canUndo);
  const canRedo = useAppStore((state) => state.canRedo);
  // 拘束(FR-313、タスク13)。いま選んでいる拘束の道具と、履歴そのもの(下見に要る)。
  const activeConstraintKind = useAppStore((state) => state.activeConstraintKind);
  useAppStore((state) => state.sketch);
  /*
   * 「拘束」の一覧の入り切り。材料(解決結果)を作るのは**一覧を開いたときだけ**なので、
   * ここで作った関数を渡す(`constraintToolReadinessOf` の注釈、NFR-PF-1)。
   * 上で `sketch` と `selection` を購読しているので、どちらかが変われば描き直される。
   */
  const constraintReadinessOf = constraintToolReadinessOf();
  /*
   * 書き出しのパネルが開いているか(P6 タスク32)。**見た目だけの一時状態**なので
   * ここで持つ(`SettingsPanel` の開閉と同じ扱い。rules/04 の「状態はストア 1 本」は
   * 部品文書と端末の好みが対象)。
   */
  const [exportOpen, setExportOpen] = useState(false);
  /*
   * 「ファイル」の一覧に並べる、数の決まらない行の材料(P6 タスク33)。
   *  - 保存したひな形(FR-814): ブラウザの中の置き場から**非同期**で読む。
   *  - 最近使ったファイル(FR-807): 端末の覚え書きから同期で読む。
   * どちらも**見た目だけの一時状態**なのでここで持つ(部品文書ではないので、rules/04 の
   * 「状態はストア 1 本」の対象ではない。書き出しのパネルの開閉と同じ扱い)。
   *
   * 読み直しの切っ掛けはファイルの名前(開く・保存でこの 2 つが変わる)と、ひな形を
   * 保存した回数。一覧を開くたびに読み直すより、変わった時だけで足りる(NFR-PF-1)。
   */
  const fileName = useAppStore(activeFileName);
  const [templateEntries, setTemplateEntries] = useState<readonly NamedMenuEntry[]>([]);
  const [templateSaveCount, setTemplateSaveCount] = useState(0);
  const [recentEntries, setRecentEntries] = useState<readonly NamedMenuEntry[]>([]);
  useEffect(() => {
    setRecentEntries(loadRecentFiles().map((entry) => ({ id: entry.name, name: entry.name })));
    let alive = true;
    if (documentKind === 'assembly') {
      setTemplateEntries([]);
      return () => { alive = false; };
    }
    void loadTemplateEntries().then((entries) => {
      // 読み終える前にこの区画が消えていたら、状態を触らない(片付け後の書き込みを避ける)。
      if (alive) {
        setTemplateEntries(entries);
      }
    });
    return () => {
      alive = false;
    };
  }, [documentKind, fileName, templateSaveCount]);

  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>

      {/*
        ファイルと履歴。どちらも世の中の道具と同じ図柄なので区画名を置かず、
        製品名のとなりに 5 つ並べる(§0.a-0.15)。
      */}
      <div className="pcad-toolbar__actions">
        <div className="pcad-segmented" role="group" aria-label={t('toolbar.file.title')}>
          {FILE_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="pcad-button pcad-button--icon"
              title={fileTooltip(action.id, action.tooltipKey)}
              aria-label={t(action.labelKey)}
              onClick={(event) => {
                runFileAction(action.id, event.shiftKey);
              }}
            >
              <action.Icon />
            </button>
          ))}
          {/*
            たまにしか使わないファイル操作(P6 §0.57、タスク31)。**新規・開く・保存と
            同じ溝の中**へ畳んだボタンを 1 つだけ足す。区画は増やさない(要件§7.1、rules/04)。
            溝は 88 → 121 画素の 33 画素だけ広がり、一覧の中へ項目をいくつ足しても
            そこから先は増えない(`toolbarMenus.ts` の `segmentedWidthPixels`)。

            押下表示を出さないのは、ファイル操作は**押した瞬間に終わる**もので、
            「いまこの道具を使っている」状態にならないため(「投影」と同じ理由、§0.a-0.80)。
          */}
          <ToolMenu
            /*
              決まった 6 行のうしろへ、保存したひな形と最近使ったファイルが名前のまま並ぶ
              (P6 タスク33)。**0 件のものは 1 行も出ない**ので、押しても何も起きない行が
              画面に出ることはない。行がいくつ増えても溝の幅は変わらない。
            */
            items={fileMenuItems(
              templateEntries,
              recentEntries,
              documentKind === 'assembly' ? 'assembly' : 'part',
            )}
            groupLabelKey="toolbar.fileMenu.groupLabel"
            groupTooltipKey="toolbar.fileMenu.tooltip"
            GroupIcon={FileMenuIcon}
            /*
              ファイル操作は道具として選ばれた状態にならないので、畳んだボタンの図柄は
              `ToolMenu` が覚える「最後に使った操作」だけで決まる(「合わせる」と同じ)。
            */
            activeTool=""
            showPressed={false}
            onChoose={(id) => {
              runFileMenuAction(
                id,
                () => {
                  setExportOpen(true);
                },
                () => {
                  // 保存し終えたひな形が一覧へすぐ並ぶよう、読み直しの切っ掛けを立てる。
                  setTemplateSaveCount((count) => count + 1);
                },
              );
            }}
          />
          {/*
            書き出しのパネル(FR-803、§0.a-0.20)。一覧の「書き出す」を選んだときだけ出す。
            **固定の区画は増やさない**(要件§7.1)——ここはツールバーの中の浮かぶ層である。
          */}
          {documentKind === 'part' && exportOpen ? (
            <ExportPanelHost
              onClose={() => {
                setExportOpen(false);
              }}
            />
          ) : null}
        </div>
        <div className="pcad-segmented" role="group" aria-label={t('toolbar.history.groupLabel')}>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={
              canUndo ? t('toolbar.history.undoTooltip') : t('toolbar.history.undoUnavailable')
            }
            aria-label={t('toolbar.history.undo')}
            aria-disabled={!canUndo}
            onClick={() => {
              if (canUndo) {
                useAppStore.getState().undo();
              }
            }}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={
              canRedo ? t('toolbar.history.redoTooltip') : t('toolbar.history.redoUnavailable')
            }
            aria-label={t('toolbar.history.redo')}
            aria-disabled={!canRedo}
            onClick={() => {
              if (canRedo) {
                useAppStore.getState().redo();
              }
            }}
          >
            <RedoIcon />
          </button>
        </div>
      </div>

      {/*
        モードのタブ。今はモデリングだけが使える。「アセンブリ」「図面」は、それを実装する
        P7 / P8 まで出さない(畳んで薄く見せるのではなく、丸ごと隠す。§0.a-0.25 ①、
        §0.34 の幅の圧縮)。実装したらここへ戻す。
      */}
      <nav className="pcad-toolbar__modes" aria-label={t('toolbar.mode.groupLabel')}>
        <button type="button" className="pcad-tab" aria-pressed={true}>
          {t(documentKind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}
        </button>
      </nav>

      {documentKind === 'part' ? <><div
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
              className="pcad-button pcad-button--collapsible"
              title={t(tool.tooltipKey)}
              aria-label={t(tool.labelKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateTool(tool.id, activeTool === tool.id);
              }}
            >
              <tool.Icon />
              <span className="pcad-button__label">{t(tool.labelKey)}</span>
            </button>
          ))}
          {/*
            「作図」「編集」は基本の 6 道具と**同じ溝の中**へ図柄+▾ のボタンとして置く
            (利用者の決定 2026-09-04、タスク32)。区画(.pcad-toolbar__group)は縦積みなので、
            溝の外へ出すと道具の下の段に落ちてツールバーが 2〜3 段相当になってしまう
            (t12・t21 の申し送り、実測 97.5〜126.5px)。ここへ入れておけば、一覧に道具を
            いくつ足しても横幅は 31 画素のまま増えない(toolbarMenus.ts の幅の見積もり)。
          */}
          <ToolMenu
            items={SHAPE_MENU_ITEMS}
            groupLabelKey="toolbar.shape.groupLabel"
            groupTooltipKey="toolbar.shape.tooltip"
            GroupIcon={ShapeGroupIcon}
            activeTool={activeTool}
            onChoose={activateShapeTool}
          />
          <ToolMenu
            items={EDIT_MENU_ITEMS}
            groupLabelKey="toolbar.edit.groupLabel"
            groupTooltipKey="toolbar.edit.tooltip"
            GroupIcon={EditGroupIcon}
            activeTool={activeTool}
            /*
              整形系のうち「対象を選んでから操作」(§2.5)の道具は、押せない理由を一覧の
              項目にも出す(NFR-UX-5)。道具ごとの振り分けは `editToolReadiness`
              (editCommands.ts)の 1 か所に置いてある。トリム・延長は選択を使わないので
              いつでも押せる(§0.a-0.26、タスク22)。
            */
            readinessOf={(id) => editToolReadiness(id, resolvedSketch, selection)}
            onChoose={activateEditTool}
          />
          {/*
            「拘束」(FR-313、P4b タスク13)。区画も段も増やさず、畳んだ一覧を 1 つ足すだけ
            (統括の決定 2026-09-05)。溝の幅は 31 画素しか増えないので、1440 画素の窓では
            1 段(68.5 画素)のまま(`toolbarMenus.ts` の `segmentedWidthPixels`)。

            押した後の流れは `constraintActions.ts` の 1 か所に置く。選んでいるものだけで
            条件が足りていればその場で付き、足りなければ「道具を選んだ状態」になって
            ビューポートで押した要素を順に受け取る(トリムと同じ流儀)。
          */}
          <ToolMenu
            items={CONSTRAINT_MENU_ITEMS}
            groupLabelKey="toolbar.constraint.groupLabel"
            groupTooltipKey="toolbar.constraint.tooltip"
            GroupIcon={ConstraintGroupIcon}
            activeTool={activeConstraintKind ?? ''}
            readinessOf={constraintReadinessOf}
            onChoose={(kind, pressed) => {
              if (pressed) {
                // 同じ道具をもう一度押したらやめる(トリム・延長と同じ、NFR-UX-1)。
                cancelConstraintTool();
                return;
              }
              chooseConstraintTool(kind);
            }}
          />
        </div>
      </div>

      <SolidGroup
        document={partDocument}
        bodies={subShapeBodies}
        selection={selection}
        activeTool={activeTool}
      />
      <LookGroup
        document={partDocument}
        bodies={subShapeBodies}
        selection={selection}
        selectionKind={selectionKind}
        matches={appearanceMatches}
        activeTool={activeTool}
      />

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.plane.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.plane.tooltip')}>
          {t('toolbar.plane.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <PlaneMenu
            workPlaneId={workPlaneId}
            activeTool={activeTool}
            customPlanes={customPlanes}
          />
          {/*
            いま見ている向きに最も近い作図面へ移る(§0.a-0.3)。視点の正本はビューポートの
            中にあるので、ここでは要求を数えるだけにしてビューポートに応えてもらう。
          */}
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.plane.matchViewTooltip')}
            aria-label={t('toolbar.plane.matchView')}
            onClick={() => {
              useAppStore.getState().requestMatchWorkPlaneToView();
            }}
          >
            <MatchViewIcon />
          </button>
        </div>
      </div>
      </> : <AssemblyGroup />}

      <span className="pcad-toolbar__spacer" />

      {/*
        投影(FR-102)。P5 タスク51 で 2 つの図柄ボタンを畳んだ一覧 1 つへまとめた
        (§0.a-0.51)。畳んだボタンには**いま効いているほうの図柄**が出るので、開かなくても
        今の見え方が読み取れる(`triggerItemOf` が `activeTool` = いまの投影と一致する項目を
        返す。作図面の一覧が「XY」を札に出すのと同じ考え方)。
        入れ物側に `role="group"` を付けないのは、開いた一覧がすでに同じ「投影」という名前の
        group だから(`LookGroup` の注釈と同じ理由)。
      */}
      <div className="pcad-toolbar__group">
        <span className="pcad-toolbar__group-label" title={t('toolbar.projection.tooltip')}>
          {t('toolbar.projection.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <ToolMenu
            items={PROJECTION_MENU_ITEMS}
            groupLabelKey="toolbar.projection.groupLabel"
            groupTooltipKey="toolbar.projection.tooltip"
            GroupIcon={PerspectiveIcon}
            activeTool={projection}
            /*
              投影は必ずどちらかが効いているので、畳んだボタンの押下表示は出さない
              (常に点いたままだと「押しっぱなし」に見える。§0.a-0.80、タスク32)。
              いま効いているほうは図柄が示す。
            */
            showPressed={false}
            onChoose={(mode) => {
              useAppStore.getState().setProjection(mode);
            }}
          />
        </div>
      </div>

      <NamedViewsMenu />
      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.displayStyle.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.displayStyle.tooltip')}>
          {t('toolbar.displayStyle.groupLabel')}
        </span>
        {/*
          3 つの図柄がそのまま見え方(塗りだけ / 塗りと稜線 / 線だけ)を写しているので、
          文字を添えずに図柄だけで並べる。名前は読み上げ名とツールチップが持つ。
        */}
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.shaded')}
            aria-label={t('toolbar.displayStyle.shaded')}
            aria-pressed={displayStyle === 'shaded'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shaded');
            }}
          >
            <ShadedIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.shadedWithEdges')}
            aria-label={t('toolbar.displayStyle.shadedWithEdges')}
            aria-pressed={displayStyle === 'shadedWithEdges'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shadedWithEdges');
            }}
          >
            <ShadedWithEdgesIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.wireframe')}
            aria-label={t('toolbar.displayStyle.wireframe')}
            aria-pressed={displayStyle === 'wireframe'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('wireframe');
            }}
          >
            <WireframeIcon />
          </button>
          {/*
            ビューの断面表示(FR-111、P6 タスク35、§0.57)。**「表示」の区画に入口 1 つだけ**を
            足す(区画は増やさない、rules/04)。押すと今の作図面で切り、切る位置はビューポートの
            つまみとその場の数値入力で動かす。**形は切らない**(見た目だけのクリップ)。
            図柄は交差の印を当面そのまま使う(専用の図柄はタスク45 でまとめて作る)。
          */}
          {documentKind === 'part' ? <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.sectionView.tooltip')}
            aria-label={t('toolbar.sectionView.label')}
            aria-pressed={sectionViewOn}
            onClick={() => {
              useAppStore.getState().toggleSectionView();
            }}
          >
            <PlaneSectionIcon />
          </button> : null}
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.support.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.support.tooltip')}>
          {t('toolbar.support.groupLabel')}
        </span>
        <div className="pcad-segmented">
          {/* 方眼の図柄そのままなので文字は添えない。「続けてかく」は狭い窓でだけ畳む。 */}
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.grid.tooltip')}
            aria-label={t('toolbar.grid.label')}
            aria-pressed={showGrid}
            onClick={() => {
              useAppStore.getState().setShowGrid(!showGrid);
            }}
          >
            <GridIcon />
          </button>
          {documentKind === 'part' ? <button
            type="button"
            className="pcad-button pcad-button--collapsible"
            title={t('toolbar.chain.tooltip')}
            aria-label={t('toolbar.chain.label')}
            aria-pressed={chaining}
            onClick={() => {
              useAppStore.getState().setChaining(!chaining);
            }}
          >
            <ChainIcon />
            <span className="pcad-button__label">{t('toolbar.chain.label')}</span>
          </button> : null}
        </div>
      </div>

      {documentKind === 'part' ? <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.snap.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.snap.tooltip')}>
          {t('toolbar.snap.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.snap.tooltip')}
            aria-label={t('toolbar.snap.label')}
            aria-pressed={snapEnabled}
            onClick={() => {
              useAppStore.getState().setSnapEnabled(!snapEnabled);
            }}
          >
            <SnapIcon />
          </button>
          <SnapKindsMenu
            snapEnabled={snapEnabled}
            snapKinds={snapKinds}
            trackAngleStep={trackAngleStep}
          />
        </div>
      </div> : null}

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.view.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.view.tooltip')}>
          {t('toolbar.view.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--action pcad-button--icon"
            title={t('toolbar.home.tooltip')}
            aria-label={t('toolbar.home.label')}
            onClick={() => {
              useAppStore.getState().requestHomeView();
            }}
          >
            <HomeIcon />
          </button>
        </div>
      </div>

      {/*
        表示設定(FR-908、FR-909)。歯車ひとつを視点区画の右へ置き、押すとその場に
        テーマの見本と拡大率が開く(固定の区画は増やさない、要件§7.1)。
        区画名を持たない図柄だけのボタンなので、名前は読み上げ名とツールチップが担う。
        溝(.pcad-segmented)で囲まないのは、1 つしか無いことと、1440 画素の窓で
        1 段を保つ幅の予算のため(囲むと 6 画素増える)。
      */}
      <SettingsPanel />
    </header>
  );
}
