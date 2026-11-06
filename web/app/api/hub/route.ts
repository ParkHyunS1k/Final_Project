import { identity, AuthUnavailable } from '@/lib/auth';
import { readHub, hubAction } from '@/lib/hub';
import { CareerError } from '@/lib/career/profile';
import { AccessError } from '@/lib/projects';
import { PolicyError } from '@/lib/sprint-policy';
import { Conflict } from '@/lib/sprint-store';
export const dynamic = 'force-dynamic';
const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
function failure(e: unknown) {
  if (e instanceof Conflict)
    return reply(
      { error: '프로젝트가 바뀌었습니다. 새로고침 후 다시 시도해주세요.' },
      409,
    );
  if (
    e instanceof CareerError ||
    e instanceof AccessError ||
    e instanceof PolicyError
  )
    return reply({ error: e.message }, e.status);
  if (e instanceof SyntaxError)
    return reply({ error: '요청 형식을 확인해주세요.' }, 400);
  console.error('hub request failed', e instanceof Error ? e.name : 'unknown');
  return reply(
    {
      error:
        '저장소를 불러오지 못했습니다. 서버와 마이그레이션을 확인해주세요.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable)
    return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    return reply(await readHub(user));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable)
    return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const body = await request.text();
  if (body.length > 50000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(body);
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new CareerError('요청 형식을 확인해주세요.');
    return reply(
      await hubAction(user, b, new URL(request.url).origin),
      b.action === 'createTemplate' ? 201 : 200,
    );
  } catch (e) {
    return failure(e);
  }
}
