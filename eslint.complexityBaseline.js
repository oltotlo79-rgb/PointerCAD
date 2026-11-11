// @ts-check
/**
 * 引数の数と入れ子の深さの上限（コード規約 P06）。製品の全関数は引数 PARAMS_CAP 個まで（ESLint の max-params。
 * this: void は数えない既定のまま）、ブロックの入れ子は DEPTH_CAP 段まで（ESLint の max-depth）。適用範囲は
 * 関数の行数の上限（eslint.functionSizeBaseline.js、レビューE09）と同じ製品のソースで、検査と検査用の補助を除く。
 * 上限 6・5 は監査（scratchpad/claude/agents/cl-v103-code-consistency-audit/gap-report.md 表 5-1・P06）の提案値で、
 * 利用者の直接の指定値ではない。
 *
 * PARAMS_BASELINE・DEPTH_BASELINE は、上限を超えている既存の関数だけを、その関数自身の実測値で固定する。
 * 識別子は関数の行数の表と同じく、囲む宣言の名前を「::」でつないだもの（行番号は使わない）。入れ子は関数ごとに
 * [識別子, 最も深い段, 上限を超えたブロックの数] で持つ（関数の外は '<module>'）。値は下げることだけができる:
 * 縮めたら実測へ下げ、上限以内になったら行を消す。新しい行や値を上げる変更は追加しない。
 * packages/test-utils/src/complexityPolicy.test.ts が実物と照合し、増加・縮小後の放置・消えた関数・一覧外の超過・
 * 識別できない重複・行数と合計の天井を超える追加を拒否する。eslint.config.js はファイルごとに最大の値を上限にする。
 *
 * 表は 2026-11-03 に製品の 2,013 ファイルを ESLint 本体の 2 規則で実測した値（引数 72 ファイル・101 関数、入れ子 34 ファイル・39 関数）。
 * 行は既存の超過を新しく増やさないために固定したもので、その関数の品質が良いという意味ではない。
 */
export const PARAMS_CAP = 6;
export const DEPTH_CAP = 5;

/** @type {ReadonlyArray<{ readonly file: string, readonly functions: ReadonlyArray<readonly [string, number]> }>} */
export const PARAMS_BASELINE = [
  { file: 'packages/expression/src/math/adaptiveFunctionCurve.ts', functions: [['segmentError', 8]] },
  { file: 'packages/expression/src/math/ellipticIntegrand.ts', functions: [['ellipticIntegrand', 8]] },
  { file: 'packages/expression/src/math/ellipticNumeric.ts', functions: [['incomplete', 7]] },
  { file: 'packages/expression/src/math/ellipticQuadrature.ts', functions: [['integrateEllipticParameter', 8]] },
  { file: 'packages/expression/src/math/mathExtendedOperations.ts', functions: [['operation', 8]] },
  { file: 'packages/expression/src/math/smoothFunctionSurface.ts', functions: [['PolygonWorkspace::clip', 7]] },
  { file: 'packages/fem/src/beamWeldContact.ts', functions: [['expectedWrench', 7]] },
  { file: 'packages/fem/src/cadCurvedTetraMesh.ts', functions: [['meshCadCurvedBoundary', 8]] },
  { file: 'packages/fem/src/cadTetraMesh.ts', functions: [['meshCadBoundary', 8]] },
  { file: 'packages/fem/src/offlineBrowser.ts', functions: [['runInBrowser', 23]] },
  { file: 'packages/fem/src/solidContactUpdate.ts', functions: [['chooseProjection', 7]] },
  { file: 'packages/kernel/src/occt/analysisFreeformBound.ts', functions: [['reduceAffineFreeformFans', 9]] },
  { file: 'packages/kernel/src/occt/analysisSurfaceCertificate.ts', functions: [['readBoundaryOccurrence', 9], ['bindAnalyticNativeChain', 8], ['boundAnalyticTrimRibbon', 9], ['boundAnalyticNativeBridge', 7], ['boundAnalyticEndpointPatch', 8], ['readAnalyticWireChains', 8], ['readAnalyticTrimChain', 7]] },
  { file: 'packages/kernel/src/occt/analysisSurfaceMesh.ts', functions: [['vertexNode', 8], ['createEdgeRecord', 8]] },
  { file: 'packages/kernel/src/occt/booleanOp.ts', functions: [['buildBooleanResult', 8], ['booleanOp', 7]] },
  { file: 'packages/kernel/src/occt/buildBooleanShape.ts', functions: [['buildBooleanShape', 7]] },
  { file: 'packages/kernel/src/occt/hlrProvenance.ts', functions: [['readHlrSource', 8]] },
  { file: 'packages/kernel/src/occt/hlrSeamOutlines.ts', functions: [['readSeamOutlines', 8]] },
  { file: 'packages/kernel/src/occt/inspectPrintability.ts', functions: [['countGridEntries', 7], ['intersectTriangle', 8], ['castRay', 11]] },
  { file: 'packages/kernel/src/occt/makeEmboss.ts', functions: [['makeEmbossTool', 8]] },
  { file: 'packages/kernel/src/occt/makeHole.ts', functions: [['resolveFaceOfKind', 8], ['makeEntryTool', 7], ['makeHoleTools', 7], ['makeHole', 7]] },
  { file: 'packages/kernel/src/occt/makeProjection.ts', functions: [['projectEdgeToPlane', 7]] },
  { file: 'packages/kernel/src/occt/makeRib.ts', functions: [['selectRibChunks', 7]] },
  { file: 'packages/kernel/src/occt/makeThinExtrude.ts', functions: [['buildClosedWall', 7], ['buildOpenWall', 7]] },
  { file: 'packages/kernel/src/occt/makeThread.ts', functions: [['buildThreadCuts', 8]] },
  { file: 'packages/kernel/src/occt/overlapGrid.ts', functions: [['axisSeparates', 8], ['preparedCoordinatesIntersect', 10]] },
  { file: 'packages/kernel/src/occt/readCafMesh.ts', functions: [['writeFaceMesh', 7]] },
  { file: 'packages/kernel/src/occt/solidMesh.ts', functions: [['buildSolidBodyMesh', 10]] },
  { file: 'packages/kernel/src/occt/subShapeOrigins.ts', functions: [['rebindCopiedPrimitiveOrigins', 8], ['rebindCopiedBoxOrigins', 7], ['rebindCopiedCylinderOrigins', 7], ['prismSubShapeOrigins', 7], ['prismCurveSubShapeOrigins', 7], ['holeOperationOrigins', 7]] },
  { file: 'packages/kernel/src/occt/surfaceArcOrigins.ts', functions: [['surfaceArcPrismOrigins', 8]] },
  { file: 'packages/kernel/src/occt/sweepGuide.ts', functions: [['readStation', 7]] },
  { file: 'packages/kernel/src/occt/tessellate.ts', functions: [['appendFaceMesh', 9]] },
  { file: 'packages/kernel/src/worker/checkInterference.ts', functions: [['checkInterference', 7]] },
  { file: 'packages/kernel/src/worker/recomputeSolids.ts', functions: [['buildCachedSolid', 11], ['localReplyFromWorld', 9], ['localCachedReferenceMesh', 7]] },
  { file: 'packages/model/src/analysis/analysisValidation.ts', functions: [['checkBeamTopology', 7]] },
  { file: 'packages/model/src/assembly/constraints/mateResiduals.ts', functions: [['directionRow', 7], ['projectedRow', 7]] },
  { file: 'packages/model/src/assembly/constraints/solveRigid.ts', functions: [['assembleNormalSystemSteps', 9]] },
  { file: 'packages/model/src/assembly/fastening/bindHoleSelection.ts', functions: [['threadStartOf', 7]] },
  { file: 'packages/model/src/assembly/standard/buildStandardPart.ts', functions: [['appendExternalThread', 7]] },
  { file: 'packages/model/src/assembly/standard/steelAngleChannelOracle.fixture.ts', functions: [['section', 10]] },
  { file: 'packages/model/src/assembly/standard/steelCatalogOracle.fixture.ts', functions: [['section', 10]] },
  { file: 'packages/model/src/assembly/standard/steelSectionProfiles.ts', functions: [['profile', 7]] },
  { file: 'packages/model/src/assembly/welding/circularWeldContact.ts', functions: [['coverage', 7]] },
  { file: 'packages/model/src/assembly/welding/cylindricalWeld.ts', functions: [['cylindricalWeldContact', 8]] },
  { file: 'packages/model/src/drawing/gdt.ts', functions: [['resolveGdtFeature::finish', 7]] },
  { file: 'packages/model/src/functionGeometry/recomputeFunctionCurves.ts', functions: [['recomputeFunctionCurves', 7]] },
  { file: 'packages/model/src/functionGeometry/sampleFunctionCurveGeometry.ts', functions: [['sampleFunctionCurveGeometry', 7]] },
  { file: 'packages/model/src/kernelBridge.ts', functions: [['raceWithBroken', 7]] },
  { file: 'packages/model/src/part/recomputePart.ts', functions: [['fillProjections', 7]] },
  { file: 'packages/model/src/part/resolvePart.ts', functions: [['resolveExtrudeEnd', 8], ['planSolid', 7]] },
  { file: 'packages/model/src/sheetMetal/panelGeometry.ts', functions: [['rectangularFlangePanel', 8]] },
  { file: 'packages/model/src/sheetMetal/profileFlange.ts', functions: [['profileFlangePanel', 9]] },
  { file: 'packages/model/src/sheetMetal/reliefProfile.ts', functions: [['sheetReliefProfile', 7]] },
  { file: 'packages/model/src/sketch/constraints/sparseSolve.ts', functions: [['multiply', 7]] },
  { file: 'packages/ui/src/assembly/childWeldDefinitionEdit.ts', functions: [['commitChildWeldDefinitionEdit', 7]] },
  { file: 'packages/ui/src/drawing/prepareAssemblyDrawingSource.ts', functions: [['prepareAssemblyDrawingSource', 7]] },
  { file: 'packages/ui/src/drawing/prepareFlatDrawingSource.ts', functions: [['prepareFlatDrawingSource', 7]] },
  { file: 'packages/ui/src/functionPlot/functionDirectionDraft.ts', functions: [['evaluateFunctionDirection', 12]] },
  { file: 'packages/ui/src/functionPlot/functionPlotDraft.ts', functions: [['evaluateFunctionPlotDraft', 7]] },
  { file: 'packages/ui/src/functionPlot/functionPointDraft.ts', functions: [['searchFunctionPoints', 8]] },
  { file: 'packages/ui/src/functionPlot/functionSectionDraft.ts', functions: [['prepareFunctionSection', 9]] },
  { file: 'packages/ui/src/math/mathPaletteGroups.ts', functions: [['mathPaletteItem', 9]] },
  { file: 'packages/ui/src/sheetMetal/sheetCommands.ts', functions: [['buildSheetCreation', 7]] },
  { file: 'packages/ui/src/shell/featureTreeLifetime.ts', functions: [['watchTimelineDrag', 7]] },
  { file: 'packages/ui/src/sketch/shapeCommands.ts', functions: [['commitTwoPointArc', 8], ['commitThreePointArc', 7], ['commitPolygon', 7], ['commitEllipse', 9], ['commitGridPointArray', 9]] },
  { file: 'packages/ui/src/sketch/trackMath.ts', functions: [['bestTrackCandidate', 7]] },
  { file: 'packages/ui/src/solid/referenceRepairSlots.ts', functions: [['collectRepairSlots', 8]] },
  { file: 'packages/ui/src/solid/solidCommands.ts', functions: [['commitSolidInput', 7]] },
  { file: 'packages/ui/src/strength/strengthFields.ts', functions: [['strengthExpressionField', 7]] },
  { file: 'packages/ui/src/viewport/attachAssemblyInteraction.ts', functions: [['pickAssemblyMateTarget', 7]] },
  { file: 'packages/ui/src/viewport/buildSolidGeometry.ts', functions: [['patternedDrawArraysOf', 8]] },
  { file: 'packages/ui/src/viewport/createAssemblyLayer.ts', functions: [['flattenAssemblyGeometry::visit', 8], ['fillGeometries', 7]] },
];

/** @type {ReadonlyArray<{ readonly file: string, readonly functions: ReadonlyArray<readonly [string, number, number]> }>} */
export const DEPTH_BASELINE = [
  { file: 'packages/drawing/src/text/textOutline.ts', functions: [['outlineInkBounds', 6, 1]] },
  { file: 'packages/expression/src/math/adaptiveFunctionCurve.ts', functions: [['sampleFunctionCurve', 6, 1], ['sampleConditionalCurve', 6, 1]] },
  { file: 'packages/expression/src/math/adaptiveFunctionSurface.ts', functions: [['sampleFunctionSurface', 6, 2], ['sampleSurfacePatch', 6, 3]] },
  { file: 'packages/expression/src/math/implicitTetrahedra.ts', functions: [['meshImplicitTetrahedra', 6, 1]] },
  { file: 'packages/expression/src/math/isolateBivariateRoots.ts', functions: [['isolateBivariateRoots', 8, 3]] },
  { file: 'packages/expression/src/math/isolateScalarRoots.ts', functions: [['isolateScalarRoots', 6, 4]] },
  { file: 'packages/expression/src/math/scalarCurveCurvature.ts', functions: [['directionalJet', 7, 3]] },
  { file: 'packages/fem/src/beamWeldSpan.ts', functions: [['prepareWeldSpan::operators::patches.map(#0)', 8, 3]] },
  { file: 'packages/fem/src/solidAnalysisTranslation.ts', functions: [['translateSolidAnalysis', 6, 1]] },
  { file: 'packages/fem/src/solidMeshConvergenceFixture.ts', functions: [['locallyGradedPlateBoundary', 6, 2]] },
  { file: 'packages/fem/src/solidModalTranslation.ts', functions: [['translateSolidModal', 7, 3]] },
  { file: 'packages/kernel/src/occt/analysisFreeformBound.ts', functions: [['partitionedFreeformTriangleDistance', 6, 3]] },
  { file: 'packages/kernel/src/occt/analysisShellQuality.ts', functions: [['buildCylindricalShellQuality', 6, 2]] },
  { file: 'packages/kernel/src/occt/analysisSurfaceCertificate.ts', functions: [['bindAnalyticNativeChain', 7, 6], ['readAnalyticWireChains', 7, 3]] },
  { file: 'packages/kernel/src/occt/analysisSurfaceMesh.ts', functions: [['buildAnalysisSurfaceMeshInternal', 7, 8]] },
  { file: 'packages/kernel/src/occt/classifyFunctionSurface.ts', functions: [['faceGroups', 6, 3]] },
  { file: 'packages/kernel/src/occt/extractEdges.ts', functions: [['extractEdges', 7, 2]] },
  { file: 'packages/kernel/src/occt/functionSurfaceBounds.ts', functions: [['certifyTrimmedCubicShapeBounds', 6, 1]] },
  { file: 'packages/kernel/src/occt/occtRegistrationImportProbe.ts', functions: [['createRegistrationImportProbe::descriptors[name]::value', 6, 1]] },
  { file: 'packages/kernel/src/occt/overlapGrid.ts', functions: [['findTriangleOverlaps', 6, 5]] },
  { file: 'packages/kernel/src/occt/subShapes.ts', functions: [['findSubShapeAt', 6, 1]] },
  { file: 'packages/kernel/src/occt/tessellate.ts', functions: [['tessellate', 6, 1]] },
  { file: 'packages/kernel/src/occt/volumeProperties.ts', functions: [['hasCurvedCylinderBoundary', 6, 2]] },
  { file: 'packages/kernel/src/worker/checkInterference.ts', functions: [['checkInterference', 6, 2]] },
  { file: 'packages/kernel/src/worker/kernelApiResources.ts', functions: [['createHiddenLeaseResources::readCachedBodies', 6, 1]] },
  { file: 'packages/model/src/assembly/constraints/rigidQrSteps.ts', functions: [['qrDecompositionSteps', 6, 1]] },
  { file: 'packages/model/src/measure/mathGeometryDependencies.ts', functions: [['definitionGraph', 6, 1], ['orderAndEdges', 7, 6]] },
  { file: 'packages/model/src/sheetMetal/flatBendLines.ts', functions: [['sheetFlatBendLines', 6, 1]] },
  { file: 'packages/model/src/sketch/constraints/solve.ts', functions: [['qrDecomposition', 6, 1], ['createLevenbergMarquardtJob::advanceUnit', 6, 1]] },
  { file: 'packages/ui/src/drawing/tableDisplay.ts', functions: [['displayDrawingTables', 6, 1]] },
  { file: 'packages/ui/src/file/drawingFile.ts', functions: [['saveDrawing::queueDocumentSave(#1)', 7, 5]] },
  { file: 'packages/ui/src/file/partFile.ts', functions: [['savePart::queueDocumentSave(#1)', 6, 1]] },
  { file: 'packages/ui/src/help/HelpMarkdown.tsx', functions: [['HelpMarkdown::blocks', 6, 1]] },
  { file: 'packages/ui/src/viewport/assemblyLayerResources.ts', functions: [['syncAssemblyHighlights', 6, 2]] },
];
