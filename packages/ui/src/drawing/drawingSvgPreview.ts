import { toSvg, type RenderDocument } from '@pointercad/drawing';

/** 保存・出力と同じSVGを使い、ドラッグ中の所有者だけを一時的に差し替える。 */
export function createDrawingSvgPreview(svg: SVGSVGElement, owners: ReadonlySet<string>) {
  const slots = new Map<string, { readonly parent: SVGGElement; readonly originals: readonly Element[] }>();
  const candidates = [...svg.querySelectorAll('[data-owner-id]')];
  for (const owner of owners) {
    const originals = candidates.filter((node) => node.getAttribute('data-owner-id') === owner);
    if (originals.length === 0) continue;
    const parent = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    originals[0].before(parent);
    // 先頭の位置を保持する。寸法・公差の描画要素は所有者ごとに連続している。
    for (const node of originals) node.remove();
    slots.set(owner, { parent, originals });
  }
  const definitions = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.prepend(definitions);
  const prefix = `pcad-preview-${crypto.randomUUID()}-`;
  // 現在のSVGの文脈で解析する。毎コマ別のXML Documentを生成しない。
  const parser = svg.ownerDocument.createRange(); parser.selectNodeContents(svg);
  return {
    update(document: RenderDocument): boolean {
      if (!svg.isConnected) return false;
      const text = toSvg(document); if (text === null) return false;
      const parsed = parser.createContextualFragment(text.slice(text.indexOf('<svg')));
      // 元SVGのclip IDと衝突させず、輪郭と同じクリップを再利用する。
      for (const clip of parsed.querySelectorAll('clipPath[id]')) clip.id = prefix + clip.id;
      for (const item of parsed.querySelectorAll('[clip-path]')) {
        const value = item.getAttribute('clip-path');
        if (value?.startsWith('url(#') === true) item.setAttribute('clip-path', `url(#${prefix}${value.slice(5)}`);
      }
      // Rangeが同じDocumentへ作ったノードを移動する。毎フレーム全輪郭を複製しない。
      definitions.replaceChildren(...parsed.querySelectorAll('defs > *'));
      const nodes = [...parsed.querySelectorAll('[data-owner-id]')];
      for (const [owner, slot] of slots) slot.parent.replaceChildren(...nodes.filter((node) => node.getAttribute('data-owner-id') === owner));
      return true;
    },
    restore(): void {
      for (const slot of slots.values()) if (slot.parent.parentNode !== null) slot.parent.replaceWith(...slot.originals);
      definitions.remove(); slots.clear();
    },
  };
}

/** 図と参照付き記入を、元の描画順序・クリップ・輪郭を保持して移動する。 */
export function createDrawingTranslationPreview(svg: SVGSVGElement, viewId: string, relatedIds: ReadonlySet<string>) {
  const selected = [...svg.querySelectorAll('[data-owner-id]')].filter((node) => node.getAttribute('data-view-id') === viewId
    || relatedIds.has(node.getAttribute('data-owner-id') ?? ''));
  const runs: Element[][] = [];
  for (const node of selected) {
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous[previous.length - 1].nextElementSibling === node) previous.push(node);
    else runs.push([node]);
  }
  const groups = runs.map((originals) => {
    const parent = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    originals[0].before(parent); parent.append(...originals); return { parent, originals };
  });
  return {
    update(delta: readonly [number, number]): void {
      if (!delta.every(Number.isFinite) || !svg.isConnected) return;
      for (const group of groups) group.parent.setAttribute('transform', `translate(${delta[0]} ${delta[1]})`);
    },
    restore(): void {
      for (const group of groups) if (group.parent.parentNode !== null) group.parent.replaceWith(...group.originals);
      groups.length = 0;
    },
  };
}
