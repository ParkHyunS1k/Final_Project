import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

test('db/schema.ts와 db/migrations가 일치한다(drizzle-kit generate가 새 파일을 만들지 않는다)', () => {
  // drizzle-kit은 --out을 현재 폴더 기준으로 읽는다. 절대 경로를 주면 파일을 못 찾고도 오류만 찍는다.
  const cache = join(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const dir = join(mkdtempSync(join(cache, 'pm-mig-')), 'migrations');
  cpSync('db/migrations', dir, { recursive: true });
  const before = readdirSync(dir).filter((n) => n.endsWith('.sql'));
  const out = execFileSync(
    'npx',
    ['drizzle-kit', 'generate', '--dialect', 'postgresql', '--schema', './db/schema.ts', '--out', relative(process.cwd(), dir)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.doesNotMatch(out, /error/i, out);
  assert.match(out, /No schema changes/i, out);
  const after = readdirSync(dir).filter((n) => n.endsWith('.sql'));
  assert.deepEqual(after, before, out);
});
