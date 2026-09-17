// 정기 실행기 진입점. 사용자 세션이 아니라 서버 비밀값으로만 실행한다.
// 브라우저 타이머나 위조한 플랫폼 사용자 헤더로 배치 작업을 실행하지 않는다.
import { env } from 'cloudflare:workers';
import { dispatchReminders } from '@/lib/reminder-dispatch';
import { senderFrom, type EmailEnv } from '@/lib/email';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// 길이가 같은 문자열 비교로 타이밍 차이를 줄인다.
function sameSecret(a: string, b: string) {
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: Request) {
  const secret = (
    (env as unknown as { REMINDER_RUNNER_SECRET?: string })
      .REMINDER_RUNNER_SECRET ?? ''
  ).trim();
  const presented = (request.headers.get('authorization') ?? '').replace(
    /^Bearer\s+/i,
    '',
  );
  // 비밀값이 설정되지 않았으면 실행 자체를 막는다. 무인증 호출을 허용하지 않는다.
  if (!secret || !sameSecret(secret, presented))
    return reply({ error: 'not authorized' }, 401);
  try {
    const result = await dispatchReminders({
      sender: senderFrom(env as unknown as EmailEnv),
      origin: new URL(request.url).origin,
    });
    return reply(result);
  } catch (error) {
    console.error('reminder dispatch failed', error);
    return reply({ error: 'dispatch failed' }, 503);
  }
}
