// 드라이버가 Postgres 값을 앱이 기대하는 JS 타입으로 돌려주는지 확인한다(테이블 불필요).
// 로컬: node --experimental-strip-types scripts/db-check.ts
// Supabase: DATABASE_URL=... node --experimental-strip-types scripts/db-check.ts
import { database } from '../lib/db.ts';

const db = database();
const r = await db
  .prepare("SELECT now() AS at, true AS ok, '[1]'::jsonb AS j, '2026-10-03'::date AS d, count(*) AS n FROM (VALUES (1),(2)) v(x)")
  .first<Record<string, unknown>>();
const got = {
  at: r!.at instanceof Date,
  ok: r!.ok === true,
  j: Array.isArray(r!.j),
  d: r!.d === '2026-10-03',
  n: r!.n === 2,
};
console.log(JSON.stringify(got));
await db.close();
if (!Object.values(got).every(Boolean)) process.exit(1);
