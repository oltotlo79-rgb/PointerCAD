import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('Lambert Wの元の境界を0倍や成分選択で消さず、定数の境界値とは区別する',()=>{
  const script=fileURLToPath(new URL('./exactRuntime/cas_lambert_functions_test.py',import.meta.url));
  const execution=spawnSync('python',['-B','-X','utf8',script,
    'LambertFunctionTests.test_zero_and_component_cannot_hide_original_branch_boundary'],{
    encoding:'utf8',timeout:30_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},
  });
  expect(execution.error,execution.stderr).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
},30_000);
