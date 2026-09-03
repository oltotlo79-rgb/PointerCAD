import { lazy, Suspense, useEffect, useRef } from 'react';

import { discardAutoSave, formatSavedAt, restoreAutoSave } from '../file/attachAutoSave.js';
import {
  createDefaultPartFileDeps,
  hasUnsavedChanges,
  newPart,
  openPart,
  savePart,
  windowTitle,
} from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { NumericInputPopover } from '../sketch/NumericInputPopover.js';
import { commitSketchInput } from '../sketch/sketchCommands.js';
import { commitSolidInput } from '../solid/solidCommands.js';
import { useAppStore } from '../store/useAppStore.js';
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
 * 画面の5区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)。
 * 区画は増やさない(rules/04-設計の規律.md、要件§7.1)。
 */
export function AppShell(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  // 幾何カーネルをまだ読み込み終えていないか(§0.a-0.23 ⑨)。初回の計算中だけ帯と札の
  // 文言を分け、固まったように見えないようにする。
  const kernelLoaded = useAppStore((state) => state.kernelLoaded);
  const featureCount = useAppStore((state) => state.sketch.features.length);
  const viewportSize = useAppStore((state) => state.viewportSize);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  const fileName = useAppStore((state) => state.fileName);
  // 真偽で取り出すので、文書が変わっても「保存していない」かどうかが変わったときだけ
  // 描き直す(打つたびに画面全体を作り直さない、NFR-PF-1)。
  const unsaved = useAppStore((state) => hasUnsavedChanges(state.document, state.savedDocument));
  // 復元の案内(FR-805、§0.a-0.12)。控えを書く人がいないうちは押しても何もできないので、
  // 2 つが揃っているときだけカードを出す。
  const restorePrompt = useAppStore((state) => state.restorePrompt);
  const autoSaver = useAppStore((state) => state.autoSaver);
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
    // 窓の見出しに、開いているファイル名と保存していない印を出す(FR-806、NFR-UX-7)。
    globalThis.document.title = windowTitle(fileName, unsaved);
  }, [fileName, unsaved]);

  return (
    <div className="pcad-shell">
      <Toolbar />
      <div className="pcad-shell__body">
        <FeatureTree />
        <div className="pcad-viewport" ref={viewportRef}>
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
          {restorePrompt !== null && autoSaver !== null ? (
            /*
              前回の作業の控えがあるときの案内(FR-805、§0.a-0.12)。中央に置くが
              モーダルにしない。背後の操作は止めず、Esc でも閉じない(誤って控えを
              失わないため、閉じるのは「復元する」「破棄する」を押したときだけ)。
              計算中の札・空状態の案内とは同時に出さない。
            */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card pcad-restore">
                <p className="pcad-restore__title">{t('restore.title')}</p>
                {/*
                  カードが出ている間に何か描き始めた(= 未保存の変更がある)ら、
                  復元すると消えてしまう旨へ文言を切り替える(§0.a-0.23 ⑤、19:10 の残件(c))。
                */}
                <p className="pcad-restore__body">
                  {t(unsaved ? 'restore.bodyDirty' : 'restore.body')}
                </p>
                <dl className="pcad-restore__details">
                  <dt>{t('restore.savedAt')}</dt>
                  <dd>{formatSavedAt(restorePrompt.savedAt)}</dd>
                  <dt>{t('restore.documentName')}</dt>
                  <dd>{restorePrompt.documentName}</dd>
                </dl>
                <div className="pcad-restore__actions">
                  <button
                    type="button"
                    className="pcad-button pcad-button--action pcad-button--primary"
                    onClick={() => {
                      void restoreAutoSave(autoSaver);
                    }}
                  >
                    {t('restore.restore')}
                  </button>
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
          ) : featureCount === 0 ? (
            /* 計算が終わって、まだ何もかいていないときだけ最初の一歩を案内する(NFR-UX-6)。 */
            <div className="pcad-viewport__empty-state">
              <PlotPointIcon size={18} />
              <p className="pcad-viewport__empty-text">{t('emptyState.firstStep')}</p>
            </div>
          ) : null}
          {/*
            その場数値入力(NFR-UX-2)。開いているときだけ自分で姿を現す。
            決まった値から何を履歴へ積むかは純関数 commitSketchInput が決め、
            次に何を聞くか・閉じるかはポップアップ自身が決める(FR-307)。
          */}
          <NumericInputPopover
            viewportWidth={viewportSize[0]}
            viewportHeight={viewportSize[1]}
            onCommit={(commit) => {
              const store = useAppStore.getState();
              const outcome = commitSketchInput(commit, {
                document: store.sketch,
                planeId: store.workPlaneId,
                chaining: store.chaining,
                pendingStart: store.pendingStart,
              });
              if (outcome.document !== store.sketch) {
                store.setSketch(outcome.document);
              }
              store.setPendingStart(outcome.pendingStart);
            }}
            onSolidCommit={(commit) => {
              /*
                立体を1つ作って部品文書へ積む(FR-401〜403)。何を作るかは純関数
                commitSolidInput が決め、断られたら理由を帯へ出して履歴は変えない
                (FR-504、NFR-UX-5)。作れたらその立体を選び、道具は選択へ戻す。
              */
              const store = useAppStore.getState();
              const outcome = commitSolidInput(store.document, store.selection, commit);
              if (!outcome.ok) {
                store.setSolidError(outcome.reasonKey);
                return;
              }
              store.applyDocument(outcome.document);
              store.setSelection([outcome.featureId]);
              store.setActiveTool('select');
            }}
          />
          {snapIndicator === null ? null : (
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
        <PropertyPanel />
      </div>
      <StatusBar />
    </div>
  );
}
