import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Inventory of the standalone Python checks in this folder. They are plain unittest scripts (host Python with NumPy,
// importing the solver module that sits beside them) run by hand from this folder, for example
// `python -B -X utf8 test_solidBuckling.py`; Vitest does not launch them. This file only pins the inventory: a Python
// check cannot be renamed, deleted or added without this list changing (the test-utils testFileCoverage check also
// requires every test_*.py and *_test.py to be named by a *.test.ts of its package).
const PYTHON_CHECKS = [
  { file: 'test_solidBuckling.py', module: 'solidBuckling' },
  { file: 'test_solidModal.py', module: 'solidModal' },
] as const;

const folder = new URL('./', import.meta.url);

function isPythonCheck(name: string): boolean {
  return name.endsWith('_test.py') || (name.startsWith('test_') && name.endsWith('.py'));
}

function collectPythonChecks(directory: URL, prefix: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      collectPythonChecks(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`, found);
    } else if (entry.isFile() && isPythonCheck(entry.name)) {
      found.push(`${prefix}${entry.name}`);
    }
  }
}

describe('Python check inventory', () => {
  it('lists exactly the test_*.py and *_test.py files under src', () => {
    const found: string[] = [];
    collectPythonChecks(folder, '', found);
    expect(found.sort()).toEqual(PYTHON_CHECKS.map(check => check.file).sort());
  });

  it.each(PYTHON_CHECKS)('$file exists, is not empty and imports $module from the same folder', ({ file, module }) => {
    const check = new URL(`./${file}`, folder);
    expect(statSync(check).size).toBeGreaterThan(0);
    expect(existsSync(new URL(`./${module}.py`, folder))).toBe(true);
    expect(readFileSync(check, 'utf8')).toContain(`import ${module} as `);
  });
});
