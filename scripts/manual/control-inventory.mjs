/** Source inventory; actual rendering and explanation quality require separate verification. */
import ts from 'typescript';

const tags = new Set(['input', 'select', 'textarea', 'button']);
function attribute(node, name) {
  return node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name);
}
function constant(attribute) {
  if (attribute === undefined) return undefined;
  if (attribute.initializer === undefined) return true;
  const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
  if (value === undefined) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return false;
  return undefined;
}
function describeTitle(title) {
  if (title === undefined) return 'missing';
  const value = constant(title);
  return value === undefined ? 'expression' : typeof value === 'string' && value.trim() !== '' ? 'literal' : 'missing';
}
export function buildNativeControlInventory(sources) {
  const seen = new Set(), controls = [];
  for (const { path, source } of sources) {
    if (seen.has(path)) throw new Error(`Duplicate control inventory source: ${path}`);
    seen.add(path);
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (file.parseDiagnostics.length > 0) throw new Error(`Cannot inspect invalid JSX: ${path}`);
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        if (tags.has(tag)) {
          const own = attribute(node, 'title');
          let title = own, origin = own === undefined ? null : 'control';
          // Only the associated enclosing label can provide a field explanation.
          // An unrelated container's title must not hide a missing description.
          if (own === undefined && tag !== 'button') {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (ts.isFunctionLike(parent)) break;
              if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(file) === 'label') {
                title = attribute(parent.openingElement, 'title');
                if (title !== undefined) origin = 'label';
                break;
              }
            }
          }
          controls.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, tag,
            hidden: constant(attribute(node, 'hidden')) === true || (tag === 'input' && constant(attribute(node, 'type')) === 'hidden'),
            description: describeTitle(title), titleSource: origin,
            sourceExpression: title?.getText(file) ?? null,
            hasSpread: node.attributes.properties.some(ts.isJsxSpreadAttribute) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return { scope: 'native-jsx-controls', contentCertified: false, sources: [...seen], controls,
    missing: controls.filter(control => !control.hidden && control.description === 'missing'),
    requiresRenderedCheck: controls.filter(control => !control.hidden && (control.description === 'expression' || control.hasSpread)) };
}
export function assertNativeControlDescriptions(inventory) {
  if (inventory.controls.length === 0) throw new Error('No native controls were inspected');
  if (inventory.missing.length > 0) throw new Error('Missing control descriptions: ' + inventory.missing
    .map(control => `${control.path}:${control.line} <${control.tag}>`).join(', '));
}
