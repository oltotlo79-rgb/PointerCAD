/**
 * 畳んだ一覧の共通の見た目(FR-904、NFR-UX-7)。中身の表は `toolbarMenus.ts` にある。
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { useEffect, useRef, useState } from 'react';
import { type MessageKey, t } from '../../i18n/t.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { ChevronRightIcon, type IconComponent } from '../icons.js';
import {
  nextHighlightIndex,
  rememberRecentTool,
  type ToolMenuItem,
  triggerItemOf,
} from '../toolbarMenus.js';
import { LABEL_SEPARATOR, TOOLTIP_LINE_BREAK, unavailableTooltip } from './toolbarShared.js';

interface ToolMenuProps<Id extends string> {
  /** 一覧に並べる道具(`toolbarMenus.ts` の表)。項目を足すときは表へ 1 行足すだけ。 */
  readonly items: readonly ToolMenuItem<Id>[];
  /** 区画の名前と説明。畳んだボタンの読み上げ名とツールチップの頭に出る。 */
  readonly groupLabelKey: MessageKey;
  readonly groupTooltipKey: MessageKey;
  /** まだ一度もこの一覧を使っていないときに、ボタンへ出す図柄。 */
  readonly GroupIcon: IconComponent;
  /**
   * いま選んでいる道具の id。畳んだボタンの図柄と `aria-pressed` を決めるためだけに使う
   * ので、道具 id の型ではなく**文字列**で受ける(P4b タスク13 で「拘束」の一覧を足した。
   * 拘束の種類は `NumericInputToolId` ではなく `SketchConstraintKind` で、
   * `triggerItemOf` もこの用途のために `string` を受ける形になっている)。
   */
  readonly activeTool: string;
  /**
   * 道具ごとの押せる条件(NFR-UX-5「実行前に理由提示」)。渡さなければ常に押せる。
   * タスク22〜24 が道具ごとに違う条件を足すときは、ここを id で振り分ける。
   */
  readonly readinessOf?: (id: Id) => EditToolReadiness;
  /**
   * 畳んだボタンに「押されている」見た目(`aria-pressed`)を出すか。既定は出す(§0.a-0.80)。
   *
   * **「投影」の一覧だけは出さない。** 透視投影か平行投影かは**必ずどちらかが効いている**
   * ので、押下表示が常に点いたままになり「押しっぱなしのボタン」に見える(2026-09-05 の
   * 実装で分かった件)。いま効いているほうは畳んだボタンの図柄(`triggerItemOf`)が
   * 示しているので、押下表示が無くても今の見え方は読み取れる。
   * 一覧の中の項目の `aria-pressed` は**この props に関わらず出す**(どちらが選ばれて
   * いるかは一覧を開いた人が知りたいことなので、NFR-UX-7)。
   */
  readonly showPressed?: boolean;
  /** 項目を選んだときの処理。`pressed` は「同じ道具をもう一度押した」かどうか。 */
  readonly onChoose: (id: Id, pressed: boolean) => void;
}

/**
 * 図柄つきの畳んだ一覧(「作図」「編集」、§0.a-0.14、タスク32)。
 *
 * **1 段に戻すための形**(利用者の決定 2026-09-04)。基本の 6 道具と同じ溝の中に、
 * 図柄+小さな ▾ のボタンとして並ぶ。t12・t21 の時点では名前つきのボタンが基本の道具の
 * 下へ積まれ、ツールバーが 1440 画素で 2〜3 段相当(実測 97.5〜126.5px)になっていた。
 *
 * 作り(非モーダル、外を押すと閉じる、Esc で閉じる)は `PlaneMenu` と同じ。加えて
 * ①項目は**図柄+名前**で並べ、②↑↓ Home End で選べ(`nextHighlightIndex`)、
 * ③選ぶと一覧が閉じ、ボタンの図柄が最後に使った道具のものへ変わる(`triggerItemOf`)。
 * ③は「よく使う道具は 1 クリック、それ以外は 2 クリック」にするための工夫。
 *
 * 開いているかどうかと「最後に使った道具」は見た目だけの一時状態なのでここで持つ
 * (道具そのものの正本はストア、rules/04-設計の規律.md)。
 */
export function ToolMenu<Id extends string>({
  items,
  groupLabelKey,
  groupTooltipKey,
  GroupIcon,
  activeTool,
  readinessOf,
  showPressed = true,
  onChoose,
}: ToolMenuProps<Id>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [recentId, setRecentId] = useState<Id | null>(null);
  /** キーボードで選んでいる位置(0 起点)。開くたびに今の道具の行から始める。 */
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // 開いている間は選んでいる行そのものに焦点を移す。こうすると決めるのは Enter / Space の
  // 既定の動きで済み、押せない項目の理由もその場で読み上げられる(NFR-UX-7)。
  useEffect(() => {
    if (open) {
      itemRefs.current[highlight]?.focus();
    }
  }, [open, highlight]);

  const groupLabel = t(groupLabelKey);
  const shown = triggerItemOf(items, activeTool, recentId);
  /*
   * 行に出す名前。**利用者が付けた名前を持つ行だけ**が `label` を持ち(保存したひな形と
   * 最近使ったファイル。P6 タスク33)、持たない行は今までどおり `ja.json` から引く
   * (NFR-MA-5)。読み替えをここ 1 か所に閉じておくと、ツールチップ・読み上げ名・行の
   * 見出しの 3 か所が必ず同じ名前になる。
   */
  const nameOf = (item: ToolMenuItem<Id>): string => item.label ?? t(item.labelKey);
  const activeHere = items.some((item) => item.id === activeTool);

  function openMenu(): void {
    const index = items.findIndex((item) => item.id === activeTool);
    setHighlight(index < 0 ? 0 : index);
    setOpen(true);
  }

  // ツールチップは「名前: 説明」を重ねる(FR-904)。畳んだ図柄が何の道具なのかと、
  // 一覧の開き方・選び方をここだけで読み切れるようにする(NFR-UX-7)。
  const tooltip = [
    `${groupLabel}${LABEL_SEPARATOR}${t(groupTooltipKey)}`,
    shown === null ? null : `${nameOf(shown)}${LABEL_SEPARATOR}${t(shown.tooltipKey)}`,
    t('toolbar.menu.keyboardHint'),
  ]
    .filter((line) => line !== null)
    .join(TOOLTIP_LINE_BREAK);

  return (
    <div
      className="pcad-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        if (!open) {
          // 畳んだボタンに焦点があるときの ↓ で開く(世の中の畳んだ一覧と同じ)。
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          }
          return;
        }
        const next = nextHighlightIndex(highlight, event.key, items.length);
        if (next === null) {
          return;
        }
        event.preventDefault();
        setHighlight(next);
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="pcad-button pcad-menu__trigger pcad-menu__trigger--icon"
        title={tooltip}
        aria-label={
          shown === null ? groupLabel : `${groupLabel}${LABEL_SEPARATOR}${nameOf(shown)}`
        }
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={showPressed ? activeHere : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          openMenu();
        }}
      >
        {shown === null ? <GroupIcon /> : <shown.Icon />}
        <ChevronRightIcon className="pcad-menu__chevron pcad-menu__chevron--small" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
          {items.map((item, index) => {
            const readiness = readinessOf?.(item.id) ?? null;
            const ready = readiness === null || readiness.ready;
            return (
              <button
                key={item.id}
                type="button"
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                className="pcad-button pcad-menu__item"
                title={
                  ready
                    ? `${nameOf(item)}${LABEL_SEPARATOR}${t(item.tooltipKey)}`
                    : unavailableTooltip(item.labelKey, readiness?.reasonKey ?? null)
                }
                aria-pressed={activeTool === item.id}
                aria-disabled={!ready}
                onFocus={() => {
                  setHighlight(index);
                }}
                onClick={() => {
                  setRecentId(rememberRecentTool(items, recentId, item.id));
                  onChoose(item.id, activeTool === item.id);
                  setOpen(false);
                }}
              >
                <item.Icon />
                {nameOf(item)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
