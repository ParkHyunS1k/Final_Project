// 동료평가 점수·등급·뱃지. 본인 결과만 돌려준다. 규칙: lib/score.ts
import { identity, AuthUnavailable, AccessError } from '@/lib/projects';
import { Conflict } from '@/lib/sprint-store';
import { PolicyError } from '@/lib/sprint-policy';
import { readScore, submitReview } from '@/lib/score-store';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
function failure(error: unknown, label: string) {
  if (error instanceof AccessError) return reply({ error: error.message }, error.status);
  if (error instanceof PolicyError) return reply({ error: error.message }, error.status);
  if (error instanceof Conflict) return reply({ error: error.message }, 409);
  if (error instanceof SyntaxError)
    return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  // 인프라 오류 내용은 서버 밖으로 내보내지 않는다.
  console.error(label, error);
  return reply({ error: '점수를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 503);
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  const id = new URL(request.url).searchParams.get('project');
  if (!id) return reply({ error: '프로젝트를 지정해주세요.' }, 400);
  try {
    return reply(await readScore(id, user));
  } catch (error) {
    return failure(error, 'score read failed');
  }
}

export async function POST(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 16000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.projectId !== 'string')
      return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    if (b.action !== 'review') return reply({ error: '지원하지 않는 작업입니다.' }, 400);
    return reply(await submitReview(b.projectId, user, b.reviews));
  } catch (error) {
    return failure(error, 'score write failed');
  }
}
