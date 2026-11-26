import { SavePointsDialogHost } from './SavePointsButton.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { toolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { currentCommandLabel } from '../commands/commandLabels.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
/**
 * ツールバー(FR-901〜904、NFR-UX-7)。**ここは区画を並べるだけ**で、
 * 作図と表示の区画は ModelingToolbarGroups と ViewToolbarGroups、一覧と操作は
 * `toolbarMenus.ts` と `menus/` にある。
 */
/*
 * ボディ一覧の詰め替え(`subShapeBodiesOf`)は `solid/subShapeSelection.ts` が正本
 * (作るのが `SubShapeBody` なので、その型を持つファイルに置く)。
 * ここから輸出し直してあるのは、以前からの読み手の import をそのまま生かすため。
 */
export { subShapeBodiesOf } from '../solid/subShapeSelection.js';

import { useEffect, useState } from 'react';
import { loadRecentFiles } from '../file/recentFiles.js';
import { t } from '../i18n/t.js';
import { HelpButton } from '../help/HelpButton.js';
import { ScriptToolsMenu } from '../scripting/ScriptToolsMenu.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { activeDocumentKind, activeFileName, editingDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { NamedViewsMenu } from '../viewport/NamedViewsMenu.js';
import { CubeIcon, FileMenuIcon, RedoIcon, UndoIcon } from './icons.js';
import {
  ExportPanelHost,
  FILE_ACTIONS,
  fileTooltip,
  loadTemplateEntries,
  runFileMenuAction,
} from './menus/fileToolbarActions.js';
import { AnalysisGroup } from './menus/AnalysisGroup.js';
import { ImportFormatPanel } from '../file/ImportFormatPanel.js';
import { AssemblyGroup } from './menus/AssemblyGroup.js';
import { PartFileDialogs } from './menus/PartFileDialogs.js';
import { ToolMenu } from './menus/ToolMenu.js';
import { fileMenuItems, type NamedMenuEntry } from './toolbarMenus.js';
import { AppearanceTools, PartModelingTools } from './ModelingToolbarGroups.js';
import { DisplayStyleGroup, DrawingAidsGroup, ProjectionGroup, SnapGroup, ViewpointGroup } from './ViewToolbarGroups.js';

/**
 * 画面上端のツールバー(要件§7.1)。
 *
 * 左から「製品名 → ファイル → 元に戻す・やり直す → モードのタブ → スケッチ → ソリッド →
 * 見た目 → 作図面」、右へ「投影 / 表示 / 補助 / 吸着 / 視点」の機能グループを並べる
 * (「加工」は「ソリッド」区画の中の畳んだ一覧に入れ、「外観」は
 * 「見た目」の区画に入れる)。
 * 機能グループは区画名を頭に置き、いま選ばれているものをアクセント色の面で示す(NFR-UX-7)。
 * 状態の正本は Zustand ストア1本(rules/04-設計の規律.md)。
 *
 * 「スケッチ」区画は、基本の 6 道具(選択・点・線分・円弧・点列・面)の右に「作図」「編集」
 * 「拘束」の畳んだボタンを**同じ行**へ並べた 1 行にする(利用者の決定)。
 * 「ソリッド」区画も同じ作りで「作る」「合わせる」「加工」の 3 つを 1 つの溝に並べる。
 * よく使う道具は 1 クリック、それ以外は 2 クリックで届く。
 *
 * 横幅の方針: 1440 画素の窓で 1 段に収まることを条件にする。
 * 実測(ダーク・拡大率 100%、1440×900): 高さ 68.5 画素の 1 段、1 段に必要な幅
 * 1144.3 画素、1440 画素の窓での余裕 295.7 画素(畳む前は 1437.3 画素・余裕 2.7 画素)。
 * 畳んだ一覧へ道具を足しても幅は増えない(`toolbarMenus.ts` の `segmentedWidthPixels`)ので、
 * 後から足すボタンはすべて既存の一覧の中へ入る。
 * 図柄で分かるものは図柄だけのボタン(`pcad-button--icon`)にして詰め、
 * 文字を添えたい道具(スケッチ・続けてかく)には `pcad-button--collapsible` を付けて、
 * 窓が 1600 画素より狭いときだけ文字を畳む(appShell.css)。図柄だけになるボタンには
 * 必ず読み上げ名(aria-label)と、名前で始まるツールチップを付ける(FR-904、NFR-UX-7)。
 */
export function Toolbar(): React.JSX.Element {
  const documentKind = useAppStore(editingDocumentKind);
  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>

      {/*
        ファイルと履歴。どちらも世の中の道具と同じ図柄なので区画名を置かず、
        製品名のとなりに 5 つ並べる。
      */}
      <div className="pcad-toolbar__actions">
        <FileActionsGroup />
        <HistoryGroup />
      </div>

      {/* 現在の文書の種類を示す札。操作やキーボードの移動先にはしない。 */}
      <div className="pcad-toolbar__modes" role="group" aria-label={t('toolbar.mode.groupLabel')}>
        <span className="pcad-toolbar__mode" role="img"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 24, whiteSpace: 'nowrap' }}
          aria-label={t(documentKind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}
          title={t(documentKind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}>
          <CubeIcon className="pcad-toolbar__mode-icon" />
          <span className="pcad-toolbar__mode-label" style={{ padding: '0 var(--pcad-space-2)' }}>{t(documentKind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}</span>
        </span>
        <EndPartEditButton />
      </div>

      {documentKind === 'part' ? <PartModelingTools /> : (
        <>
          <AssemblyGroup />
          <AppearanceTools />
        </>
      )}

      <AnalysisGroup />

      <span className="pcad-toolbar__spacer" />

      {/*
        投影(FR-102)。2 つの図柄ボタンを畳んだ一覧 1 つへまとめてある。
        畳んだボタンには**いま効いているほうの図柄**が出るので、開かなくても
        今の見え方が読み取れる(`triggerItemOf` が `activeTool` = いまの投影と一致する項目を
        返す。作図面の一覧が「XY」を札に出すのと同じ考え方)。
        入れ物側に `role="group"` を付けないのは、開いた一覧がすでに同じ「投影」という名前の
        group だから(`LookGroup` の注釈と同じ理由)。
      */}
      <ProjectionGroup />

      <NamedViewsMenu />
      <DisplayStyleGroup />
      <DrawingAidsGroup />
      <SnapGroup />
      <ViewpointGroup />

      {/*
        表示設定(FR-908、FR-909)。歯車ひとつを視点区画の右へ置き、押すとその場に
        テーマの見本と拡大率が開く(固定の区画は増やさない、要件§7.1)。
        区画名を持たない図柄だけのボタンなので、名前は読み上げ名とツールチップが担う。
        溝(.pcad-segmented)で囲まないのは、1 つしか無いことと、1440 画素の窓で
        1 段を保つ幅の予算のため(囲むと 6 画素増える)。
      */}
      <SettingsPanel />
      <HelpButton />
      <SavePointsDialogHost />
    </header>
  );
}

function EndPartEditButton(): React.JSX.Element | null {
  const edit = useAppStore(state => state.partEdit);
  if (edit === null) return null;
  const options = [
    ['plane', 'assembly.partEdit.planeCopy', 'assembly.guide.partEditPlane'],
    ['holeCenters', 'assembly.partEdit.holeCenters', 'assembly.guide.partEditHoles'],
    ['outline', 'assembly.partEdit.outline', 'assembly.guide.partEditOutline'],
  ] as const;
  return <>
    {options.map(([kind, label, guide]) => {
      const picking = edit.contextPick?.kind === kind;
      return <button key={kind} type="button" className="pcad-button" aria-pressed={picking} title={t(guide)} onClick={() => {
        const state = useAppStore.getState();
        state.setPartEditContextPick(picking ? null : kind);
        if (!picking) state.requestViewportFocus();
      }}>{t(label)}</button>;
    })}
    <button type="button" className="pcad-button"
      title={t('assembly.guide.partEditEnd')} onClick={() => { useAppStore.getState().endAssemblyPartEdit(); }}>{t('assembly.partEdit.end')}</button>
  </>;
}

function FileActionsGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  /*
   * 書き出しのパネルが開いているか。**見た目だけの一時状態**なので
   * ここで持つ(`SettingsPanel` の開閉と同じ扱い。rules/04 の「状態はストア 1 本」は
   * 部品文書と端末の好みが対象)。
   */
  const utilityPanel = useAppStore(state => state.utilityPanel);
  const exportOpen = utilityPanel === 'export', importOpen = utilityPanel === 'import';
  const setComparisonOpen = (open: boolean): void => useAppStore.getState().setUtilityPanelOpen('comparison', open);
  const setExportOpen = (open: boolean): void => useAppStore.getState().setUtilityPanelOpen('export', open);
  const setImportOpen = (open: boolean): void => useAppStore.getState().setUtilityPanelOpen('import', open);
  /*
   * 「ファイル」の一覧に並べる、数の決まらない行の材料。
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
  const templateSaveCount = useAppStore(state => state.templateListRevision);
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
    <div className="pcad-segmented" role="group" aria-label={t('toolbar.file.title')}>
      {FILE_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="pcad-button pcad-button--icon"
          title={fileTooltip(action.id, shortcutAssignments, documentKind)}
          aria-label={t(action.labelKey)}
          data-command-id={toolbarCommandId('file', action.id)}
          onClick={(event) => {
            executeCommand(action.id === 'save' && event.shiftKey
              ? toolbarCommandId('fileMenu', 'saveAs')
              : toolbarCommandId('file', action.id));
          }}
        >
          <action.Icon />
        </button>
      ))}
      {/*
        たまにしか使わないファイル操作。**新規・開く・保存と
        同じ溝の中**へ畳んだボタンを 1 つだけ足す。区画は増やさない(要件§7.1、rules/04)。
        溝は 88 → 121 画素の 33 画素だけ広がり、一覧の中へ項目をいくつ足しても
        そこから先は増えない(`toolbarMenus.ts` の `segmentedWidthPixels`)。

        押下表示を出さないのは、ファイル操作は**押した瞬間に終わる**もので、
        「いまこの道具を使っている」状態にならないため(「投影」と同じ理由)。
      */}
      <ToolMenu
        /*
          決まった 6 行のうしろへ、保存したひな形と最近使ったファイルが名前のまま並ぶ。
          **0 件のものは 1 行も出ない**ので、押しても何も起きない行が
          画面に出ることはない。行がいくつ増えても溝の幅は変わらない。
        */
        items={fileMenuItems(
          templateEntries,
          recentEntries,
          documentKind === 'assembly' ? 'assembly' : 'part',
        )}
        commandGroup="fileMenu"
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
              useAppStore.getState().refreshTemplateEntries();
            },
            () => { setExportOpen(false); setImportOpen(true); },
            () => { setExportOpen(false); setImportOpen(false); setComparisonOpen(true); },
          );
        }}
      />
      {/*
        書き出しのパネル(FR-803)。一覧の「書き出す」を選んだときだけ出す。
        **固定の区画は増やさない**(要件§7.1)——ここはツールバーの中の浮かぶ層である。
      */}
      {documentKind === 'part' ? <PartFileDialogs /> : null}
      {documentKind === 'part' ? <ScriptToolsMenu /> : null}
      {documentKind === 'part' && importOpen ? <ImportFormatPanel onClose={() => { setImportOpen(false); }} /> : null}
      {documentKind === 'part' && exportOpen ? (
        <ExportPanelHost
          onClose={() => {
            setExportOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function HistoryGroup(): React.JSX.Element {
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const shortcutAssignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const canUndo = useAppStore((state) => state.canUndo);
  const canRedo = useAppStore((state) => state.canRedo);
  return (
    <div className="pcad-segmented" role="group" aria-label={t('toolbar.history.groupLabel')}>
      <button
        type="button"
        className="pcad-button pcad-button--icon"
        title={
          canUndo ? currentCommandLabel('history.undo', shortcutAssignments, documentKind) : t('toolbar.history.undoUnavailable')
        }
        aria-label={t('toolbar.history.undo')}
        aria-disabled={!canUndo}
        data-command-id="history.undo"
        onClick={() => {
          executeCommand('history.undo');
        }}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        className="pcad-button pcad-button--icon"
        title={
          canRedo ? currentCommandLabel('history.redo', shortcutAssignments, documentKind) : t('toolbar.history.redoUnavailable')
        }
        aria-label={t('toolbar.history.redo')}
        aria-disabled={!canRedo}
        data-command-id="history.redo"
        onClick={() => {
          executeCommand('history.redo');
        }}
      >
        <RedoIcon />
      </button>

    </div>
  );
}
