import { createArrowTriangle, drawingSymbol, surfaceFinish, type DimensionTarget, type DrawingDocument,
  type DrawingRenderCurve, type DrawingRenderElement, type OutlinedText, type Point2, type RenderSubpath } from '@pointercad/drawing';
import { evaluateExpression } from '@pointercad/expression';
import { analyzeParameters, machiningSymbols, reevaluatePartDocument, resolveDrawingAnnotationTarget,
  type DrawingSourceLibrary, type DrawingSourceResolution, type MachiningNote } from '@pointercad/model';

import { displayDrawingNote } from './noteDisplay.js';

export function resolveMachiningAnnotation(document: DrawingDocument, library: DrawingSourceLibrary,
  target: DimensionTarget, featureId?: string): MachiningNote | null {
  if (target.kind !== 'subShape' || target.sourceRef !== document.source.sourceRef || target.componentId !== undefined) return null;
  const embedded = library.sources.find((entry) => entry.metadata.sourceRef === target.sourceRef
    && entry.metadata.contentHash === document.source.contentHash);
  if (embedded === undefined || !('sketches' in embedded.document)) return null;
  const id = featureId ?? target.ref.bodyFeatureId;
  const analysis = analyzeParameters(embedded.document.parameters, []);
  const evaluation = reevaluatePartDocument(embedded.document, analysis.variables, analysis);
  if (evaluation.failures.some((failure) => failure.ownerId === id)) return null;
  const feature = evaluation.document.solids.find((item) => item.id === id);
  return feature?.kind === 'hole' || feature?.kind === 'threadHole' || feature?.kind === 'threadShaft' || feature?.kind === 'chamfer'
    ? machiningSymbols(feature) : null;
}

function arrowFill(tip: Point2, from: Point2): { readonly subpaths: readonly RenderSubpath[]; readonly fillRule: 'nonzero' } {
  const points = createArrowTriangle(tip, [tip[0] - from[0], tip[1] - from[1]]).points;
  return { subpaths: [{ commands: [{ kind: 'M', to: points[0] }, { kind: 'L', to: points[1] }, { kind: 'L', to: points[2] }, { kind: 'Z' }] }], fillRule: 'nonzero' };
}

/** 注記も寸法と同じ保存参照・最新の式から解決し、画面と書き出しへ共通の図形を渡す。 */
export function displayDrawingAnnotations(document: DrawingDocument, source: DrawingSourceResolution, library: DrawingSourceLibrary,
  outline: (text: string, sizeMm: number) => OutlinedText): readonly DrawingRenderElement[] {
  const context = { instances: source.dimensionInstances ?? [], modelCenter: source.center };
  const analysis = analyzeParameters(document.parameters, []);
  return document.annotations.flatMap((annotation): DrawingRenderElement[] => {
    if (annotation.sourceTarget === undefined) {
      const display = displayDrawingNote(annotation, outline);
      return display === null ? [] : [display];
    }
    const target = resolveDrawingAnnotationTarget(annotation.sourceTarget, document, context);
    const common = { ownerId: annotation.id, layerId: annotation.layerId, style: annotation.style };
    const unresolved = (): DrawingRenderElement[] => [{ ...common, style: { ...annotation.style, color: '#c2410c' },
      texts: [{ text: '？', position: annotation.position, sizeMm: annotation.height }] }];
    if (target === null) return unresolved();
    if (annotation.surfaceFinish !== undefined) {
      const evaluated = evaluateExpression(annotation.surfaceFinish.value.source, analysis);
      if (!evaluated.ok) return unresolved();
      const symbol = surfaceFinish({ ...annotation.surfaceFinish, value: evaluated.value.value, position: annotation.position, target, sizeMm: annotation.height });
      if (symbol === null) return unresolved();
      const arrow = symbol.leaderLines[0];
      return [{ ...common, curves: [...symbol.lines, ...symbol.leaderLines].map((line) => ({ kind: 'segment', ...line })),
        texts: symbol.texts, fills: arrow === undefined ? [] : [arrowFill(arrow.from, arrow.to)] },
        { ...common, curves: symbol.arcs.map((arc) => ({ kind: 'arc', ...arc })) }];
    }
    if (annotation.machiningFeatureId !== undefined) {
      const note = resolveMachiningAnnotation(document, library, annotation.sourceTarget, annotation.machiningFeatureId);
      if (note === null) return unresolved();
      const curves: DrawingRenderCurve[] = [{ kind: 'segment', from: target, to: annotation.position }];
      const texts: NonNullable<DrawingRenderElement['texts']>[number][] = [];
      let x = annotation.position[0];
      for (const token of note.tokens) {
        if (token.kind === 'text') {
          const metrics = outline(token.text, annotation.height).metrics;
          if (metrics === null) return unresolved();
          texts.push({ text: token.text, position: [x, annotation.position[1] + 1], sizeMm: annotation.height });
          x += metrics.advanceMm + 1;
        } else {
          const symbol = drawingSymbol(token.symbol, annotation.height, [x, annotation.position[1] + 1]);
          if (symbol === null) return unresolved();
          curves.push(...symbol.lines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })),
            ...symbol.arcs.map((arc): DrawingRenderCurve => ({ kind: 'arc', ...arc })));
          x += annotation.height + 1;
        }
      }
      return [{ ...common, curves, texts, fills: [arrowFill(target, annotation.position)] }];
    }
    return [];
  });
}
