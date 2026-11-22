import { t, type MessageKey } from '../i18n/t.js';
import type { SelectionModifier } from './selectionModifierSetting.js';

/** 選択に足す・外すキーを名前で案内する文の鍵(B-08 2-5)。どれかを表から消すと、下の表の型が合わなくなる。 */
type SelectionHintKey = 'assembly.boltedJoint.unsupported.duplicateHole' | 'assembly.boltedJoint.addHolesGuide'
  | 'assembly.frameSlot.pickHole' | 'drawing.advanced.targetHint' | 'drawing.dimension.selectHint'
  | 'sketch.connect.selectTwo' | 'sketch.facePoints.selectThree';

/**
 * 設定でキーを選んだ時に使う、キーの名前を {keys} に差し込む文の鍵。
 * 既定(今のまま)の時は元の文をそのまま出す(場所ごとの今のキーの書き方が、1 文字も変わらない)。
 */
const HINT_TEMPLATES: Readonly<Record<SelectionHintKey, MessageKey>> = {
  'assembly.boltedJoint.unsupported.duplicateHole': 'assembly.boltedJoint.unsupported.duplicateHoleWithKeys',
  'assembly.boltedJoint.addHolesGuide': 'assembly.boltedJoint.addHolesGuideWithKeys',
  'assembly.frameSlot.pickHole': 'assembly.frameSlot.pickHoleWithKeys',
  'drawing.advanced.targetHint': 'drawing.advanced.targetHintWithKeys',
  'drawing.dimension.selectHint': 'drawing.dimension.selectHintWithKeys',
  'sketch.connect.selectTwo': 'sketch.connect.selectTwoWithKeys',
  'sketch.facePoints.selectThree': 'sketch.facePoints.selectThreeWithKeys',
};

const KEY_NAMES: Readonly<Record<Exclude<SelectionModifier, 'local'>, MessageKey>> = {
  shiftOrCtrl: 'settings.selectionModifier.keyName.shiftOrCtrl',
  shift: 'settings.selectionModifier.keyName.shift',
  ctrl: 'settings.selectionModifier.keyName.ctrl',
};

/** 型の述語は MessageKey に含まれる鍵だけを許す(和の中の打ち間違いは、ここで型検査に落ちる)。 */
function isSelectionHintKey(key: MessageKey): key is SelectionHintKey {
  return Object.hasOwn(HINT_TEMPLATES, key);
}

/** 設定でキーを選んだ時の案内の文。既定(今のまま)の時と、案内の文でない鍵は null(表の値のまま)。 */
export function selectionKeyHint(key: MessageKey, modifier: SelectionModifier | undefined): string | null {
  if (modifier === undefined || modifier === 'local' || !isSelectionHintKey(key)) return null;
  return t(HINT_TEMPLATES[key]).replace('{keys}', t(KEY_NAMES[modifier]));
}
