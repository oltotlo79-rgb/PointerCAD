import { evaluateExpression, type ExpressionError, type ExpressionValue } from '@pointercad/expression';
import {
  addComponent,
  assemblyExpressionContext,
  createComponentFor,
  findComponent,
  removeComponent,
  type AssemblyComponent,
  type AssemblyDocument,
  type Placement,
} from '@pointercad/model';

export type PlacementSources = readonly [string, string, string];

export type PlacementInputOutcome =
  | { readonly ok: true; readonly placement: Placement }
  | { readonly ok: false; readonly errors: readonly [ExpressionError | null, ExpressionError | null, ExpressionError | null] };

/** XYZ欄をアセンブリ自身のパラメータだけで評価し、式と値を一緒に保存する形へ直す。 */
export function placementFromSources(
  assembly: AssemblyDocument,
  sources: PlacementSources,
): PlacementInputOutcome {
  const context = assemblyExpressionContext(assembly);
  const values: (ExpressionValue | null)[] = [];
  const errors: (ExpressionError | null)[] = [];
  for (const entered of sources) {
    const source = entered.trim() === '' ? '0' : entered;
    const result = evaluateExpression(source, context);
    values.push(result.ok ? result.value : null);
    errors.push(result.ok ? null : result.error);
  }
  const [x, y, z] = values;
  if (x === null || y === null || z === null) {
    return {
      ok: false,
      errors: [errors[0] ?? null, errors[1] ?? null, errors[2] ?? null],
    };
  }
  return { ok: true, placement: { position: [x, y, z], rotation: [0, 0, 0, 1] } };
}

/** 抱き込み済みの参照を1インスタンスとして置く。 */
export function placePart(
  document: AssemblyDocument,
  partRef: string,
  partName: string,
  placement: Placement,
): { readonly document: AssemblyDocument; readonly component: AssemblyComponent } {
  const component = createComponentFor(
    document,
    { kind: 'part', partRef },
    { partName, placement },
  );
  return { document: addComponent(document, component), component };
}

/** 同じ部品参照・配置・外観で新しいインスタンスを作る。ライブラリは触らない。 */
export function duplicateComponent(
  document: AssemblyDocument,
  componentId: string,
): { readonly document: AssemblyDocument; readonly component: AssemblyComponent | null } {
  const source = findComponent(document, componentId);
  if (source === undefined) return { document, component: null };
  const component: AssemblyComponent = {
    ...createComponentFor(document, source.source, {
      partName: source.name.replace(/:\d+$/u, ''),
      placement: source.placement,
    }),
    // 新しいid・名前と、新規配置のfixed/visible/suppressed規則はcreateComponentForへ任せる。
    // 利用者が指定した外観と材質は同じ部品を複製する操作で失わない。
    appearance: source.appearance,
    materialId: source.materialId,
  };
  return { document: addComponent(document, component), component };
}

/** 選択順に部品を消し、依存する合致などの掃除はmodelの既存APIへ任せる。 */
export function removeComponents(
  document: AssemblyDocument,
  componentIds: readonly string[],
): AssemblyDocument {
  return componentIds.reduce(removeComponent, document);
}
