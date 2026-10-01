import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execPath } from 'node:process';

import { expect, it } from 'vitest';

import { VIEW_CUBE_CAMERA_DISTANCE, VIEW_CUBE_FIELD_OF_VIEW } from './viewCubeCamera.js';

it('loads the shared camera constants in native Node ESM without application dependencies', () => {
  const source = readFileSync(new URL('./viewCubeCamera.ts', import.meta.url));
  const moduleUrl = `data:text/javascript;base64,${source.toString('base64')}`;
  const output = execFileSync(execPath, [
    '--input-type=module', '--eval',
    'import(process.argv[1]).then(camera => console.log(JSON.stringify(camera)))', moduleUrl,
  ], { encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({ VIEW_CUBE_CAMERA_DISTANCE, VIEW_CUBE_FIELD_OF_VIEW });
});
