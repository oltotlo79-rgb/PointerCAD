import { readMouseButtonCommands, type MouseButtonCommands } from '../commands/pointerCommandGesture.js';
import { readRadialCommands, type RadialCommands } from '../commands/radialCommandSettings.js';
import { salvageShortcutAssignments, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { INPUT_SETTINGS_FILE_BYTES } from '../file/fileContracts.js';
import { viewKeyCollisions } from './inputBindingsDraft.js';
import type { DisplaySettings } from './settings.js';
import { currentShortcutAssignments, storedShortcutFields } from './shortcutSettings.js';
import { currentSnapPauseModifier, snapPauseModifierOf, type SnapPauseModifier } from './snapPauseSetting.js';
import { currentSnapRadius, snapRadiusChoiceOf, type SnapRadiusChoice } from './snapRadiusSetting.js';
import {
  currentViewControls, isViewControlSettings, readStoredViewControls, viewTriggerKey, type ViewControlSettings, type ViewTrigger,
} from './viewControlSettings.js';

/**
 * 操作の割り当ての設定ファイル(`.pcadinput`。設計 B-09 3-1)の書き出しと読み込み。
 *
 * 形: `{ format, version: 1, viewControls, inputAssignments, mouseButtonCommands, radialCommands, snapPauseModifier, snapRadius }` の JSON。
 * 吸着の幅(snapRadius、配置の補助 P-D)は、吸着を止めるキーと同じ「吸着」の欄で読む(版は 1 のまま。無いファイルは今の値のまま)。
 * 5 つの欄は端末の保存と同じ形なので、読む時も端末の設定を読む時と同じ救い出しの関数を通す(中身を信じない)。
 * - 断る(全部を読まず、今の割り当てを変えない): 大きすぎる・JSON でない・印が違う・版が 1 でない(未来の版を含む)・読める欄が無い。
 * - 欄ごと: 知らない操作・命令の鍵や形の違う項目は 1 件ずつ捨てて数える。欄が無ければ今のまま。欄の形が違えば、その欄だけ読まない。
 * - 値は文字・数・真偽として 1 つずつ確かめて写すだけで、実行できる物は入らない。
 * 置き換えは窓の中で確かめてから行い、直後なら置き換える前の値へ戻せる(InputSettingsFileBar)。
 */
const FILE_FORMAT = 'pointercad-input-settings';
/** 版を上げる時は、古い版を読む道を残して足す。読み手より新しい版は読まない(知らない意味の欄を取り違えないため)。 */
const FILE_VERSION = 1;
const KNOWN_FIELDS: ReadonlySet<string> = new Set(['format', 'version', 'viewControls', 'inputAssignments', 'mouseButtonCommands',
  'radialCommands', 'snapPauseModifier', 'snapRadius']);

/** 窓に結果を出す欄の順。 */
export const INPUT_SETTINGS_SECTIONS = ['view', 'keys', 'mouse', 'radial', 'snap'] as const;
export type InputSettingsSection = (typeof INPUT_SETTINGS_SECTIONS)[number];

/** 欄ごとの読み取りの結果。absent はファイルに欄が無い、unreadable は欄の形が違って欄ごと読まなかった。 */
export interface SectionReading {
  readonly state: 'read' | 'absent' | 'unreadable';
  readonly dropped: number;
}

/** 置き換えの対象の 5 つの欄(無い欄は置き換えない)。 */
export interface InputSettingsValues {
  readonly viewControls?: ViewControlSettings | undefined;
  readonly shortcutAssignments?: ShortcutAssignments | undefined;
  readonly mouseButtonCommands?: MouseButtonCommands | undefined;
  readonly radialCommands?: RadialCommands | undefined;
  readonly snapPauseModifier?: SnapPauseModifier | undefined;
  readonly snapRadius?: SnapRadiusChoice | undefined;
}

export interface InputSettingsReading {
  readonly ok: true;
  readonly values: InputSettingsValues;
  readonly sections: Readonly<Record<InputSettingsSection, SectionReading>>;
  /** 知らない欄(一番上の段の鍵)の数。中身は読まずに捨てる。 */
  readonly unknownFields: number;
}

export type InputSettingsRefusal = 'tooLarge' | 'notJson' | 'notSettings' | 'futureVersion' | 'badVersion' | 'nothingReadable';

interface Section<T> {
  readonly value?: T;
  readonly reading: SectionReading;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ABSENT: Section<never> = { reading: { state: 'absent', dropped: 0 } };
const UNREADABLE: Section<never> = { reading: { state: 'unreadable', dropped: 0 } };

function readSection<T>(value: T, dropped: number): Section<T> {
  return { value, reading: { state: 'read', dropped } };
}

/** 適用済みの割り当てを書き出す(窓の下書きは含まない)。 */
export function encodeInputSettingsFile(settings: DisplaySettings): Uint8Array {
  const file = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    viewControls: currentViewControls(settings),
    inputAssignments: storedShortcutFields(currentShortcutAssignments(settings), undefined).inputAssignments,
    mouseButtonCommands: settings.mouseButtonCommands ?? {},
    radialCommands: settings.radialCommands ?? {},
    snapPauseModifier: currentSnapPauseModifier(settings),
    snapRadius: currentSnapRadius(settings),
  };
  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

/** UTF-8 の JSON として読む。読めなければ undefined(壊れた文字の並びも断る)。 */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function readViewSection(file: Readonly<Record<string, unknown>>): Section<ViewControlSettings> {
  if (!Object.hasOwn(file, 'viewControls')) return ABSENT;
  const raw = file.viewControls;
  if (!isPlainRecord(raw) || raw.version !== 2) return UNREADABLE;
  const salvaged = readStoredViewControls({ viewControls: raw });
  return isViewControlSettings(salvaged.settings) ? readSection(salvaged.settings, salvaged.dropped) : UNREADABLE;
}

function readKeysSection(file: Readonly<Record<string, unknown>>): Section<ShortcutAssignments> {
  if (!Object.hasOwn(file, 'inputAssignments')) return ABSENT;
  const raw = file.inputAssignments;
  if (!isPlainRecord(raw) || raw.version !== 2 || !isPlainRecord(raw.keys)) return UNREADABLE;
  const salvaged = salvageShortcutAssignments(raw.keys);
  return readSection(salvaged.assignments, salvaged.dropped);
}

function readRecordSection<T>(file: Readonly<Record<string, unknown>>, field: 'mouseButtonCommands' | 'radialCommands',
  salvage: (raw: object) => { readonly value: T; readonly dropped: number }): Section<T> {
  if (!Object.hasOwn(file, field)) return ABSENT;
  const raw = file[field];
  if (!isPlainRecord(raw)) return UNREADABLE;
  const salvaged = salvage(raw);
  return readSection(salvaged.value, salvaged.dropped);
}

interface SnapValues {
  readonly snapPauseModifier?: SnapPauseModifier;
  readonly snapRadius?: SnapRadiusChoice;
}

/**
 * 吸着の欄: 一時止める修飾キー(B-09 3-2)と吸着の幅(P-D)。どちらも無ければ欄が無い。知らない値の項目は捨てて数え、
 * 読めた項目が 1 つも無ければ欄ごと読まない(今の値のまま)。
 */
function readSnapSection(file: Readonly<Record<string, unknown>>): Section<SnapValues> {
  const present = (['snapPauseModifier', 'snapRadius'] as const).filter(field => Object.hasOwn(file, field)).length;
  if (present === 0) return ABSENT;
  const modifier = Object.hasOwn(file, 'snapPauseModifier') ? snapPauseModifierOf(file.snapPauseModifier) : null;
  const radius = Object.hasOwn(file, 'snapRadius') ? snapRadiusChoiceOf(file.snapRadius) : null;
  const read = (modifier === null ? 0 : 1) + (radius === null ? 0 : 1);
  if (read === 0) return UNREADABLE;
  return readSection({ ...(modifier === null ? {} : { snapPauseModifier: modifier }), ...(radius === null ? {} : { snapRadius: radius }) },
    present - read);
}

/** 版の欄が読み手より新しい整数か(未来の版は、壊れた版と分けて知らせる)。 */
function isFutureVersion(version: unknown): boolean {
  return typeof version === 'number' && Number.isSafeInteger(version) && version > FILE_VERSION;
}

/** 利用者が選んだファイルの中身を読む。どの欄も読めない時と、ファイル全体が合わない時は断る。 */
export function decodeInputSettingsFile(bytes: Uint8Array): InputSettingsReading | { readonly ok: false; readonly reason: InputSettingsRefusal } {
  if (bytes.byteLength > INPUT_SETTINGS_FILE_BYTES) return { ok: false, reason: 'tooLarge' };
  const parsed = parseJson(bytes);
  if (parsed === undefined) return { ok: false, reason: 'notJson' };
  if (!isPlainRecord(parsed) || parsed.format !== FILE_FORMAT) return { ok: false, reason: 'notSettings' };
  if (parsed.version !== FILE_VERSION) return { ok: false, reason: isFutureVersion(parsed.version) ? 'futureVersion' : 'badVersion' };
  const view = readViewSection(parsed), keys = readKeysSection(parsed);
  const mouse = readRecordSection(parsed, 'mouseButtonCommands', raw => {
    const salvaged = readMouseButtonCommands(raw);
    return { value: salvaged.commands, dropped: salvaged.dropped };
  });
  const radial = readRecordSection(parsed, 'radialCommands', raw => {
    const salvaged = readRadialCommands(raw);
    return { value: salvaged.commands, dropped: salvaged.dropped };
  });
  const snap = readSnapSection(parsed);
  if (![view, keys, mouse, radial, snap].some(section => section.reading.state === 'read')) return { ok: false, reason: 'nothingReadable' };
  return {
    ok: true,
    values: { viewControls: view.value, shortcutAssignments: keys.value, mouseButtonCommands: mouse.value, radialCommands: radial.value,
      snapPauseModifier: snap.value?.snapPauseModifier, snapRadius: snap.value?.snapRadius },
    sections: { view: view.reading, keys: keys.reading, mouse: mouse.reading, radial: radial.reading, snap: snap.reading },
    unknownFields: Object.keys(parsed).filter(key => !KNOWN_FIELDS.has(key)).length,
  };
}

/** 視点のキーのうち、命令のキーと同じ押し方になる物を外す(3D の上で両方が動かないよう、適用の検査と同じ判定)。 */
function withoutCollidingKeys(view: ViewControlSettings, assignments: ShortcutAssignments): ViewControlSettings {
  const colliding = new Set(viewKeyCollisions(view, assignments).map(item => viewTriggerKey(item.trigger)));
  if (colliding.size === 0) return view;
  const keep = (list: readonly ViewTrigger[]): readonly ViewTrigger[] => list.filter(trigger => !colliding.has(viewTriggerKey(trigger)));
  return { ...view, bindings: { orbit: keep(view.bindings.orbit), pan: keep(view.bindings.pan), zoom: keep(view.bindings.zoom) } };
}

const triggerCount = (view: ViewControlSettings): number => Object.values(view.bindings).reduce((sum, list) => sum + list.length, 0);

interface InputSettingsPlan {
  /** 置き換えた後の表示設定。ファイルに無い欄は今の値のまま(同じ物)。 */
  readonly next: DisplaySettings;
  /** 命令のキーと重なったために外した、ファイルの視点のキーの数。 */
  readonly viewKeysDropped: number;
  /** 置き換えられない(今の視点のキーとファイルのキーの割り当てが重なる)。true なら置き換えない。 */
  readonly blocked: boolean;
}

/**
 * 読んだ内容で置き換えた後の設定を作る。ファイルの視点のキーが命令のキーと重なれば、その視点のキーだけを外す。
 * 視点の操作がファイルに無く、今の視点のキーとファイルのキーの割り当てが重なる時は、どちらも勝手に変えずに置き換えを止める。
 */
export function planInputSettingsImport(current: DisplaySettings, reading: InputSettingsReading): InputSettingsPlan {
  const { values } = reading;
  const assignments = values.shortcutAssignments ?? currentShortcutAssignments(current);
  const view = values.viewControls === undefined ? currentViewControls(current) : withoutCollidingKeys(values.viewControls, assignments);
  const next: DisplaySettings = {
    ...current,
    ...(values.viewControls === undefined ? {} : { viewControls: view, viewControlsRecovered: undefined }),
    ...(values.shortcutAssignments === undefined ? {} : { shortcutAssignments: values.shortcutAssignments, shortcutAssignmentsRecovered: undefined }),
    ...(values.mouseButtonCommands === undefined ? {} : { mouseButtonCommands: values.mouseButtonCommands, mouseButtonCommandsRecovered: undefined }),
    ...(values.radialCommands === undefined ? {} : { radialCommands: values.radialCommands, radialCommandsRecovered: undefined }),
    ...(values.snapPauseModifier === undefined ? {} : { snapPauseModifier: values.snapPauseModifier }),
    ...(values.snapRadius === undefined ? {} : { snapRadius: values.snapRadius }),
  };
  return {
    next,
    viewKeysDropped: values.viewControls === undefined ? 0 : triggerCount(values.viewControls) - triggerCount(view),
    blocked: !isViewControlSettings(view) || viewKeyCollisions(view, assignments).length > 0,
  };
}

/** 置き換えの対象の 5 つの欄の今の値(元に戻すための控え)。 */
export function inputSettingsValuesOf(settings: DisplaySettings): InputSettingsValues {
  return { viewControls: settings.viewControls, shortcutAssignments: settings.shortcutAssignments,
    mouseButtonCommands: settings.mouseButtonCommands, radialCommands: settings.radialCommands,
    snapPauseModifier: settings.snapPauseModifier, snapRadius: settings.snapRadius };
}

/** 置き換えた後に 5 つの欄がどれも変わっていない時だけ、元に戻せる(後の変更を黙って消さない)。 */
export function canUndoInputSettings(current: DisplaySettings, written: InputSettingsValues): boolean {
  return current.viewControls === written.viewControls && current.shortcutAssignments === written.shortcutAssignments
    && current.mouseButtonCommands === written.mouseButtonCommands && current.radialCommands === written.radialCommands
    && current.snapPauseModifier === written.snapPauseModifier && current.snapRadius === written.snapRadius;
}
