/**
 * 「見た目」の区画(投影・表示スタイル・方眼・断面・外観・測る・下絵・点検)。
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import type { AppearanceMatchEntry, PartDocument } from '@pointercad/model';
import { appearanceReadiness } from '../../appearance/appearanceCommands.js';
import { t } from '../../i18n/t.js';
import type { NumericInputToolId } from '../../sketch/numericInput.js';
import { measureToolReadiness } from '../../solid/measureCommands.js';
import { PRINT_CHECK_NO_BODY_KEY } from '../../solid/printCheckCommands.js';
import type { SolidToolReadiness } from '../../solid/solidCommands.js';
import type { SelectionKind, SubShapeBody } from '../../solid/subShapeSelection.js';
import { useAppStore } from '../../store/useAppStore.js';
import { AppearanceIcon } from '../icons.js';
import { LOOK_MENU_ITEMS, type LookToolId } from '../toolbarMenus.js';
import { addCanvasFromFile } from './lookToolActions.js';
import { runMeasureTool } from './solidToolActions.js';
import { ToolMenu } from './ToolMenu.js';

interface LookGroupProps {
  readonly document: PartDocument;
  readonly bodies: readonly SubShapeBody[];
  readonly selection: readonly string[];
  readonly selectionKind: SelectionKind;
  readonly matches: readonly AppearanceMatchEntry[];
  readonly activeTool: NumericInputToolId;
}

/**
 * 「見た目」の区画(FR-1106〜1110、要件§4.12。P5 タスク12 で外観、タスク51 で畳んだ一覧へ)。
 *
 * 専用パネル/ダイアログは採らず、畳んだ一覧 1 つにする(§0.a-0.13、§0.a-0.51)。
 * いまの中身は外観 1 つだけだが、**タスク32 の「測る」がこの一覧の 2 行目に入る**
 * (§0.a-0.29 が「測る」をボタン 1 つと決めているので、区画を増やさずに済む。要件§7.1)。
 * 押せる条件と理由は `appearanceReadiness`(`appearance/appearanceCommands.ts`、タスク11)に
 * 1 本化してあるのでここで 2 重に判定しない(`SolidGroup` と同じ作り)。
 *
 * **入れ物側に `role="group"` を付けない**のは、開いた一覧(`.pcad-menu__panel`)がすでに
 * 同じ「見た目」という名前の group だから。同じ名前の group を入れ子にすると、読み上げでも
 * 検査でもどちらを指しているのか取り違える(区画名と一覧名が違う「ソリッド」区画は
 * 従来どおり `role="group"` を付ける)。
 */
export function LookGroup({
  document,
  bodies,
  selection,
  selectionKind,
  matches,
  activeTool,
}: LookGroupProps): React.JSX.Element {
  const isAssembly = useAppStore(state => state.assembly !== null);
  const readiness = appearanceReadiness({ document, bodies, selection, selectionKind, matches });
  /*
    項目ごとの押せる条件。外観は `appearanceReadiness`(タスク11)、測るは
    `measureToolReadiness`(タスク32)で、どちらも判断の正本はそれぞれ 1 か所にある。
  */
  const readinessOf = (id: LookToolId): SolidToolReadiness => {
    if (id === 'strength') return { ready: true, reasonKey: null };
    if (id === 'measure') {
      return measureToolReadiness(selection, bodies);
    }
    if (id === 'canvas') {
      // 下絵(FR-332)はいつでも押せる。立体もスケッチも要らない(空の部品にも貼れる)。
      return { ready: true, reasonKey: null };
    }
    if (id === 'printCheck') {
      /*
        3D プリントの点検(FR-815、タスク46)。**立体が 1 つでもあれば押せる**
        (選んでいなければ全部を点検する、`printCheckTargets`)。1 つも無いときだけ
        理由つきで断る(NFR-UX-5)。
      */
      return bodies.length > 0
        ? { ready: true, reasonKey: null }
        : { ready: false, reasonKey: PRINT_CHECK_NO_BODY_KEY };
    }
    return { ready: readiness.ok, reasonKey: readiness.reasonKey };
  };
  return (
    <div className="pcad-toolbar__group">
      <span className="pcad-toolbar__group-label" title={t('toolbar.look.tooltip')}>
        {t('toolbar.look.groupLabel')}
      </span>
      <div className="pcad-segmented">
        <ToolMenu
          items={isAssembly ? LOOK_MENU_ITEMS.filter(item => item.id === 'strength') : LOOK_MENU_ITEMS}
          groupLabelKey="toolbar.look.groupLabel"
          groupTooltipKey="toolbar.look.tooltip"
          GroupIcon={AppearanceIcon}
          activeTool={activeTool}
          readinessOf={readinessOf}
          onChoose={(id, pressed) => {
            if (id === 'strength') {
              const store = useAppStore.getState();
              store.setActiveTool('select');
              store.toggleStrength();
              return;
            }
            if (id === 'measure') {
              runMeasureTool(readinessOf(id));
              return;
            }
            if (id === 'canvas') {
              // 下絵(FR-332、タスク39)。画像を選ぶ窓を出し、選ばれたらその場で貼る。
              void addCanvasFromFile();
              return;
            }
            if (id === 'printCheck') {
              /*
                3D プリントの点検(FR-815、タスク46)。**もう一度押すと閉じる**
                (色が消えて元の外観に戻る。他の一覧の「同じ道具をもう一度選んだら解除」と
                同じ約束、NFR-UX-3)。走らせるのも閉じるのも文書を 1 バイトも変えない。
              */
              const printStore = useAppStore.getState();
              if (printStore.printability !== null) {
                printStore.setPrintability(null);
                return;
              }
              printStore.inspectPrintability();
              return;
            }
            const store = useAppStore.getState();
            // 同じ道具をもう一度選んだら解除して選択へ戻す(他の一覧と同じ約束、NFR-UX-3)。
            store.setActiveTool(pressed ? 'select' : id);
            store.requestViewportFocus();
            if (!readiness.ok) {
              // 押せなくても、ツールチップだけでなく帯にも理由を出す(NFR-UX-5)。
              store.setAppearanceError(readiness.reasonKey);
            }
          }}
        />
      </div>
    </div>
  );
}
