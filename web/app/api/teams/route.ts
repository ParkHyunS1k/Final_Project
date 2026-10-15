// 공개 팀 목록과 참여 신청. 팀장의 공개 설정·승인은 /api/projects(setListed, decideJoin)에 있다.
import { identity, AuthUnavailable, AccessError, GoalChanged } from '@/lib/projects';
import { listTeams, requestJoin, cancelJoin } from '@/lib/teams';
import { Conflict } from '@/lib/sprint-store';
import { PolicyError } from '@/lib/sprint-policy';
export const dynamic = 'force-dynamic';
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
function failure(error: unknown) {
  if (error instanceof AccessError || error instanceof PolicyError)
    return reply({ error: error.message }, error.status);
  if (error instanceof GoalChanged)
    return reply({ error: error.message, details: error.details }, error.status);
  if (error instanceof Conflict)
    return reply({ error: '다른 변경이 있습니다. 목록을 새로 불러온 뒤 다시 시도해주세요.' }, 409);
  if (error instanceof Error && !/SQLITE|D1_|database|binding/i.test(error.message))
    return reply({ error: error.message }, 400);
  console.error('teams request failed', error);
  return reply({ error: '처리하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 503);
}
export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    return reply(await listTeams(user));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin)
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 4000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('요청 형식을 확인해주세요.');
    if (b.action === 'request') return reply(await requestJoin(user, b), 201);
    if (b.action === 'cancel') {
      await cancelJoin(user, b.requestId);
      return reply({ ok: true });
    }
    throw new Error('지원하지 않는 작업입니다.');
  } catch (e) {
    return failure(e);
  }
}
