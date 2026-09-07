/**
 * 「ファイル」の区画の配線(FR-806、FR-812、FR-814、FR-807。P6 §0.57、タスク31・33)。
 *
 * 画面の組み立て(`Toolbar.tsx`)から**押したときに何が起きるか**を分けてある。
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { DEFAULT_TOOL_DEFAULTS } from '@pointercad/model';
import { useEffect, useRef } from 'react';
import { activeHasUnsavedChanges, newAssembly } from '../../file/assemblyFile.js';
import { createExchangeDeps, importFile } from '../../file/exchangeActions.js';
import { exportBaseNameOf } from '../../file/exchangeFile.js';
import { ExchangePanel } from '../../file/ExchangePanel.js';
import { hasFileSystemAccess, PCAD_EXTENSION } from '../../file/fileGateway.js';
import {
  createDefaultPartFileDeps,
  displayFileName,
  newPart,
  openPart,
  savePart,
  type PartFileDeps,
} from '../../file/partFile.js';
import {
  browserPrintOf,
  desktopPrintOf,
  formatPrintedAt,
  mountPrintSheetIn,
  printViewport,
} from '../../file/printView.js';
import {
  createIndexedDbTemplateStorage,
  newFromTemplate,
  saveTemplate,
  sortTemplates,
  type TemplateDeps,
  type TemplateSource,
} from '../../file/templateFile.js';
import { type MessageKey, t } from '../../i18n/t.js';
import { useAppStore } from '../../store/useAppStore.js';
import { NewFileIcon, OpenFileIcon, SaveIcon } from '../icons.js';
import {
  type FileMenuActionId,
  type FileMenuItemId,
  isRecentFileMenuId,
  isStoredTemplateMenuId,
  type NamedMenuEntry,
  storedTemplateIdOf,
} from '../toolbarMenus.js';
import { type ButtonEntry, TOOLTIP_LINE_BREAK } from './toolbarShared.js';

/**
 * ファイルの操作(FR-806)。図柄だけのボタンで、名前は読み上げ名とツールチップが担う。
 *
 * ボタンは 3 つのまま増やさない(§0.a-0.15)。「名前を付けて保存」は保存ボタンを
 * Shift を押しながら押すか、Ctrl+Shift+S で行う。その旨はツールチップに書く(NFR-UX-7)。
 */
export const FILE_ACTIONS = [
  {
    id: 'new',
    labelKey: 'toolbar.file.new',
    tooltipKey: 'toolbar.file.newTooltip',
    Icon: NewFileIcon,
  },
  {
    id: 'open',
    labelKey: 'toolbar.file.open',
    tooltipKey: 'toolbar.file.openTooltip',
    Icon: OpenFileIcon,
  },
  {
    id: 'save',
    labelKey: 'toolbar.file.save',
    tooltipKey: 'toolbar.file.saveTooltip',
    Icon: SaveIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: FileActionId })[];

/** ファイルのボタン 3 つ。 */
type FileActionId = 'new' | 'open' | 'save';

/**
 * ファイルのボタンのツールチップ。保存のときは「名前を付けて保存」の出し方も添える。
 * 場所を選べない環境(File System Access API の無いブラウザ)では、ダウンロードで
 * 保存されることも添える(NFR-UX-5「できないことは理由とともに」)。
 */
export function fileTooltip(id: FileActionId, tooltipKey: MessageKey): string {
  if (id !== 'save') {
    return t(tooltipKey);
  }
  const lines = [t(tooltipKey), t('toolbar.file.saveAsHint')];
  if (!hasFileSystemAccess()) {
    lines.push(t('file.fsaUnavailable'));
  }
  return lines.join(TOOLTIP_LINE_BREAK);
}

/**
 * ファイルのボタンを押したときの処理(FR-806)。
 * 保存は Shift を押しながらだと「名前を付けて保存」になる(ボタンを増やさないため)。
 */
export function runFileAction(id: FileActionId, saveAs: boolean): void {
  const deps = createDefaultPartFileDeps();
  switch (id) {
    case 'new':
      void newPart(deps);
      return;
    case 'open':
      void openPart(deps);
      return;
    case 'save':
      void savePart(deps, saveAs);
      return;
  }
}

/** 部品・アセンブリのどちらからでも、既存の確認と保存先初期化を通って空の組立を始める。 */
export function runNewAssembly(deps: PartFileDeps = createDefaultPartFileDeps()): Promise<void> {
  return newAssembly(deps);
}

// ---------------------------------------------------------------------------
// ひな形・印刷・最近使ったファイル(FR-807、FR-810、FR-814。P6 タスク33)
// ---------------------------------------------------------------------------

/**
 * ひな形の手続きが要る口一式(`createExchangeDeps` と同じ役目)。
 *
 * 置き場は**ブラウザの中**にする(§0.a-0.36 の承認)。デスクトップ版も同じ口を使うので、
 * 「ひな形として保存」「ひな形から新規」の操作は Web 版とまったく同じになる(要件§1.5)。
 * ファイル(`.pcadt`)にも書けるので、環境をまたいで持ち運べる。
 */
function createTemplateDeps(): TemplateDeps {
  return {
    gateway: useAppStore.getState().fileGateway,
    storage: createIndexedDbTemplateStorage(),
  };
}

/** 置き場に残っているひな形を、一覧に出す形(新しい順)で読む。 */
export async function loadTemplateEntries(): Promise<readonly NamedMenuEntry[]> {
  const stored = await createTemplateDeps().storage.list();
  return sortTemplates(stored).map((entry) => ({ id: entry.id, name: entry.name }));
}

/**
 * ひな形に付ける名前。ファイルの名前から `.pcad` を落としたもの。
 *
 * 拡張子を残すと一覧に「歯車.pcad」と並び、部品のファイルなのかひな形なのかが
 * 読み取れなくなる。まだ一度も保存していないときは空を返し、`saveTemplate` が
 * 部品の名前(「部品1」)へ落とす——名前を決める規則を 2 か所に書かないため。
 */
function templateNameOf(fileName: string | null): string {
  const trimmed = (fileName ?? '').trim();
  return trimmed.toLowerCase().endsWith(PCAD_EXTENSION)
    ? trimmed.slice(0, trimmed.length - PCAD_EXTENSION.length)
    : trimmed;
}

/**
 * いまの部品をひな形として保存する(FR-814)。
 *
 * 名前は開いているファイルの名前(まだ保存していなければ部品の名前)を使う。
 * **道具の既定値は今のところ既定のまま**で持ち運ぶ——利用者が既定値を変えられるように
 * するのは P12 の環境設定(FR-1104)で、それまでは変わりようがないためである。
 */
async function runSaveAsTemplate(): Promise<void> {
  const state = useAppStore.getState();
  const outcome = await saveTemplate(createTemplateDeps(), {
    document: state.document,
    lengthUnit: state.displaySettings.lengthUnit,
    toolDefaults: DEFAULT_TOOL_DEFAULTS,
    name: templateNameOf(state.fileName),
  });
  useAppStore
    .getState()
    .setFileMessage(
      outcome.ok
        ? { key: 'template.saved', failed: false }
        : { key: outcome.messageKey, failed: true },
    );
}

/**
 * ひな形から新しい部品を始める(FR-814、§2.10)。
 *
 * **失うものがあれば先に確認する**(NFR-UX-3。「新規」と同じ確認)。読み切れたときだけ
 * 差し替えるので、断られた場合はいまの部品を触らない(NFR-RE-1)。
 *
 * 差し替えの順は「単位 → 文書 → ファイルの名前」。単位は文書の欄ではない(§0.a-0.1)ので
 * 先に配り、**再計算が走るのは `resetDocument` の 1 回だけ**にする。
 */
async function runNewFromTemplate(source: TemplateSource): Promise<void> {
  const before = useAppStore.getState();
  if (
    activeHasUnsavedChanges(before) &&
    !(await createDefaultPartFileDeps().confirmDiscard('file.discardConfirm'))
  ) {
    return;
  }
  const outcome = await newFromTemplate(createTemplateDeps(), source);
  const store = useAppStore.getState();
  if (!outcome.ok) {
    if ('cancelled' in outcome) {
      // 窓を取り消した。何も起きなかったので断りも出さない。
      return;
    }
    store.setFileMessage({
      key: 'missing' in outcome ? 'template.missing' : outcome.messageKey,
      failed: true,
    });
    return;
  }
  store.setDisplaySettings({ ...store.displaySettings, lengthUnit: outcome.lengthUnit });
  // 履歴のスタックごと作り直す(ひな形から始めた前へは戻れない。「新規」と同じ)。
  store.resetDocument(outcome.document);
  store.setFileState(null, null);
  if (outcome.notice !== null) {
    // 形の入ったひな形だった。断りではないので、そのまま開いたうえで 1 行知らせる(§2.10)。
    useAppStore.getState().setFileMessage({ key: 'template.hasHistory', failed: false });
  }
}

/**
 * いま見えている 1 コマを印刷する(FR-810、FR-908、§2.11)。
 *
 * デスクトップ版は口(`FileGateway.print`)へ渡し、Web 版は紙面を足して `window.print()`。
 * **絵を作る口はビューポートが差し出した `capturePrintFrame`**(白い下地・長辺 2000)で、
 * サムネイルの口は使わない(FR-908)。
 */
async function runPrint(): Promise<void> {
  const state = useAppStore.getState();
  const capture = state.capturePrintFrame;
  const outcome = await printViewport(
    {
      title: displayFileName(state.fileName),
      printedAt: formatPrintedAt(new Date()),
    },
    {
      // まだ 3D 表示部が読み込まれていないときは口が空。断りの文言は `printViewport` が持つ。
      capture: capture === null ? (): null => null : capture,
      printOnDesktop: desktopPrintOf(state.fileGateway),
      mount: mountPrintSheetIn(),
      print: browserPrintOf(),
    },
  );
  if (outcome.status === 'refused') {
    // 断りだけは伝える。取り消し(利用者がやめた)と成功は何も出さない(NFR-UX-3)。
    useAppStore.getState().setError(outcome.message);
  }
}

/**
 * 「ファイル」の畳んだ一覧から選んだときの処理(FR-812、P6 §0.57、タスク31・32・33)。
 *
 * 決まった操作は `FileMenuActionId` を網羅する `switch` にしてあるのが要点で、
 * **配線を書かずに一覧へ行を足すと型検査が落ちる**(押しても何も起きない行を画面に
 * 出さないための仕掛け)。数の決まらない行(保存したひな形・最近使ったファイル)は
 * 接頭辞で見分けてから、同じ 1 か所で配る。
 *
 * **書き出しだけがパネルを開く**(形式・対象・なめらかさを訊くため。§0.a-0.20)ので、
 * 開く手立てを引数で受ける。読み込みは訊くことが無い(窓でファイルを選ぶだけ)ので、
 * ここから直に走らせる。
 */
export function runFileMenuAction(
  id: FileMenuItemId,
  openExportPanel: () => void,
  onTemplatesChanged: () => void,
): void {
  if (isStoredTemplateMenuId(id)) {
    void runNewFromTemplate({ from: 'stored', id: storedTemplateIdOf(id) });
    return;
  }
  if (isRecentFileMenuId(id)) {
    /*
     * 最近使ったファイル(FR-807、§0.a-0.38)。**その場では開かない。**
     * 覚えているのは名前だけで場所は持たない(NFR-SE-1)ので、できるのは「開く」の窓を
     * 出すところまでである。窓へ名前を初期値として渡す口は今の `openPcad` に無いので、
     * 「開く」をそのまま呼ぶ(口を広げるとデスクトップ版の窓にも手が要る)。
     */
    void openPart(createDefaultPartFileDeps());
    return;
  }
  runFileMenuActionId(id, openExportPanel, onTemplatesChanged);
}

/** 決まった操作の配り先(網羅 `switch`。行を足すと型検査がここを落とす)。 */
function runFileMenuActionId(
  id: FileMenuActionId,
  openExportPanel: () => void,
  onTemplatesChanged: () => void,
): void {
  switch (id) {
    case 'newAssembly':
      void runNewAssembly();
      return;
    case 'saveAs':
      // 保存ボタンを Shift を押しながら押したときと同じ道筋(判断を 2 か所に書かない)。
      void savePart(createDefaultPartFileDeps(), true);
      return;
    case 'exportShape':
      openExportPanel();
      return;
    case 'importShape':
      void importFile();
      return;
    case 'saveAsTemplate':
      // 置き場へ入り終えてから一覧を読み直す(先に読むと、いま残したひな形が並ばない)。
      void runSaveAsTemplate().then(onTemplatesChanged);
      return;
    case 'newFromTemplate':
      void runNewFromTemplate({ from: 'file' });
      return;
    case 'print':
      void runPrint();
      return;
  }
}

/**
 * 書き出しのパネルの入れ物(P6 §0.a-0.20、タスク32)。
 *
 * 中身は `file/ExchangePanel.tsx`。ここがするのは**置き場所と閉じ方**だけで、
 * `SettingsPanel` とまったく同じ作り(覆いを作らないので、開いている間も背後の
 * 視点操作はそのまま効く。NFR-UX-2)。
 */
export function ExportPanelHost({
  onClose,
}: {
  readonly onClose: () => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileName = useAppStore((state) => state.fileName);

  useEffect(() => {
    // 外を押したら閉じる。覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        onClose();
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div className="pcad-menu pcad-menu--exchange" ref={containerRef}>
      <ExchangePanel
        onClose={onClose}
        deps={createExchangeDeps(exportBaseNameOf(fileName))}
        onFinished={(notices) => {
          /*
            **書き出せたときの案内を失敗の口へ入れない**(タスク45 の指摘、43b の申し送り)。
            `setError` はステータスバーで「計算に失敗しました:」を頭に付けて赤くするので、
            うまくいったのに失敗したように見えていた。成功の 1 行そのものは
            `ExchangePanel` が `setFileMessage`(`failed: false`)で立てている。
            弾いた立体・落とした三角形の案内は、その成功の 1 行と同じ調子で添える。
          */
          if (notices.length > 0) {
            useAppStore.getState().setExchangeNotice(notices.join(' '));
          }
        }}
        onFailed={(message) => {
          useAppStore.getState().setError(message);
        }}
      />
    </div>
  );
}
