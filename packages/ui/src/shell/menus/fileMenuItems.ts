/**
 * 「ファイル」の畳んだ一覧の中身(FR-812、FR-814、FR-807。P6 §0.57、タスク31・33)。
 *
 * 分け方の決定は P6 タスク52(一覧ごとに 1 ファイル)。
 */

import {
  DrawingSheetIcon,
  ExportIcon,
  ImportIcon,
  LayersIcon,
  PrintIcon,
  RecentFileIcon,
  SaveAsIcon,
  TemplateNewIcon,
  TemplateSaveIcon,
} from '../icons.js';
import type { ToolMenuItem } from './menuItem.js';

/**
 * 「ファイル」の畳んだ一覧に並ぶ操作の id(P6 §0.57、タスク31)。
 *
 * **配線先のある操作だけを並べる。** 一覧に出ている行を押したら必ず正しいことが起きる、
 * という約束をこの型で守る(`Toolbar.tsx` の `runFileMenuAction` はこの型を網羅する
 * `switch` なので、**配線を書かずに id を足すと型検査が落ちる**)。
 *
 * §0.57 は最終的に 7 項目(書き出す・読み込む・ひな形から新規・ひな形として保存・
 * 別名保存・印刷・最近使ったファイル)と決めているが、P6 タスク31 の時点で配線先が
 * あるのは**別名保存だけ**なので、まずそれだけを載せる。残りは中身を作るタスクが
 * この型と下の表へ 1 行ずつ足す(溝の幅は 1 画素も増えない。`segmentedWidthPixels`)。
 *
 * - 書き出す・読み込む … **タスク32 で載せた**(`file/exchangeFile.ts` と `file/ExchangePanel.tsx`)
 * - ひな形として保存・ひな形から新規・印刷 … **タスク33 で載せた**
 *   (ひな形は `file/templateFile.ts`、印刷は `file/printView.ts` の `printViewport` に、
 *    ストアの `capturePrintFrame`(白い下地で 1 コマを PNG にする口。`createViewportScene`
 *    が差し出す)を渡す。**`captureThumbnail` は流用しない**——256 画素の正方形で下地も
 *    画面と同じ暗い色なので、紙に出すと FR-908「印刷の見た目はテーマの影響を受けない」に反する)
 * - 保存したひな形と最近使ったファイルは**数が決まらない**ので、この型ではなく下の
 *   `fileMenuItems` が接頭辞つきの id で組み立てる。
 */
export type FileMenuActionId =
  | 'newDrawingFromPart'
  | 'newAssembly'
  | 'saveAs'
  | 'exportShape'
  | 'importShape'
  | 'saveAsTemplate'
  | 'newFromTemplate'
  | 'print';

/**
 * 「ファイル」の畳んだ一覧(FR-812、P6 §0.57、タスク31)。
 *
 * 新規・開く・保存の 3 つは**図柄のまま残す**(最もよく使うので 1 クリックで届かせる、
 * §0.57)。その右に畳んだボタンを 1 つだけ足し、たまにしか使わないファイル操作を
 * すべてこの中へ入れる。区画は増やさない(要件§7.1、rules/04)。
 *
 * 別名保存は P2 から「保存ボタンを Shift を押しながら押す」か Ctrl+Shift+S でできたが、
 * **押し方を知らないと辿り着けなかった**(FR-812 は入口を求めている)。ここへ 1 行置くと、
 * 画面を見るだけで見つかる(NFR-UX-7)。Shift 押しと Ctrl+Shift+S はそのまま残す。
 */
export const FILE_MENU_ITEMS: readonly ToolMenuItem<FileMenuActionId>[] = [
  { id: 'newDrawingFromPart', labelKey: 'drawing.file.fromPart', tooltipKey: 'drawing.file.fromPart', Icon: DrawingSheetIcon },
  {
    id: 'newAssembly',
    labelKey: 'assembly.file.new',
    tooltipKey: 'assembly.file.newTooltip',
    Icon: LayersIcon,
  },
  {
    id: 'saveAs',
    labelKey: 'toolbar.file.saveAs',
    tooltipKey: 'toolbar.file.saveAsMenuTooltip',
    Icon: SaveAsIcon,
  },
  /*
   * 書き出す・読み込む(FR-802、FR-803、FR-813、タスク32)。**別名保存の下に置く。**
   * 上から「いまの部品を別の名前で残す」→「いまの部品をほかのソフトへ渡す」→
   * 「ほかのソフトの形を取り込む」と、外へ出す操作から中へ入れる操作の順に並ぶ。
   */
  {
    id: 'exportShape',
    labelKey: 'toolbar.file.exportShape',
    tooltipKey: 'toolbar.file.exportShapeTooltip',
    Icon: ExportIcon,
  },
  {
    id: 'importShape',
    labelKey: 'toolbar.file.importShape',
    tooltipKey: 'toolbar.file.importShapeTooltip',
    Icon: ImportIcon,
  },
  /*
   * ひな形(FR-814、タスク33)。**残す → 始める**の順に 2 行。書き出す・読み込むの下に
   * 置くのは、どちらも「ファイルを 1 つ作る / ファイルから始める」操作で、上の 3 行
   * (いまの部品をどう保存するか)とは目的が違うためである。
   */
  {
    id: 'saveAsTemplate',
    labelKey: 'toolbar.file.saveAsTemplate',
    tooltipKey: 'toolbar.file.saveAsTemplateTooltip',
    Icon: TemplateSaveIcon,
  },
  {
    id: 'newFromTemplate',
    labelKey: 'toolbar.file.newFromTemplate',
    tooltipKey: 'toolbar.file.newFromTemplateTooltip',
    Icon: TemplateNewIcon,
  },
  /*
   * 印刷(FR-810、タスク33)。いまの部品を紙へ出す操作なので、ファイルを作る操作の後ろ、
   * 動く行(保存したひな形・最近使ったファイル)の前に置く。
   */
  {
    id: 'print',
    labelKey: 'toolbar.file.print',
    tooltipKey: 'toolbar.file.printTooltip',
    Icon: PrintIcon,
  },
];

// ---------------------------------------------------------------------------
// 数の決まらない行(保存したひな形・最近使ったファイル。P6 §0.a-0.36・0.38、タスク33)
// ---------------------------------------------------------------------------

/**
 * 保存したひな形の行の id の接頭辞(FR-814)。
 *
 * 決まった操作の id(`FileMenuActionId`)と混ざらないよう、**接頭辞で種類を分ける。**
 * 兄弟の `key` に種類の接頭辞を付けるのは `rules/06` 10.9 の対策でもある——ひな形の名前が
 * たまたま `'print'` でも、行の id は `'template:print'` になって決まった操作と食い違う。
 */
export const STORED_TEMPLATE_MENU_PREFIX = 'template:';

/** 最近使ったファイルの行の id の接頭辞(FR-807)。理由は上と同じ。 */
export const RECENT_FILE_MENU_PREFIX = 'recentFile:';

/** 保存したひな形の行の id。 */
export type StoredTemplateMenuId = `${typeof STORED_TEMPLATE_MENU_PREFIX}${string}`;

/** 最近使ったファイルの行の id。 */
export type RecentFileMenuId = `${typeof RECENT_FILE_MENU_PREFIX}${string}`;

/** 「ファイル」の一覧に並ぶ行の id(決まった操作 + 数の決まらない 2 種)。 */
export type FileMenuItemId = FileMenuActionId | StoredTemplateMenuId | RecentFileMenuId;

/**
 * その行が保存したひな形か。**型を絞る述語**にしてあるので、`Toolbar.tsx` は 2 種類を
 * より分けたあと、残りが決まった操作(`FileMenuActionId`)だけであることを型で確かめられる
 * ——網羅 `switch` の効き目(配線を書かずに行を足せない)を保つための形である。
 */
export function isStoredTemplateMenuId(id: FileMenuItemId): id is StoredTemplateMenuId {
  return id.startsWith(STORED_TEMPLATE_MENU_PREFIX);
}

/** その行が最近使ったファイルか(理由は上と同じ)。 */
export function isRecentFileMenuId(id: FileMenuItemId): id is RecentFileMenuId {
  return id.startsWith(RECENT_FILE_MENU_PREFIX);
}

/** 保存したひな形の行の id から、置き場の鍵を取り出す(接頭辞を外すだけ)。 */
export function storedTemplateIdOf(id: StoredTemplateMenuId): string {
  return id.slice(STORED_TEMPLATE_MENU_PREFIX.length);
}

/*
 * 最近使ったファイルの行には**名前を取り出す口を付けない。** 選んだあとにできるのは
 * 「開く」の窓を出すことだけ(場所を覚えていないため。§0.a-0.38、NFR-SE-1)で、
 * 窓へ名前を初期値として渡す口が `FileGateway` に無いので、名前を読み戻す相手がいない。
 * 使わない口を置くと「名前で開けるのでは」と読み違える。
 */

/** 一覧に名前だけを出す行のもと(ひな形の見出しとファイルの履歴に共通の 2 欄)。 */
export interface NamedMenuEntry {
  /** 置き場の鍵(ひな形)またはファイル名(最近使ったファイル)。 */
  readonly id: string;
  /** 一覧に出す名前。 */
  readonly name: string;
}

/**
 * 「ファイル」の一覧の中身(P6 §0.57、タスク33)。決まった 6 行のうしろへ、
 * 保存したひな形と最近使ったファイルを名前のまま並べる。
 *
 * **0 件のものは 1 行も出さない。** 押しても何も起きない行を画面に出さないためで、
 * ひな形を 1 つも残していない人・一度もファイルを開いていない人の一覧は、
 * タスク33 の前と同じ 6 行だけになる。
 *
 * **一覧の中の行数はツールバーの幅に効かない**(`segmentedWidthPixels` は溝に並ぶ
 * ボタンの個数しか見ない)ので、ひな形が 10 個並んでも溝は 121 画素のままである。
 */
export function fileMenuItems(
  templates: readonly NamedMenuEntry[],
  recentFiles: readonly NamedMenuEntry[],
  documentKind: 'part' | 'assembly' = 'part',
): readonly ToolMenuItem<FileMenuItemId>[] {
  // アセンブリで成立する固定操作は新規アセンブリと別名保存。その他は部品用。
  const rows: ToolMenuItem<FileMenuItemId>[] = documentKind === 'assembly'
    ? FILE_MENU_ITEMS.filter((item) => item.id === 'newAssembly' || item.id === 'saveAs')
    : [...FILE_MENU_ITEMS];
  if (documentKind === 'part') {
    for (const template of templates) {
      rows.push({
        id: `${STORED_TEMPLATE_MENU_PREFIX}${template.id}`,
        // 名前の無いひな形は作れない(`templateFile.ts` が部品の名前へ落とす)が、
        // 空の行を画面に出さない保険として決まった文言を土台に置く。
        labelKey: 'toolbar.file.newFromTemplate',
        tooltipKey: 'toolbar.file.storedTemplateTooltip',
        Icon: TemplateNewIcon,
        label: template.name,
      });
    }
  }
  for (const recent of recentFiles) {
    rows.push({
      id: `${RECENT_FILE_MENU_PREFIX}${recent.id}`,
      labelKey: 'toolbar.file.recentFile',
      tooltipKey: 'toolbar.file.recentFileTooltip',
      Icon: RecentFileIcon,
      label: recent.name,
    });
  }
  return rows;
}
