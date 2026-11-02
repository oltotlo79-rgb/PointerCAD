// @ts-check
/**
 * 関数ごとの行数の上限（レビューE09）。製品の全関数は FUNCTION_SIZE_CAP 行まで（ESLint の
 * max-lines-per-function。空行とコメントだけの行は数えない）。
 *
 * FUNCTION_SIZE_BASELINE は、2026-11-02 の実測で上限を超えていた既存の関数だけを、その関数自身の実測値で
 * 固定する。識別子は囲む宣言の名前を「::」でつないだもの（行番号は使わない）。値は下げることだけができる:
 * 関数を縮めたら値を実測へ下げ、200行以下になったら行を消す。新しい行や値を上げる変更は追加しない。
 * packages/test-utils/src/functionSizePolicy.test.ts が実物の各関数と照合し、増加・縮小後の放置・消えた関数・
 * 一覧外の超過・識別できない重複を拒否する。eslint.config.js はファイルごとに最大の値を上限にする。
 */
export const FUNCTION_SIZE_CAP = 200;

/** @type {ReadonlyArray<{ readonly file: string, readonly functions: ReadonlyArray<readonly [string, number]> }>} */
export const FUNCTION_SIZE_BASELINE = [
  { file: 'packages/expression/src/math/adaptiveFunctionSurface.ts', functions: [['sampleSurfacePatch', 235]] },
  { file: 'packages/expression/src/math/decodeMathJson.ts', functions: [['decodeMathJson', 263], ['decodeMathJson::parse', 211]] },
  { file: 'packages/expression/src/math/functionDerivatives.ts', functions: [['expandFunctionDerivatives', 252]] },
  { file: 'packages/expression/src/math/mathTextSyntax.ts', functions: [['parseMathTextRaw', 249]] },
  { file: 'packages/expression/src/math/parseMathLatex.ts', functions: [['parseTokens', 288]] },
  { file: 'packages/expression/src/math/scalarCurveCurvature.ts', functions: [['directionalJet', 202]] },
  { file: 'packages/kernel/src/occt/analysisSurfaceMesh.ts', functions: [['buildAnalysisSurfaceMeshInternal', 255]] },
  { file: 'packages/kernel/src/worker/checkInterference.ts', functions: [['checkInterference', 283]] },
  { file: 'packages/kernel/src/worker/kernelApi.ts', functions: [['createKernelApi', 836]] },
  { file: 'packages/kernel/src/worker/recomputeSolids.ts', functions: [['createStepSolid', 201]] },
  { file: 'packages/kernel/src/worker/shapeCache.ts', functions: [['createShapeCache', 321]] },
  { file: 'packages/model/src/analysis/cadWeldLayer.ts', functions: [['prepareCadWeldLayersOwned', 214]] },
  { file: 'packages/model/src/assembly/constraints/solveMates.ts', functions: [['solveMatesCoreSteps', 214]] },
  { file: 'packages/model/src/kernelBridge.ts', functions: [['createBridgeMeshLedger', 222], ['createKernelBridge', 767]] },
  { file: 'packages/model/src/kernelBridge/solidRequests.ts', functions: [['toSolidStepSpec', 259]] },
  { file: 'packages/model/src/part/cacheKey.ts', functions: [['keyMaterialText', 221]] },
  { file: 'packages/model/src/part/evaluateDocumentMath.ts', functions: [['evaluateDocumentMath', 210]] },
  { file: 'packages/model/src/part/resolveReferences.ts', functions: [['createReferenceResolver', 579]] },
  { file: 'packages/model/src/part/solidPlanKeyMaterial.ts', functions: [['keyMaterialFor', 258]] },
  { file: 'packages/model/src/sketch/constraints/diagnose.ts', functions: [['diagnoseConstraints', 221]] },
  { file: 'packages/model/src/sketch/constraints/solve.ts', functions: [['createLevenbergMarquardtJob', 218]] },
  { file: 'packages/model/src/sketch/constraints/variables.ts', functions: [['collectVariables', 228]] },
  { file: 'packages/model/src/sketch/resolveSketch.ts', functions: [['resolveSketch', 581]] },
  { file: 'packages/ui/src/appearance/AppearanceSection.tsx', functions: [['AppearanceSection', 299]] },
  { file: 'packages/ui/src/assembly/StandardPartPickerPanel.tsx', functions: [['StandardPartPicker', 384]] },
  { file: 'packages/ui/src/assembly/attachAssembly.ts', functions: [['attachAssembly', 535], ['attachAssembly::calculate', 322]] },
  { file: 'packages/ui/src/commands/attachRadialMenuGesture.ts', functions: [['attachRadialMenuGesture', 204]] },
  { file: 'packages/ui/src/drawing/DrawingCanvas.tsx', functions: [['DrawingCanvas', 332]] },
  { file: 'packages/ui/src/fatigue/FatiguePanel.tsx', functions: [['FatiguePanel', 318]] },
  { file: 'packages/ui/src/file/ExchangePanel.tsx', functions: [['ExchangePanel', 444]] },
  { file: 'packages/ui/src/parameters/ParameterPanel.tsx', functions: [['ParameterPanel', 559]] },
  { file: 'packages/ui/src/shell/AppShell.tsx', functions: [['AppShell', 231]] },
  { file: 'packages/ui/src/shell/AssemblyTree.tsx', functions: [['AssemblyTree', 375]] },
  { file: 'packages/ui/src/shell/FeatureTree.tsx', functions: [['FeatureTree', 700]] },
  { file: 'packages/ui/src/shell/PropertyPanel.tsx', functions: [['FeatureProperties', 339], ['SolidProperties', 286]] },
  { file: 'packages/ui/src/shell/StatusBar.tsx', functions: [['StatusBar', 378]] },
  { file: 'packages/ui/src/shell/Toolbar.tsx', functions: [['Toolbar', 440]] },
  { file: 'packages/ui/src/sketch/NumericInputPopover.tsx', functions: [['NumericInputPopover', 259]] },
  { file: 'packages/ui/src/solid/solidSummary.ts', functions: [['summarizeSolid', 419]] },
  { file: 'packages/ui/src/solidAnalysis/attachSolidAnalysis.ts', functions: [['attachSolidAnalysis', 264]] },
  { file: 'packages/ui/src/store/assemblySlice.ts', functions: [['createAssemblySlice', 696]] },
  { file: 'packages/ui/src/store/attachKernel.ts', functions: [['attachPartRecompute', 299]] },
  { file: 'packages/ui/src/store/beamSlice.ts', functions: [['createBeamSlice', 227]] },
  { file: 'packages/ui/src/store/canvasSlice.ts', functions: [['createCanvasSlice', 263]] },
  { file: 'packages/ui/src/store/fatigueSlice.ts', functions: [['createFatigueSlice', 212]] },
  { file: 'packages/ui/src/store/solidAnalysisSlice.ts', functions: [['createSolidAnalysisSlice', 219]] },
  { file: 'packages/ui/src/viewcube/ViewCube.tsx', functions: [['ViewCube', 233], ['ViewCube::useEffect(#0)', 209]] },
  { file: 'packages/ui/src/viewport/ViewportCanvas.tsx', functions: [['ViewportCanvas', 710], ['ViewportCanvas::useEffect(#0)', 657], ['ViewportCanvas::useEffect(#0)::initializeViewport', 600]] },
  { file: 'packages/ui/src/viewport/attachAssemblyInteraction.ts', functions: [['attachAssemblyInteraction', 373]] },
  { file: 'packages/ui/src/viewport/attachSketchInteraction.ts', functions: [['attachSketchInteraction', 607]] },
  { file: 'packages/ui/src/viewport/createAssemblyLayer.ts', functions: [['createAssemblyLayer', 894]] },
  { file: 'packages/ui/src/viewport/createSketchLayer.ts', functions: [['createSketchLayer', 222]] },
  { file: 'packages/ui/src/viewport/createSolidLayer.ts', functions: [['createSolidLayer', 667]] },
  { file: 'packages/ui/src/viewport/createViewportScene.ts', functions: [['createViewportScene', 782]] },
  { file: 'packages/ui/src/viewport/sketchDragSession.ts', functions: [['createSketchDragSession', 292]] },
  { file: 'packages/ui/src/viewport/viewportRepairPreview.ts', functions: [['createViewportRepairPreview', 271]] },
];
