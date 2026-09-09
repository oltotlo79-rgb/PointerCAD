import { lazy, Suspense, useEffect, useRef } from 'react';

import {
  discardAutoSave,
  exportAutoSave,
  formatSavedAt,
  restoreAutoSave,
} from '../file/attachAutoSave.js';
import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { ImportUnitPanel } from '../file/ImportUnitPanel.js';
import {
  createDefaultPartFileDeps,
  newPart,
  openPart,
  savePart,
  windowTitle,
} from '../file/partFile.js';
import { t } from '../i18n/t.js';
import {
  DrawingPropertyPanel,
  DrawingStatusBar,
  DrawingToolbar,
  DrawingTree,
  DrawingViewport,
} from '../drawing/DrawingWorkspace.js';
import { PlaceComponentPopover } from '../assembly/PlaceComponentPopover.js';
import { AssemblyMotionControls } from '../assembly/AssemblyMotionControls.js';
import { AssemblyInterferencePanel } from '../assembly/AssemblyInterferencePanel.js';
import { StandardPartPicker } from '../assembly/StandardPartPickerPanel.js';
import { AssemblyPropertyPanel } from '../assembly/AssemblyPropertyPanel.js';
import { ExplodePopover } from '../assembly/ExplodePopover.js';
import { ReplacementPopover } from '../assembly/ReplacementPopover.js';
import { ConstraintValuePopover } from '../sketch/ConstraintValuePopover.js';
import { NumericInputPopover } from '../sketch/NumericInputPopover.js';
import type { SelectionKind } from '../solid/subShapeSelection.js';
import { activeDocumentKind, activeFileName } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { AssemblyTree } from './AssemblyTree.js';
import { FeatureTree } from './FeatureTree.js';
import { PlotPointIcon } from './icons.js';
import { PropertyPanel } from './PropertyPanel.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';

/**
 * 3D 表示は three.js を伴って重いので、画面の枠より後から読み込む(NFR-PF-5)。
 * 名前付き輸出を default へ包み直すのは、lazy が default 輸出だけを受け取るため。
 */
const ViewportCanvas = lazy(async () => {
  const viewportModule = await import('../viewport/ViewportCanvas.js');
  return { default: viewportModule.ViewportCanvas };
});

/**
 * 文字を打っている最中かどうか。式の欄や名前の欄で Ctrl+Z / Ctrl+Y を押したときは、
 * 打った文字の取り消し(ブラウザの働き)を邪魔しない(NFR-UX-3)。ファイル系の
 * ショートカット(Ctrl+S 等)はここを見ない(§0.a-0.23 ⑪)。
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/**
 * `Space` が「押す」意味を持つ相手か(FR-208、P4b タスク18)。
 *
 * ボタン・スイッチ・一覧の項目に焦点があるとき、`Space` はブラウザの決まりで「押す」操作に
 * なる(その場入力のつまみの入切もこれに当たる)。コマンドラインの欄へ入る `Space`
 * (§0.a-0.10 の③)は**ビューポートに焦点があるとき**のものなので、こういう相手からは
 * 横取りしない。横取りすると、いまあるボタンの操作が 1 つ変わってしまう。
 */
function activatedBySpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.closest(
      'button, select, summary, a[href], [role="switch"], [role="menuitem"], [role="option"], [role="tab"]',
    ) !== null
  );
}

/**
 * 畳んだ一覧(ツールバー・プロパティ欄)の中に焦点があるか(P5 タスク32)。
 *
 * 一覧が開いているあいだの Esc は「一覧を閉じる」ための押下(`ToolMenu` / `PlaneMenu` が
 * 自分で受ける)なので、測定の結果を消す Esc はそれを横取りしない。
 */
function isInsideMenu(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.pcad-menu') !== null;
}

/**
 * 選択の種類の手動切替(§0.a-0.6、タスク26)。`1` = 頂点、`2` = 辺、`3` = 面、`4` = 立体。
 * 数字キーそのものを使うので、修飾キー付き(Ctrl+1 等、将来ブラウザやOSの割当と衝突し得る)
 * とは区別する。
 */
const SELECTION_KIND_SHORTCUTS: Readonly<Record<string, SelectionKind>> = {
  '1': 'vertex',
  '2': 'edge',
  '3': 'face',
  '4': 'body',
};

/**
 * 画面の5区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)。
 * 区画は増やさない(rules/04-設計の規律.md、要件§7.1)。
 *
 * **アセンブリを開くと、区画の数はそのままで中身だけが入れ替わる**(P7 §0.a-0.10。
 * タブを増やさない)。どちらを開いているかの判定は `store/documentKind.ts` の
 * `activeDocumentKind` 1 か所にあり、ここはその答えで分けるだけにする。
 */
export function AppShell(): React.JSX.Element {
  /*
   * いま開いている文書の種類(P7 §0.a-0.10、タスク5)。文字列で取り出すので、
   * 部品を編集しているあいだは何度文書が変わっても値が変わらず、描き直しも起きない
   * (NFR-PF-1)。木・ツールバー・プロパティの中身の入れ替えは以後の段が足す。
   */
  const documentKind = useAppStore(activeDocumentKind);
  const isComputing = useAppStore((state) => state.isComputing);
  // 幾何カーネルをまだ読み込み終えていないか(§0.a-0.23 ⑨)。初回の計算中だけ帯と札の
  // 文言を分け、固まったように見えないようにする。
  const kernelLoaded = useAppStore((state) => state.kernelLoaded);
  /*
   * 最初の一歩の案内(NFR-UX-6)を出すかどうか。**部品まるごとが空のときだけ**出す。
   * 編集中のスケッチの要素数だけで決めていた頃は、立体を作ったあとに新しいスケッチを
   * 足した瞬間(P4 仕上げ (g))に、画面に立体があるのに「点をプロットして最初の形を
   * 作りましょう」と出てしまっていた。真偽で取り出すので、空でなくなった瞬間にだけ
   * 描き直す(NFR-PF-1)。
   */
  const isEmptyPart = useAppStore(
    (state) =>
      // アセンブリを開いているあいだは部品の案内を出さない(P7 タスク5)。
      activeDocumentKind(state) === 'part' &&
      state.document.solids.length === 0 &&
      state.document.references.length === 0 &&
      state.document.sketches.every((sketch) => sketch.features.length === 0),
  );
  /*
   * アセンブリ版の最初の一歩の案内(NFR-UX-6、P7 タスク5)。部品を 1 つも置いていない
   * アセンブリを開いているときだけ出す。部品側とまったく同じ作りで、区画は増やさない。
   */
  const isEmptyAssembly = useAppStore(
    (state) => state.assembly !== null && state.assembly.components.length === 0,
  );
  const viewportSize = useAppStore((state) => state.viewportSize);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  const fileName = useAppStore(activeFileName);
  // 真偽で取り出すので、文書が変わっても「保存していない」かどうかが変わったときだけ
  // 描き直す(打つたびに画面全体を作り直さない、NFR-PF-1)。
  const unsaved = useAppStore(activeHasUnsavedChanges);
  // 復元の案内(FR-805、§0.a-0.12)。控えを書く人がいないうちは押しても何もできないので、
  // 2 つが揃っているときだけカードを出す。
  const restorePrompt = useAppStore((state) => state.restorePrompt);
  const recoveryKind = useAppStore((state) => state.recoveryRecord?.kind);
  const autoSaver = useAppStore((state) => state.autoSaver);
  // 読み込んだファイルの単位を訊いている最中か(FR-811、§0.a-0.6、P6 タスク32b)。
  const importUnitAsked = useAppStore((state) => state.importUnitAsked);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) {
      return;
    }
    // ビューポートの実寸はストアへ入れる。ツールバーもポップアップもここから読み、
    // DOM を直接探しに行かない(rules/04-設計の規律.md「状態はストア1本」)。
    const report = (): void => {
      useAppStore.getState().setViewportSize([element.clientWidth, element.clientHeight]);
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    /*
     * 元に戻す・やり直す(FR-505、§0.a-0.13)とファイルの操作(FR-806、§2.11)。
     * 窓のどこにいても効くように window で受ける。
     *
     * 元に戻す・やり直すだけは、文字を打っている最中は横取りしない(§0.a-0.23 ⑪)。
     * ファイル系の 4 つ(保存・名前を付けて保存・開く・新規)は入力欄に焦点があっても
     * 効かせる(式の欄を編集中でも保存できるのが利用者の期待、NFR-UX-7)。
     *
     * Ctrl+N はブラウザ自身が新しい窓を開く操作に割り当てていて、頁の側からは
     * 止められないことがある。そのときはツールバーの「新規」を使う(デスクトップ版では効く)。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (activeDocumentKind(useAppStore.getState()) === 'drawing') {
        return;
      }
      /*
       * 選択の種類の手動切替(§0.a-0.6、§2.11「選択の種類の切替」)。修飾キーなしの
       * 1/2/3/4 だけを見るので、Ctrl 系の分岐(この下)より前に置く。文字入力中
       * (式の欄・名前の欄)は横取りしない(NFR-UX-3、isTextEntry と同じ判断)。
       */
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !isTextEntry(event.target)
      ) {
        const kind = SELECTION_KIND_SHORTCUTS[event.key];
        if (kind !== undefined) {
          event.preventDefault();
          useAppStore.getState().setSelectionKind(kind);
          return;
        }
        /*
         * コマンドラインの欄へ入る(FR-208、§0.a-0.10 の③)。`Space` は P0〜P4 のどこにも
         * 割り当てが無いことを Grep で確かめてある(その場入力のつまみの入切だけが Space を
         * 使うが、あれはポップアップの中(`NumericInputPopover.tsx`)で止まるのでここへ来ない)。
         *
         * **文字を打っている最中は横取りしない**(上の `isTextEntry`)。式の欄で空白が
         * 打てなくなり、コマンドラインの欄そのものでも空白が打てなくなるため。
         * 欄から出るのは `Esc`(欄の中で受ける。`CommandLine.tsx`)。
         */
        if (event.key === ' ' && !activatedBySpace(event.target)) {
          event.preventDefault();
          useAppStore.getState().requestCommandLineFocus();
          return;
        }
      }
      if (!event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      const store = useAppStore.getState();
      // 元に戻す・やり直すだけは、文字を打っている最中は横取りしない(式の欄の中の
      // 取り消しというブラウザの働きを邪魔しないため、§0.a-0.23 ⑪)。ファイル系の
      // 4 つ(保存・名前を付けて保存・開く・新規)は焦点に関係なく効かせる
      // (式の途中でも保存できるのが利用者の期待)。
      if (key === 'z' && !event.shiftKey) {
        if (isTextEntry(event.target)) {
          return;
        }
        event.preventDefault();
        store.undo();
        return;
      }
      // やり直すは Ctrl+Y と Ctrl+Shift+Z のどちらでも効かせる(どちらの流儀にも合わせる)。
      if (key === 'y' || (key === 'z' && event.shiftKey)) {
        if (isTextEntry(event.target)) {
          return;
        }
        event.preventDefault();
        store.redo();
        return;
      }
      // 保存は Ctrl+S、名前を付けて保存は Ctrl+Shift+S。
      if (key === 's') {
        event.preventDefault();
        void savePart(createDefaultPartFileDeps(), event.shiftKey);
        return;
      }
      if (key === 'o' && !event.shiftKey) {
        event.preventDefault();
        void openPart(createDefaultPartFileDeps());
        return;
      }
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        void newPart(createDefaultPartFileDeps());
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    /*
     * Esc で測定の結果を消す(FR-1102、§0.a-0.68、P5 タスク32)。
     *
     * **捕捉の段(capture)で受ける。** Esc はビューポート(`attachSketchInteraction`)でも
     * 「選択と取りかけの取り消し」に使われていて、そちらは canvas に付いているので普通に
     * 待つと先に走ってしまう。測定の結果が出ているときは**先にそれを消す**(統括の決定
     * 2026-09-05 13:19)ので、捕捉の段で受けて `stopPropagation` でその 1 回を止める。
     * 何も測っていなければ `clearMeasurement` は何もせず、`cleared` が偽になるので、
     * これまでどおり道具の取り消しへそのまま流れる。
     *
     * 畳んだ一覧が開いているとき(`.pcad-menu` の中に焦点がある)は横取りしない。
     * その Esc は「一覧を閉じる」ための押下で、測定とは関係がないため。
     */
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isTextEntry(event.target) || isInsideMenu(event.target)) {
        return;
      }
      const store = useAppStore.getState();
      if (store.measurement === null && store.massProperties === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      store.clearMeasurement();
    };
    globalThis.addEventListener('keydown', onEscape, true);
    return () => {
      globalThis.removeEventListener('keydown', onEscape, true);
    };
  }, []);

  useEffect(() => {
    // 窓の見出しに、開いているファイル名と保存していない印を出す(FR-806、NFR-UX-7)。
    globalThis.document.title = windowTitle(fileName, unsaved);
  }, [fileName, unsaved]);

  return (
    /*
      いま開いている文書の種類を根の要素へ書く(P7 §0.a-0.10、タスク5)。区画は 5 つの
      ままで、種類ごとの見た目の違いはこの 1 つの札から CSS で決める(区画を増やさない、
      rules/04-設計の規律.md)。E2E もここを見れば、どちらの画面が出ているかを判定できる。
    */
    <div className="pcad-shell" data-document-kind={documentKind}>
      {documentKind === 'drawing' ? <DrawingToolbar /> : <Toolbar />}
      <div className="pcad-shell__body">
        {/*
          左のモデルブラウザ。**区画は増やさず、開いている文書の種類で中身だけを入れ替える**
          (P7 §0.a-0.10、タスク9)。部品なら履歴の木、アセンブリなら部品・合致・
          ジョイント・分解ステップの 4 つの束が同じ場所に出る。
        */}
        {documentKind === 'drawing' ? (
          <DrawingTree />
        ) : documentKind === 'assembly' ? (
          <AssemblyTree />
        ) : (
          <FeatureTree />
        )}
        <div className="pcad-viewport" ref={viewportRef}>
          {documentKind === 'drawing' ? (
            <DrawingViewport />
          ) : (
            <Suspense
              fallback={
                <div className="pcad-viewport__overlay">
                  <div className="pcad-card">
                    <span className="pcad-spinner" aria-hidden="true" />
                    <span>{t('viewport.loading')}</span>
                  </div>
                </div>
              }
            >
              <ViewportCanvas />
            </Suspense>
          )}
          {documentKind === 'drawing' ? null : importUnitAsked ? (
            /*
              読み込んだファイルの単位を訊く小窓(§0.a-0.6、タスク32b)。**この問いは
              読み込みを止めて待っている**ので、控えの案内や計算中の札より先に出す
              (答えるまで読み込みが進まないため、隠れていると操作が止まって見える)。
            */
            <div className="pcad-viewport__overlay">
              <ImportUnitPanel />
            </div>
          ) : restorePrompt !== null && autoSaver !== null ? (
            /*
              前回の作業の控えがあるときの案内(FR-805、§0.a-0.12)。中央に置くが
              モーダルにしない。背後の操作は止めず、Esc でも閉じない(誤って控えを
              失わないため、閉じるのは「復元する」「破棄する」を押したときだけ)。
              計算中の札・空状態の案内とは同時に出さない。
            */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card pcad-restore">
                <p className="pcad-restore__title">
                  {t(restorePrompt.unrecoverable ? 'restore.unrecoverableTitle' :
                    recoveryKind === 'assembly' ? 'assembly.restoreTitle' : 'restore.title')}
                </p>
                {/*
                  カードが出ている間に何か描き始めた(= 未保存の変更がある)ら、
                  復元すると消えてしまう旨へ文言を切り替える(§0.a-0.23 ⑤、19:10 の残件(c))。
                */}
                <p className="pcad-restore__body">
                  {t(
                    restorePrompt.unrecoverable
                      ? 'restore.unrecoverableBody'
                      : unsaved
                        ? 'restore.bodyDirty'
                        : 'restore.body',
                  )}
                </p>
                <dl className="pcad-restore__details">
                  <dt>{t('restore.savedAt')}</dt>
                  <dd>{formatSavedAt(restorePrompt.savedAt)}</dd>
                  <dt>{t('restore.documentName')}</dt>
                  <dd>{restorePrompt.documentName}</dd>
                  {restorePrompt.unrecoverable && restorePrompt.reasonKey !== undefined ? (
                    <>
                      <dt>{t('restore.reason')}</dt>
                      <dd>{t(restorePrompt.reasonKey)}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="pcad-restore__actions">
                  {restorePrompt.unrecoverable ? (
                    <button
                      type="button"
                      className="pcad-button pcad-button--action pcad-button--primary"
                      onClick={() => {
                        void exportAutoSave(autoSaver);
                      }}
                    >
                      {t('restore.export')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pcad-button pcad-button--action pcad-button--primary"
                      onClick={() => {
                        void restoreAutoSave(autoSaver);
                      }}
                    >
                      {t('restore.restore')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="pcad-button pcad-button--action"
                    onClick={() => {
                      void discardAutoSave(autoSaver);
                    }}
                  >
                    {t('restore.discard')}
                  </button>
                </div>
              </div>
            </div>
          ) : isComputing ? (
            /*
              計算中は中央に札を出す。空状態の案内とは同時に出さない。初回だけ
              幾何カーネル(約 50MB)の読み込みを含むので文言を分ける(§0.a-0.23 ⑨)。
              帯(StatusBar)側の同じ分岐は statusText.ts の describeStatus が持つ。
            */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card">
                <span className="pcad-spinner" aria-hidden="true" />
                <span>{t(kernelLoaded ? 'statusBar.loading' : 'statusBar.loadingKernel')}</span>
              </div>
            </div>
          ) : isEmptyPart ? (
            /* 計算が終わって、まだ何もかいていないときだけ最初の一歩を案内する(NFR-UX-6)。 */
            <div className="pcad-viewport__empty-state">
              <PlotPointIcon size={18} />
              <p className="pcad-viewport__empty-text">{t('emptyState.firstStep')}</p>
            </div>
          ) : isEmptyAssembly ? (
            /* まだ部品を 1 つも置いていないアセンブリ(P7 タスク5)。案内の作りは部品側と同じ。 */
            <div className="pcad-viewport__empty-state">
              <PlotPointIcon size={18} />
              <p className="pcad-viewport__empty-text">{t('assembly.emptyState')}</p>
            </div>
          ) : null}
          {/*
            その場数値入力(NFR-UX-2)。開いているときだけ自分で姿を現す。
            決まった値から何を履歴へ積むかは純関数 commitSketchInput が決め、
            決まった 1 手をストアへ反映するのは commitToStore.ts の applyNumericTransition
            (ポップアップとコマンドラインの共通の入口。P4b タスク18 でここから移した)。
          */}
          {documentKind === 'assembly' ? (
            <>
              <PlaceComponentPopover />
              <StandardPartPicker />
              <ExplodePopover />
              <ReplacementPopover />
              <AssemblyMotionControls />
              <AssemblyInterferencePanel />
            </>
          ) : documentKind === 'part' ? (
            <NumericInputPopover
              viewportWidth={viewportSize[0]}
              viewportHeight={viewportSize[1]}
            />
          ) : null}
          {/*
            寸法拘束(距離・角度・半径・直径)の値をその場で聞く小さな入力
            (FR-313、NFR-UX-2、P4b タスク13)。道具のその場入力と同じ見た目・同じ操作で、
            聞くのは式 1 つだけ。開いているときだけ自分で姿を現す。
          */}
          {documentKind === 'part' ? <ConstraintValuePopover /> : null}
          {documentKind !== 'part' || snapIndicator === null ? null : (
            /* 吸い付いている場所の印(FR-107)。 */
            <span
              className="pcad-snap-marker"
              style={{
                left: `${String(snapIndicator.screen[0])}px`,
                top: `${String(snapIndicator.screen[1])}px`,
              }}
              aria-hidden="true"
            />
          )}
        </div>
        {documentKind === 'drawing' ? (
          <DrawingPropertyPanel />
        ) : documentKind === 'assembly' ? (
          <AssemblyPropertyPanel />
        ) : (
          <PropertyPanel />
        )}
      </div>
      {documentKind === 'drawing' ? <DrawingStatusBar /> : <StatusBar />}
    </div>
  );
}
