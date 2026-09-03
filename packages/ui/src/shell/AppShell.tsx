import { lazy, Suspense, useEffect, useRef } from 'react';

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
 * 文字を打っている最中かどうか。式の欄や名前の欄で Ctrl+Z を押したときは、
 * 打った文字の取り消し(ブラウザの働き)を邪魔しない(NFR-UX-3)。
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
  const featureCount = useAppStore((state) => state.sketch.features.length);
  const viewportSize = useAppStore((state) => state.viewportSize);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  const fileName = useAppStore((state) => state.fileName);
  // 真偽で取り出すので、文書が変わっても「保存していない」かどうかが変わったときだけ
  // 描き直す(打つたびに画面全体を作り直さない、NFR-PF-1)。
  const unsaved = useAppStore((state) => hasUnsavedChanges(state.document, state.savedDocument));
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
     * 窓のどこにいても効くように window で受ける。文字を打っている最中は横取りしない。
     *
     * Ctrl+N はブラウザ自身が新しい窓を開く操作に割り当てていて、頁の側からは
     * 止められないことがある。そのときはツールバーの「新規」を使う(デスクトップ版では効く)。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || isTextEntry(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      const store = useAppStore.getState();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        store.undo();
        return;
      }
      // やり直すは Ctrl+Y と Ctrl+Shift+Z のどちらでも効かせる(どちらの流儀にも合わせる)。
      if (key === 'y' || (key === 'z' && event.shiftKey)) {
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
          {isComputing ? (
            /* 計算中は中央に札を出す。空状態の案内とは同時に出さない。 */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card">
                <span className="pcad-spinner" aria-hidden="true" />
                <span>{t('statusBar.loading')}</span>
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
