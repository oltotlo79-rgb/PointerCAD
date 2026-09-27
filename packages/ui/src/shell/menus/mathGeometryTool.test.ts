/**
 * 道具「図形の測定値」の登録(GR-30。Q1=A4「ツールバーの新しい道具」、
 * scratchpad/claude/plans/geomref-plan.md §4(a)・§2.5「道具の登録の仕組み」)。
 *
 * ここで確かめるのは**既存の仕組みへ正しく載ったか**だけ(カタログ・F1・状態欄の案内・
 * 選択の扱い・押せる条件)。値を実際に測って一覧へ並べる中身(GR-15・GR-19b)や、
 * 段階の案内の詳細(GR-26)は別のタスクの担当。
 */
import { findHelpTopic } from '@pointercad/help-content';
import { createAssemblyDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { commandDefinition } from '../../commands/commandDefinitions.js';
import { toolbarCommand, toolbarCommandId } from '../../commands/toolbarCommandCatalog.js';
import { runToolbarCommand } from '../../commands/toolbarCommandExecution.js';
import { toolCommandHelpTopic } from '../../commands/toolCommandHelp.js';
import { t } from '../../i18n/t.js';
import { keepsSelectionKind } from '../../solid/subShapeSelection.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { isLookTool } from '../../viewport/attachSketchInteraction.js';
import { guideKeyFor } from '../statusText.js';
import { LOOK_MENU_ITEMS } from './lookMenuItems.js';
import { chooseLookTool, lookToolbarReadiness } from './lookToolbarActions.js';

beforeEach(resetTestStore);

const MATH_GEOMETRY_COMMAND_ID = toolbarCommandId('look', 'mathGeometry');

describe('道具「図形の測定値」の登録(GR-30)', () => {
  it('ツールバーの「見た目」で「測る」の次に並び、名前・説明・図柄を持つ', () => {
    const measureIndex = LOOK_MENU_ITEMS.findIndex((item) => item.id === 'measure');
    const mathGeometryIndex = LOOK_MENU_ITEMS.findIndex((item) => item.id === 'mathGeometry');
    expect(measureIndex).toBeGreaterThanOrEqual(0);
    expect(mathGeometryIndex).toBe(measureIndex + 1);
    const item = LOOK_MENU_ITEMS[mathGeometryIndex];
    expect(item?.labelKey).toBe('toolbar.look.mathGeometry');
    expect(item?.tooltipKey).toBe('toolbar.look.mathGeometryTooltip');
    expect(typeof item?.Icon).toBe('function');
  });

  it('名前と説明の文言が定義され、ツールチップは名前で始まらない(FR-904)', () => {
    const name = t('toolbar.look.mathGeometry');
    const tooltip = t('toolbar.look.mathGeometryTooltip');
    expect(name.length).toBeGreaterThan(0);
    expect(tooltip.length).toBeGreaterThan(0);
    expect(tooltip.startsWith(`${name}: `)).toBe(false);
  });

  it('コマンド一覧に ID・名前・説明・章(math-input)が登録され、部品だけを対象にする', () => {
    const entry = toolbarCommand(MATH_GEOMETRY_COMMAND_ID);
    expect(entry).not.toBeNull();
    expect(entry?.group).toBe('look');
    expect(entry?.sourceId).toBe('mathGeometry');
    expect(entry?.labelKey).toBe('toolbar.look.mathGeometry');
    expect(entry?.tooltipKey).toBe('toolbar.look.mathGeometryTooltip');
    expect(entry?.helpTopic).toBe('math-input');
    expect(entry?.documentKinds).toEqual(['part']);
    // 説明の章そのものが説明書に実在すること(黙って落とさない、回帰と同じ確認)。
    expect(findHelpTopic('math-input')).toBeDefined();
  });

  it('道具が有効な間の F1 は math-input の章を開く', () => {
    expect(toolCommandHelpTopic('mathGeometry')).toBe('math-input');
  });

  it('既定のショートカットを割り当てない(「測る」と同じ。設定画面からのみ割り当て可)', () => {
    const definition = commandDefinition(MATH_GEOMETRY_COMMAND_ID);
    expect(definition?.labelKey).toBe('toolbar.look.mathGeometry');
    expect(definition?.shortcuts).toEqual([]);
  });

  it('「見た目」の一覧の道具として立体・面・辺・頂点を拾う(isLookTool)', () => {
    expect(isLookTool('mathGeometry')).toBe(true);
    expect(isLookTool('select')).toBe(false);
    expect(isLookTool('extrude')).toBe(false);
  });

  it('選ぶ種類を切り替えない(keepsSelectionKind。「測る」と同じ理由)', () => {
    expect(keepsSelectionKind('mathGeometry')).toBe(true);
  });

  it('状態欄の段0の案内キーを持ち、文言が定義されている', () => {
    expect(guideKeyFor('mathGeometry', 0)).toBe('statusBar.guide.mathGeometry');
    expect(t('statusBar.guide.mathGeometry').length).toBeGreaterThan(0);
  });

  it('部品を開いていれば、何も選んでいなくても押せる(P2)', () => {
    const readiness = lookToolbarReadiness(useAppStore.getState(), 'mathGeometry');
    expect(readiness).toEqual({ ready: true, reasonKey: null });
  });

  it('選択の有無に関わらず押せる(外観と違って選択の内容では断らない)', () => {
    useAppStore.getState().setSelection(['extrude-1']);
    const readiness = lookToolbarReadiness(useAppStore.getState(), 'mathGeometry');
    expect(readiness).toEqual({ ready: true, reasonKey: null });
  });

  it('アセンブリでは押せない(既存の最初の分岐で断られる)', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    const readiness = lookToolbarReadiness(useAppStore.getState(), 'mathGeometry');
    expect(readiness).toEqual({ ready: false, reasonKey: 'command.unavailable.document' });
  });

  it('runToolbarCommand で道具が入り切りし、選択と選択の種類を保つ', () => {
    useAppStore.getState().setSelection(['extrude-1']);
    const selectionKindBefore = useAppStore.getState().selectionKind;
    expect(runToolbarCommand(MATH_GEOMETRY_COMMAND_ID)).toBe(true);
    expect(useAppStore.getState().activeTool).toBe('mathGeometry');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);
    expect(useAppStore.getState().selectionKind).toBe(selectionKindBefore);
    // もう一度押すと選択の道具へ戻る(NFR-UX-3)。ここでも選択は消えない。
    expect(runToolbarCommand(MATH_GEOMETRY_COMMAND_ID)).toBe(true);
    expect(useAppStore.getState().activeTool).toBe('select');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);
  });

  it('runToolbarCommand はアセンブリでは無効(文書の種類の絞り込みで実行前に落ちる)', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    const before = useAppStore.getState();
    expect(runToolbarCommand(MATH_GEOMETRY_COMMAND_ID)).toBe(false);
    expect(useAppStore.getState()).toBe(before);
  });

  it('chooseLookTool は道具を切り替え、ビューポートへ焦点を戻す', () => {
    const before = useAppStore.getState().focusViewportRequestCount;
    expect(chooseLookTool('mathGeometry')).toBe(true);
    expect(useAppStore.getState().activeTool).toBe('mathGeometry');
    expect(useAppStore.getState().focusViewportRequestCount).toBe(before + 1);
  });
});
