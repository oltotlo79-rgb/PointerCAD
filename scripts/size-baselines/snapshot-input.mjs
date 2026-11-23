import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

// Get the candidate's selected bytes and HEAD's held bytes, including names with spaces.
export function snapshotReader(root) {
  const { head, selected } = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) {
    throw new Error('送信候補の HEAD が不正');
  }
  const git = (args, input) => {
    const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args],
      { input, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0 || result.stderr.length > 0) {
      throw new Error(`送信候補の Git 読取り失敗 (${args[0]}): ${result.error ?? result.stderr.toString('utf8')}`);
    }
    return result.stdout;
  };
  const blobs = new Map();
  for (const row of git(['ls-tree', '--full-tree', '-rz', head]).toString('utf8').split('\0').filter(Boolean)) {
    const split = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, split).split(' ');
    blobs.set(row.slice(split + 1), { mode, type, oid });
  }
  const cache = new Map();
  return (paths) => {
    const wanted = new Map();
    for (const file of new Set(paths)) {
      if (cache.has(file)) continue;
      if (Object.hasOwn(selected, file)) {
        const record = selected[file];
        if (record === null) continue;
        const bytes = readFileSync(record.source);
        if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
          throw new Error(`送信候補のバイトが照合中に変わった: ${file}`);
        }
        cache.set(file, bytes.toString('utf8'));
      } else if (blobs.has(file)) {
        const { mode, type, oid } = blobs.get(file);
        if (type !== 'blob' || !/^100[0-7]{3}$/u.test(mode)) {
          throw new Error(`送信候補の計測対象が通常ファイルではない: ${file}`);
        }
        wanted.set(file, oid);
      }
    }
    if (wanted.size) {
      const output = git(['cat-file', '--batch'], [...wanted.values()].join('\n') + '\n');
      let offset = 0;
      for (const [file, oid] of wanted) {
        const newline = output.indexOf(10, offset);
        const header = newline < 0 ? '' : output.toString('ascii', offset, newline);
        const match = /^(\S+) blob ([0-9]+)$/u.exec(header);
        const end = newline + 1 + Number(match?.[2]);
        if (match?.[1] !== oid || end >= output.length || output[end] !== 10) {
          throw new Error(`HEAD の計測対象を読めない: ${file} (${header})`);
        }
        cache.set(file, output.toString('utf8', newline + 1, end));
        offset = end + 1;
      }
      if (offset !== output.length) throw new Error('HEAD の計測対象のバイト数が合わない');
    }
    return new Map(paths.filter((file) => cache.has(file)).map((file) => [file, cache.get(file)]));
  };
}
