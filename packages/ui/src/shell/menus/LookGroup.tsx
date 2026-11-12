/**
 * 「見た目」の区画(投影・表示スタイル・方眼・断面・外観・測る・下絵・点検)。
 * 一覧ごとに 1 ファイルへ分けた。
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
 * 「見た目」の区画(FR-1106〜1110、要件§4.12)。
 *
 * 専用パネル/ダイアログは採らず、畳んだ一覧 1 つにする。
 * 中身は外観と、**この一覧の 2 行目に入る「測る」**
 * (「測る」はボタン 1 つと決めているので、区画を増やさずに済む。要件§7.1)。
 * 押せる条件と理由は `appearanceReadiness`(`appearance/appearanceCommands.ts`)に
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
  const measureSketch = useAppStore(state => state.isComputing ? undefined : state.resolvedSketch);
  const isAssembly = useAppStore(state => state.assembly !== null);
  const readiness = appearanceReadiness({ document, bodies, selection, selectionKind, matches });
  /*
    項目ごとの押せる条件。外観は `appearanceReadiness`、測るは
    `measureToolReadiness`で、どちらも判断の正本はそれぞれ 1 か所にある。
  */
  const readinessOf = (id: LookToolId): SolidToolReadiness => {
    if (id === 'strength') return { ready: true, reasonKey: null };
    if (id === 'measure') {
      return measureToolReadiness(selection, bodies, measureSketch);
    }
    if (id === 'canvas') {
      // 下絵(FR-332)はいつでも押せる。立体もスケッチも要らない(空の部品にも貼れる)。
      return { ready: true, reasonKey: null };
    }
    if (id === 'mathGeometry') {
      // 図形の測定値。押せる条件は「部品を開いている」だけ(何も選んでいなくてもよい)。
      // アセンブリでは `isAssembly` の絞り込み(下の items)でそもそも一覧に出ない。
      return { ready: true, reasonKey: null };
    }
    if (id === 'printCheck') {
      /*
        3D プリントの点検(FR-815)。**立体が 1 つでもあれば押せる**
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
          commandGroup="look"
        />
      </div>
    </div>
  );
}
