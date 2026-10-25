import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createExportRequest,
  EXPORT_QUALITIES,
  DEFAULT_EXPORT_ASCII,
  DEFAULT_EXPORT_QUALITY,
  DEFAULT_EXPORT_SCOPE,
  DEFAULT_EXPORT_WITH_COLORS,
  EXPORT_DEVIATION_MM,
  selectExportBodies,
  type ExportQuality,
  type ExportRequest,
  type ExportScope,
  type LengthUnit,
  type PrintabilityReport,
  type SketchToDxfInput,
  type SolidBody,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import { resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { workPlaneOfSketch } from '../store/documentDerived.js';
import { currentPrintabilityReport } from '../store/exchangeSlice.js';
import { beginDocumentRequest, captureDocumentIdentity, compareDocumentIdentity,
  type DocumentIdentity } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import { displayMeshDimensionsMm, formatDisplayMeshDimensions, parseExportDeviationMm } from './exportPrecision.js';
import {
  dxfExportRefusal,
  EXPORT_PANEL_FORMAT_ORDER,
  exportPanelShape,
  exportRefusalKey,
  prepareExport,
  consumePreparedExport,
  runExport,
  runExportDxf,
  type ExchangeDeps,
  type ExportPreparation,
  type ExportPanelFormat,
} from './exchangeFile.js';

/**
 * 書き出しのパネル(計画書 docs/plans/P6-入出力.md §0.a-0.20・§0.a-0.34、タスク32・53)。
 *
 * 対応要件: FR-803(形式と品質)、FR-813(DXF)、FR-427(すべて / 選んだ立体)、
 * FR-811(単位の案内)、NFR-UX-2(モーダルにしない)、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できないことは押す前に断る)。
 *
 * **形式は 6 つで、6 つ目の DXF だけ書き出すものが違う**(§0.a-0.34)。前の 5 つは立体を、
 * DXF は**いま編集しているスケッチの平らな線**を書き出す。入口を 2 つに割らないのは、
 * 利用者にとって「書き出す」は 1 つの操作だからである(NFR-UX-1)。
 *
 * **その場に浮かぶパネル 1 枚**で、固定の区画は増やさない(要件§7.1、rules/04)。
 * 覆いを作らないので、開いている間も背後の視点操作はそのまま効く(`SettingsPanel` と同じ作り)。
 *
 * **どの欄を出すかは `exportPanelShape` の 1 か所で決める**(形式ごとの `if` をここへ散らさない)。
 * 断りも `exportRefusalKey` が返したものをそのまま赤で出すだけで、ここで判定を書き直さない。
 *
 * 選んだ形式・なめらかさは**この 1 回の操作のあいだだけの一時状態**なので、ストアではなく
 * ここで持つ(`SettingsPanel` の開閉と同じ扱い。rules/04 の「状態はストア 1 本」は
 * 部品文書と端末の好みが対象で、押している間だけの選択はここでよい)。
 */

/**
 * 形式の呼び名。**形式そのものの名前(固有名詞)**なので `ja.json` を通さない
 * (`fileGateway.ts` の `FileKindSpec.label`、`solidSummary.ts` の
 * `IMPORTED_SOURCE_FORMAT_NAMES` と同じ扱い)。
 */
const FORMAT_LABELS: Readonly<Record<ExportPanelFormat, string>> = {
  step: 'STEP',
  stl: 'STL',
  '3mf': '3MF',
  obj: 'OBJ',
  glb: 'glTF',
  dxf: 'DXF',
};

/** なめらかさの 3 択の名前(§0.a-0.20。裏の数は見せない)。 */
const QUALITY_LABEL_KEYS: Readonly<Record<ExportQuality, MessageKey>> = {
  coarse: 'exchange.qualityCoarse',
  normal: 'exchange.qualityStandard',
  fine: 'exchange.qualityFine',
};

/** 対象の 2 択の名前(FR-427)。 */
const SCOPE_LABEL_KEYS: Readonly<Record<ExportScope, MessageKey>> = {
  all: 'exchange.targetAll',
  selected: 'exchange.targetSelected',
};

const SCOPES: readonly ExportScope[] = ['all', 'selected'];

/**
 * 立体の断りの文言のキーを、画面へ出す 1 文へ直す(出さないときは `null` のまま)。
 * DXF の断りは model が文そのものを持っている(`dxfExportRefusal`)ので、
 * **両方を「文か null か」の同じ形へそろえてから**画面へ渡す。
 */
function refusalTextOf(key: MessageKey | null): string | null {
  return key === null ? null : t(key);
}

export interface ExchangePanelProps {
  /** 閉じる(「やめる」を押した / 書き出せた)。 */
  readonly onClose: () => void;
  /** 外の世界へ触れる口(ファイルの出し入れ・幾何カーネル)。 */
  readonly deps: ExchangeDeps;
  /** 書き出せたときの案内(落とした三角形・弾いた立体)。帯へ出すのは呼び出し側。 */
  readonly onFinished: (notices: readonly string[]) => void;
  /** 書き出せなかったときの理由。取り消しでは呼ばない。 */
  readonly onFailed: (message: string) => void;
  /** 外側クリックでも保存前に試行を失効させるための、パネル寿命内だけの口。 */
  readonly abortAttemptRef?: { current: (() => void) | null };
}

interface ActiveExportAttempt {
  readonly controller: AbortController;
  readonly cancel: () => void;
}

interface ExportPreview {
  readonly controller: AbortController;
  readonly identity: DocumentIdentity;
  readonly bodies: readonly SolidBody[];
  readonly selection: readonly string[];
  readonly fileName: string | null;
  readonly meshRefs: readonly SolidBody['mesh'][];
  readonly requestedGeneration: number;
  readonly completedGeneration: number;
  readonly deps: ExchangeDeps;
  readonly settings: PreviewSettings;
  readonly settingsRevision: number;
  consumed: boolean;
  promise: Promise<ExportPreparation>;
}

interface PreviewSettings {
  readonly format: ExportPanelFormat;
  readonly scope: ExportScope;
  readonly quality: ExportQuality;
  readonly customQuality: boolean;
  readonly customDeviationSource: string;
  readonly withColors: boolean;
  readonly ascii: boolean;
}

function samePreviewSettings(left: PreviewSettings, right: PreviewSettings): boolean {
  return left.format === right.format && left.scope === right.scope && left.quality === right.quality
    && left.customQuality === right.customQuality && left.customDeviationSource === right.customDeviationSource
    && left.withColors === right.withColors && left.ascii === right.ascii;
}

interface BlockedPreviewBody {
  readonly bodies: readonly SolidBody[];
  readonly completedGeneration: number;
}

/**
 * 画面で選んでいる立体のフィーチャー id(FR-427)。
 *
 * 選択は面や辺の id も含む(`solid-1#face-3` のような形)ので、フィーチャーの id まで
 * たどってから**重複を落とす**。同じ立体の面を 3 枚選んでいても立体は 1 つである。
 */
export function selectedBodyFeatureIds(selection: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const elementId of selection) {
    const featureId = featureIdOf(elementId);
    if (!found.includes(featureId)) {
      found.push(featureId);
    }
  }
  return found;
}

/** A pre-export readout; its triangle count is deliberately unknown until native export finishes. */
export function ExportPrintPreflight({ targetBodies, unit, deviationMm, checkedReport, triangleCount, calculating = false }: {
  readonly targetBodies: readonly SolidBody[];
  readonly unit: LengthUnit;
  readonly deviationMm: number | null;
  readonly checkedReport: PrintabilityReport | null;
  readonly triangleCount?: number | null;
  readonly calculating?: boolean;
}): React.JSX.Element {
  const dimensions = displayMeshDimensionsMm(targetBodies.map((body) => ({
    positions: body.mesh.positions, coordinateFrame: body.coordinateFrame,
  })));
  const isClosedBody = targetBodies.length > 0 && targetBodies.every((body) =>
    body.isValid && (body.bodyKind ?? 'solid') === 'solid');
  return <div className="pcad-exchange__group" role="group" aria-label={t('exchange.printPreflight')}>
    <span className="pcad-exchange__label">{t('exchange.printPreflight')}</span>
    <dl className="pcad-properties">
      <dt className="pcad-properties__key">{t('exchange.preflightDimensions')}</dt>
      <dd className="pcad-properties__value">{dimensions === null ? t('exchange.notCalculated')
        : formatDisplayMeshDimensions(dimensions, unit)}</dd>
      <dt className="pcad-properties__key">{t('exchange.preflightUnit')}</dt>
      <dd className="pcad-properties__value">{t('exchange.unitMillimeter')}</dd>
      <dt className="pcad-properties__key">{t('exchange.preflightClosed')}</dt>
      <dd className="pcad-properties__value">{targetBodies.length === 0
        ? t('exchange.notCalculated')
        : checkedReport !== null
          ? t(checkedReport.summary.watertight ? 'exchange.printCheckClosed' : 'exchange.closedCheckFailed')
          : t(isClosedBody ? 'exchange.closedBodyUnverified' : 'exchange.closedUnverified')}</dd>
      <dt className="pcad-properties__key">{t('exchange.preflightDeviation')}</dt>
      <dd className="pcad-properties__value">{deviationMm === null
        ? t('exchange.notCalculated') : `${deviationMm} mm`}</dd>
      <dt className="pcad-properties__key">{t('exchange.preflightTriangles')}</dt>
      <dd className="pcad-properties__value">{triangleCount === undefined || triangleCount === null
        ? t(calculating ? 'exchange.preflightCalculating' : 'exchange.notCalculated') : triangleCount}</dd>
      <dt className="pcad-properties__key">{t('exchange.preflightPrintCheck')}</dt>
      <dd className="pcad-properties__value">{checkedReport === null ? t('exchange.printCheckNotCurrent')
        : checkedReport.cancelled ? t('exchange.printCheckPartial')
          : checkedReport.summary.watertight ? t('exchange.printCheckClosed')
            : t('exchange.closedCheckFailed')}</dd>
    </dl>
    <p className="pcad-exchange__notice">{t('exchange.preflightDimensionsNote')}</p>
  </div>;
}

export function ExchangePanel({
  onClose,
  deps,
  onFinished,
  onFailed,
  abortAttemptRef,
}: ExchangePanelProps): React.JSX.Element {
  const bodies = useAppStore((state) => state.bodies);
  const selection = useAppStore((state) => state.selection);
  const fileName = useAppStore((state) => state.fileName);
  const renderedComputing = useAppStore((state) => state.isComputing);
  const renderedRequestedGeneration = useAppStore((state) => state.requestedGeneration);
  const renderedCompletedGeneration = useAppStore((state) => state.completedGeneration);
  // 3D プリントの点検の結果(FR-815、タスク42・43)。点検済みなら促す 1 行を出さない。
  const printability = useAppStore(currentPrintabilityReport);
  const printabilityOwner = useAppStore((state) => state.printabilityOwner);
  const displayLengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  // DXF の書き出しが見るもの(§0.a-0.34)。**いま編集しているスケッチだけ**を書き出す。
  const document = useAppStore((state) => state.document);
  const sketch = useAppStore((state) => state.sketch);
  const resolvedSketch = useAppStore((state) => state.resolvedSketch);
  const workPlane = useAppStore((state) => state.workPlane);
  const renderedIdentity = captureDocumentIdentity(useAppStore.getState());

  const [format, setFormat] = useState<ExportPanelFormat>('step');
  const [scope, setScope] = useState<ExportScope>(DEFAULT_EXPORT_SCOPE);
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_EXPORT_QUALITY);
  const [customQuality, setCustomQuality] = useState(false);
  const [customDeviationSource, setCustomDeviationSource] = useState('0.05');
  const [withColors, setWithColors] = useState(DEFAULT_EXPORT_WITH_COLORS);
  const [ascii, setAscii] = useState(DEFAULT_EXPORT_ASCII);
  const renderedSettings: PreviewSettings = {
    format, scope, quality, customQuality, customDeviationSource, withColors, ascii,
  };
  const settingsRevision = useRef(0);
  const latestSettings = useRef(renderedSettings);
  latestSettings.current = renderedSettings;
  const renderedSettingsRevision = settingsRevision.current;
  const settingsAreCurrent = (): boolean => settingsRevision.current === renderedSettingsRevision
    && samePreviewSettings(renderedSettings, latestSettings.current);
  /** 書き出しの最中は二重に押させない(Enter 連打で 2 つのファイルを作らない)。 */
  const [running, setRunning] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | 'loading' | null>(null);
  const activeAttempt = useRef<ActiveExportAttempt | null>(null);
  const activeCurrentCheck = useRef<(() => boolean) | null>(null);
  const activePreview = useRef<ExportPreview | null>(null);
  const blockedPreviewBody = useRef<BlockedPreviewBody | null>(null);
  const previewClosed = useRef(false);
  const previewIsCurrent = useCallback((preview: ExportPreview): boolean => {
    const latest = useAppStore.getState();
    return !previewClosed.current && activePreview.current === preview && !preview.consumed
      && !preview.controller.signal.aborted
      && preview.settingsRevision === settingsRevision.current
      && samePreviewSettings(preview.settings, latestSettings.current)
      && compareDocumentIdentity(preview.identity, latest) === 'current'
      && latest.bodies === preview.bodies && latest.selection === preview.selection
      && latest.fileName === preview.fileName && !latest.isComputing
      && latest.requestedGeneration === preview.requestedGeneration
      && latest.completedGeneration === preview.completedGeneration
      && latest.bodies.length === preview.meshRefs.length
      && latest.bodies.every((body, index) => body.mesh === preview.meshRefs[index]);
  }, []);
  const abortPreview = useCallback((updateView = true): void => {
    const prior = activePreview.current;
    activePreview.current = null;
    prior?.controller.abort();
    if (updateView) setPreviewCount(null);
  }, []);
  const abortRunning = (): void => {
    if (activeAttempt.current === null) return;
    activeAttempt.current.cancel();
    setRunning(false);
  };
  const invalidateSettings = (patch: Partial<PreviewSettings>): void => {
    const nextSettings = { ...latestSettings.current, ...patch };
    if (samePreviewSettings(latestSettings.current, nextSettings)) return;
    settingsRevision.current += 1;
    latestSettings.current = nextSettings;
    abortRunning();
    abortPreview();
  };
  useEffect(() => {
    previewClosed.current = false;
    return () => { previewClosed.current = true; abortPreview(false); activeAttempt.current?.cancel(); };
  }, [abortPreview]);
  useEffect(() => useAppStore.subscribe(() => {
    if (activeAttempt.current !== null && activeCurrentCheck.current !== null && !activeCurrentCheck.current()) {
      activeAttempt.current.cancel();
      setRunning(false);
    }
    const preview = activePreview.current;
    if (preview !== null && !previewIsCurrent(preview)) {
      if (compareDocumentIdentity(preview.identity, useAppStore.getState()) !== 'current') {
        blockedPreviewBody.current = { bodies: preview.bodies, completedGeneration: preview.completedGeneration };
      }
      abortPreview();
    }
  }), [abortPreview, previewIsCurrent]);
  const closePanel = (): void => { previewClosed.current = true; abortPreview(); abortRunning(); onClose(); };

  const shape = exportPanelShape(format);
  const customDeviationMm = customQuality ? parseExportDeviationMm(customDeviationSource) : null;
  const precisionError = shape.showsQuality && customQuality && customDeviationMm === null
    ? t('exchange.deviationInvalid') : null;
  /**
   * 立体を書き出す形式のときだけ依頼を組む。DXF は立体を 1 つも見ない(§0.a-0.34)ので
   * `null` にして、下の断りも実行も別の枝へ分ける。
   */
  const request: ExportRequest | null =
    format === 'dxf'
      ? null
      : createExportRequest(format, {
          scope,
          selectedFeatureIds: selectedBodyFeatureIds(selection),
          quality,
          customDeviationMm: customQuality && customDeviationMm !== null ? customDeviationMm : undefined,
          /*
            **出していない欄の指定は渡さない**(タスク45 の指摘、2026-09-06)。色の切替を
            出していない形式(STL)へ既定の `true` を渡すと、カーネルへ「色を付けて」と
            頼んだうえで「この形式に色はありません」と警告が返る——利用者は色の欄を
            見ていないので直しようがない。ここで偽にしておけば、頼み事そのものが消える。
            なめらかさ(`quality`)は依頼の欄が必須で、渡さなくても既定が入り model の
            判定も変わらないので、そちらは `visibleExportWarnings` が警告の側を落とす。
          */
          withColors: shape.showsColor ? withColors : false,
          ascii,
        });

  /*
    DXF を書き出す先の作図面(§0.a-0.34「作図面の上の 2 次元へ落とす」)。
    **スケッチが最後に使った作図面**を使う——いまの作図面(`workPlane`)は「次に描く面」で、
    描き終わったスケッチの面とは限らない。まだ 1 つも要素が無いスケッチだけは面を決め
    ようがないので、いまの作図面へ落とす(そのときは書き出す図形も 0 個で断りが出る)。
  */
  const sketchPlaneId = workPlaneOfSketch(sketch);
  const dxfInput: SketchToDxfInput = {
    document: sketch,
    resolved: resolvedSketch,
    plane: sketchPlaneId === null ? workPlane : resolveWorkPlaneOf(document, sketchPlaneId),
  };

  /**
   * 押す前の断り(NFR-UX-5)。立体の側は文言のキー、DXF の側は日本語の文で返るので、
   * **画面へ出す直前に文へそろえる**(判定そのものはどちらも `exchangeFile.ts` にある)。
   */
  const refusal: string | null = precisionError ?? (
    request === null
      ? dxfExportRefusal(dxfInput, t)
      : refusalTextOf(exportRefusalKey(bodies, request)));
  /*
    3D プリント向けの形式(STL / 3MF)で、まだ一度も点検していないときの 1 行
    (FR-815、§0.53)。**判定はここ 1 か所**で、形式ごとの `if` を画面へ散らさない。
    3MF は色を持てるので `showsNoColorNotice` では拾えず、形式そのものを見る。
  */
  const isPrintFormat = format === 'stl' || format === '3mf';
  const selectionOutcome = request === null ? null : selectExportBodies(bodies, request);
  const targetBodies = selectionOutcome?.ok
    ? bodies.filter((body) => selectionOutcome.selection.featureIds.includes(body.featureId))
    // A refused export still needs diagnostics for the requested bodies.
    // Successful mixed exports retain their actual export subset.
    : request === null ? [] : request.scope === 'all' ? bodies
      : bodies.filter((body) => request.selectedFeatureIds.includes(body.featureId));
  const checkedTargets = printability !== null && printabilityOwner !== null
    && printabilityOwner.targets.length === targetBodies.length
    && printabilityOwner.targets.every((target) => targetBodies.some((body) =>
      body.featureId === target.featureId && body.mesh === target.mesh));
  const checkedReport = checkedTargets ? printability : null;
  const showsPrintCheckHint = isPrintFormat && checkedReport === null;
  const deviation = request?.customDeviationMm ?? EXPORT_DEVIATION_MM[quality];

  const startPreview = (): ExportPreview | null => {
    if (!isPrintFormat || request === null || refusal !== null || previewClosed.current || running
        || !settingsAreCurrent()) return null;
    if (activePreview.current !== null) {
      if (previewIsCurrent(activePreview.current) && activePreview.current.deps === deps) return activePreview.current;
      abortPreview();
    }
    const owner = useAppStore.getState();
    if (owner.bodies !== bodies || owner.selection !== selection || owner.fileName !== fileName
        || compareDocumentIdentity(renderedIdentity, owner) !== 'current'
        || owner.isComputing !== renderedComputing
        || owner.requestedGeneration !== renderedRequestedGeneration
        || owner.completedGeneration !== renderedCompletedGeneration
        || owner.isComputing || owner.requestedGeneration !== owner.completedGeneration) return null;
    const blocked = blockedPreviewBody.current;
    if (blocked !== null && owner.bodies === blocked.bodies
        && owner.completedGeneration === blocked.completedGeneration) return null;
    blockedPreviewBody.current = null;
    const controller = new AbortController();
    const preview: ExportPreview = {
      controller, identity: captureDocumentIdentity(owner), bodies, selection, fileName,
      meshRefs: bodies.map((body) => body.mesh), requestedGeneration: owner.requestedGeneration,
      completedGeneration: owner.completedGeneration, deps, settings: renderedSettings,
      settingsRevision: renderedSettingsRevision, consumed: false,
      promise: Promise.resolve({ ok: false, cancelled: true }),
    };
    activePreview.current = preview;
    setPreviewCount('loading');
    const previewControl = { signal: controller.signal, isCurrent: () => previewIsCurrent(preview) };
    preview.promise = prepareExport(deps, bodies, request, fileName, previewControl);
    void preview.promise.then((result) => {
      if (!previewIsCurrent(preview)) return;
      const count = result.ok ? result.prepared.outcome.triangleCount : undefined;
      setPreviewCount(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null);
    }, () => { if (previewIsCurrent(preview)) setPreviewCount(null); });
    return preview;
  };
  useEffect(() => { if (!running) startPreview(); });

  const submit = (): void => {
    if (refusal !== null || running || activeAttempt.current !== null || previewClosed.current
        || !settingsAreCurrent()) {
      return;
    }
    const owner = useAppStore.getState();
    if (owner.bodies !== bodies || owner.selection !== selection || owner.fileName !== fileName
        || compareDocumentIdentity(renderedIdentity, owner) !== 'current'
        || owner.sketch !== sketch || owner.resolvedSketch !== resolvedSketch || owner.workPlane !== workPlane
        || owner.isComputing || owner.requestedGeneration !== owner.completedGeneration) return;
    const submitPreview = isPrintFormat ? startPreview() : null;
    if (isPrintFormat && submitPreview === null) return;
    const guideSession = owner.tutorialSession?.course === 'parameterToExport'
      && owner.tutorialSession.documentId === owner.document.id ? owner.tutorialSession : null;
    const ownerDocument = owner.document;
    const ownerVersion = owner.documentVersion;
    const documentRequest = beginDocumentRequest('export', owner);
    const attempt = owner.beginExportHandoff();
    const controller = new AbortController();
    const attemptState: ActiveExportAttempt = { controller, cancel: (): void => {
      controller.abort();
      abortPreview();
      if (activeAttempt.current === attemptState) activeAttempt.current = null;
      if (activeCurrentCheck.current === control.isCurrent) activeCurrentCheck.current = null;
      if (abortAttemptRef?.current === attemptState.cancel) abortAttemptRef.current = null;
      const latest = useAppStore.getState();
      if (latest.exportHandoffAttempt === attempt) latest.clearExportHandoff();
    } };
    activeAttempt.current = attemptState;
    if (abortAttemptRef !== undefined) abortAttemptRef.current = attemptState.cancel;
    const control = { signal: controller.signal, isCurrent: (): boolean => {
      const latest = useAppStore.getState();
      return activeAttempt.current === attemptState && !controller.signal.aborted
        && latest.exportHandoffAttempt === attempt && documentRequest.isCurrent()
        && latest.bodies === owner.bodies && latest.selection === owner.selection
        && latest.fileName === owner.fileName && latest.sketch === owner.sketch
        && latest.resolvedSketch === owner.resolvedSketch && latest.workPlane === owner.workPlane
        && latest.requestedGeneration === owner.requestedGeneration
        && latest.completedGeneration === owner.completedGeneration && !latest.isComputing;
    } };
    activeCurrentCheck.current = control.isCurrent;
    setRunning(true);
    const started =
      request === null
        ? runExportDxf(deps, dxfInput, fileName, control)
        : submitPreview === null ? runExport(deps, bodies, request, fileName, control)
          : submitPreview.promise.then((preparation) => {
              if (!control.isCurrent() || !previewIsCurrent(submitPreview)) return { ok: false, cancelled: true } as const;
              if (preparation.ok === false) return preparation;
              submitPreview.consumed = true;
              activePreview.current = null;
              setPreviewCount(null);
              return consumePreparedExport(deps, preparation.prepared, control);
            });
    void started.then(
      (outcome) => {
        if (!control.isCurrent()) return;
        activeAttempt.current = null;
        activeCurrentCheck.current = null;
        if (abortAttemptRef?.current === attemptState.cancel) abortAttemptRef.current = null;
        setRunning(false);
        useAppStore.getState().finishExportHandoff(attempt, outcome.ok ? outcome.handoff ?? null : null);
        if (outcome.ok) {
          const latest = useAppStore.getState();
          if (guideSession !== null && (request?.format === 'step' || request?.format === 'stl')
              && latest.tutorialSession === guideSession && latest.document === ownerDocument
              && latest.documentVersion === ownerVersion && latest.activeDocumentId === owner.activeDocumentId
              && selectionOutcome?.ok && targetBodies.some(body => body.featureId === guideSession.extrudeId)) {
            latest.setTutorialExports({ ...latest.tutorialExports, [request.format]: ownerDocument });
          }
          /*
            **成功は成功の口で知らせる**(タスク45 の指摘、2026-09-06)。書き出せたことを
            `setError` で出すと、ステータスバーが「計算に失敗しました:」を頭に付けて赤く
            するので、うまくいったのに失敗したように見えた。ここは保存と同じ口
            (`fileMessage`、`failed: false`)を通すので、落ち着いた調子の 1 行になる。
            残る警告(弾いた立体・落とした三角形)は呼び出し側へそのまま渡す。
          */
          useAppStore.getState().setFileMessage({ key: 'exchange.exported', failed: false });
          onFinished(outcome.notices);
          closePanel();
          return;
        }
        // 取り消しは失敗ではない。断りも出さず、パネルは開いたままにする(NFR-UX-3)。
        if (!('cancelled' in outcome)) {
          onFailed(outcome.message);
        }
      },
      (error: unknown) => {
        if (!control.isCurrent()) return;
        activeAttempt.current = null;
        activeCurrentCheck.current = null;
        if (abortAttemptRef?.current === attemptState.cancel) abortAttemptRef.current = null;
        setRunning(false);
        useAppStore.getState().finishExportHandoff(attempt, null);
        onFailed(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <form
      className="pcad-menu__panel pcad-exchange"
      /*
        押す前に断る形にしてあるので、`form` の submit をそのまま実行の合図にできる。
        こうしておくと**どの欄に焦点があっても Enter で書き出せる**(NFR-UX-4)。
      */
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          closePanel();
        }
      }}
      aria-label={t('exchange.exportTitle')}
    >
      <span className="pcad-exchange__title">{t('exchange.exportTitle')}</span>

      <div className="pcad-exchange__group">
        <span className="pcad-exchange__label">{t('exchange.format')}</span>
        <div className="pcad-exchange__choices" role="radiogroup" aria-label={t('exchange.format')}>
          {EXPORT_PANEL_FORMAT_ORDER.map((candidate) => (
            <button title={t('controlGuide.exchange.format')}
              key={`format-${candidate}`}
              type="button"
              className="pcad-exchange__choice"
              role="radio"
              aria-checked={candidate === format}
              tabIndex={candidate === format ? 0 : -1}
              onClick={() => {
                invalidateSettings({ format: candidate });
                setFormat(candidate);
              }}
            >
              {FORMAT_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      {/*
        「対象」の欄は必ず 1 つ出る。立体の形式では 2 択、DXF では「いま編集している
        スケッチ」の 1 行になる(§0.a-0.34。選びようが無いものを選ばせない)。
      */}
      <div className="pcad-exchange__group">
        <span className="pcad-exchange__label">{t('exchange.target')}</span>
        {shape.showsBodyScope ? (
          <div
            className="pcad-exchange__choices"
            role="radiogroup"
            aria-label={t('exchange.target')}
          >
            {SCOPES.map((candidate) => (
              <button title={t('controlGuide.exchange.scope')}
                key={`scope-${candidate}`}
                type="button"
                className="pcad-exchange__choice"
                role="radio"
                aria-checked={candidate === scope}
                tabIndex={candidate === scope ? 0 : -1}
                onClick={() => {
                  invalidateSettings({ scope: candidate });
                  setScope(candidate);
                }}
              >
                {t(SCOPE_LABEL_KEYS[candidate])}
              </button>
            ))}
          </div>
        ) : null}
        {shape.showsSketchTarget ? (
          <span className="pcad-exchange__value">{t('exchange.targetActiveSketch')}</span>
        ) : null}
      </div>

      {/* DXF は曲線をそのまま持てないので、押す前に知らせる(NFR-UX-5)。 */}
      {shape.showsSketchTarget ? (
        <p className="pcad-exchange__notice">{t('exchange.dxfCurveNotice')}</p>
      ) : null}

      {/* なめらかさは三角形を使う形式のときだけ(§0.a-0.20)。 */}
      {shape.showsQuality ? (
        <div className="pcad-exchange__group">
          <span className="pcad-exchange__label">{t('exchange.quality')}</span>
          <div
            className="pcad-exchange__choices"
            role="radiogroup"
            aria-label={t('exchange.quality')}
          >
            {EXPORT_QUALITIES.map((candidate) => (
              <button title={t('controlGuide.exchange.quality')}
                key={`quality-${candidate}`}
                type="button"
                className="pcad-exchange__choice"
                role="radio"
                aria-checked={candidate === quality}
                tabIndex={candidate === quality ? 0 : -1}
                onClick={() => {
                  invalidateSettings({ quality: candidate, customQuality: false });
                  setQuality(candidate);
                  setCustomQuality(false);
                }}
              >
                {t(QUALITY_LABEL_KEYS[candidate])}
              </button>
            ))}
            <button type="button" className="pcad-exchange__choice" role="radio" title={t('controlGuide.exchange.qualityCustom')}
              aria-checked={customQuality} tabIndex={customQuality ? 0 : -1}
              onClick={() => { invalidateSettings({ customQuality: true }); setCustomQuality(true); }}>
              {t('exchange.qualityCustom')}
            </button>
          </div>
          {customQuality ? (
            <label className="pcad-exchange__toggle">
              {t('exchange.deviationInput')}
              <input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} title={t('controlGuide.exchange.deviation')}
                value={customDeviationSource} aria-invalid={precisionError !== null}
                onChange={(event) => { invalidateSettings({ customDeviationSource: event.target.value });
                  setCustomDeviationSource(event.target.value); }} />
              {t('exchange.deviationUnit')}
            </label>
          ) : null}
          <p className="pcad-exchange__notice">{t('exchange.deviationMeaning')}</p>
        </div>
      ) : null}

      {/* 文字で書くのは STL だけ(§0.a-0.14)。 */}
      {shape.showsAscii ? (
        <label className="pcad-exchange__toggle">
          <input title={t('controlGuide.exchange.ascii')}
            type="checkbox"
            checked={ascii}
            onChange={(event) => {
              invalidateSettings({ ascii: event.target.checked });
              setAscii(event.target.checked);
            }}
          />
          {t('exchange.ascii')}
        </label>
      ) : null}

      {/* 色を含めるのは色を持てる形式だけ。既定は入(§0.a-0.22)。 */}
      {shape.showsColor ? (
        <label className="pcad-exchange__toggle">
          <input title={t('controlGuide.exchange.colors')}
            type="checkbox"
            checked={withColors}
            onChange={(event) => {
              invalidateSettings({ withColors: event.target.checked });
              setWithColors(event.target.checked);
            }}
          />
          {t('exchange.includeColor')}
        </label>
      ) : null}

      {/* STL には色が無いので 1 行で断っておく(§0.a-0.15)。 */}
      {shape.showsNoColorNotice ? (
        <p className="pcad-exchange__notice">{t('exchange.stlNoColor')}</p>
      ) : null}

      {/*
        まだ点検していない 3D プリント向けの形式で、点検を促す 1 行(FR-815、§0.53)。
        **止めない**——「書き出す」は押せるままで、覆いも確認の窓も出さない
        (NFR-UX-3「確認ダイアログは復元不能な操作に限る」。書き出しはいつでもやり直せる)。
      */}
      {showsPrintCheckHint ? (
        <p className="pcad-exchange__notice">{t('exchange.printCheckHint')}</p>
      ) : null}

      {isPrintFormat ? (
        <ExportPrintPreflight targetBodies={targetBodies} unit={displayLengthUnit}
          deviationMm={precisionError === null ? deviation : null} checkedReport={checkedReport}
          triangleCount={typeof previewCount === 'number' ? previewCount : null}
          calculating={previewCount === 'loading'} />
      ) : null}

      {/* 単位の案内(§0.a-0.7。glTF だけメートル)。 */}
      <p className="pcad-exchange__notice">{t(shape.unitNoticeKey)}</p>

      {/* できないことは押す前に赤で断る(NFR-UX-5)。 */}
      {refusal === null ? null : (
        <p className="pcad-exchange__refusal" role="alert">
          {refusal}
        </p>
      )}

      <div className="pcad-exchange__actions">
        <button title={t('controlGuide.exchange.apply')} type="submit" className="pcad-button" disabled={refusal !== null || running}>
          {t('exchange.export')}
        </button>
        <button title={t('controlGuide.exchange.close')} type="button" className="pcad-button" onClick={closePanel}>
          {t('exchange.cancel')}
        </button>
      </div>
    </form>
  );
}
