import process from 'node:process';

const targetVariables = new Set([
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
]);

/** Resolve Git from the explicit cwd instead of a parent hook's repository. */
export function localGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !targetVariables.has(name.toUpperCase())));
}
