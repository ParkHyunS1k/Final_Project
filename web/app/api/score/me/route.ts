// 내가 속한 프로젝트 전체의 확정 점수 합·최고 등급·뱃지.
import { identity, AuthUnavailable } from '@/lib/projects';
import { readMyScore } from '@/lib/score-store';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    return reply(await readMyScore(user));
  } catch (error) {
    console.error('score summary failed', error);
    return reply({ error: '점수를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }
}
