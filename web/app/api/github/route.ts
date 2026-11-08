// GitHub 계정 연결 동기화(2026-11-08). 화면은 Supabase linkIdentity/unlinkIdentity 뒤에 sync를 부른다.
// 서버는 Supabase 신원만 믿고 본문의 아이디는 읽지 않는다(lib/github-account.ts).
import { identity, AuthUnavailable } from '@/lib/auth';
import { syncGithubAccount } from '@/lib/github-account';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
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
  if (raw.length > 2000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    if (b?.action !== 'sync') return reply({ error: '지원하지 않는 작업입니다.' }, 400);
    const account = await syncGithubAccount(request, user.id, new Date());
    return reply({ github: account && { login: account.login, linkedAt: account.linkedAt } });
  } catch (e) {
    if (e instanceof AuthUnavailable) return reply({ error: e.message }, e.status);
    if (e instanceof SyntaxError) return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    console.error('github account sync failed', e);
    return reply({ error: '처리하지 못했습니다.' }, 503);
  }
}
