import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Identity = { id: string; email: string; name: string };

type AuthEnv = { SUPABASE_URL?: string; AUTH_DEV_HEADERS?: string };
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function displayName(name: string, email: string) {
  return (name || email.split('@')[0] || '팀원').slice(0, 60);
}

/** Supabase가 발급한 access token만 받는다. 검증 실패·키 조회 실패는 모두 null. */
async function fromToken(token: string): Promise<Identity | null> {
  const base = ((env as unknown as AuthEnv).SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  jwks ??= createRemoteJWKSet(new URL(base + '/auth/v1/.well-known/jwks.json'));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: base + '/auth/v1',
      audience: 'authenticated',
    });
    const email =
      typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!payload.sub || !email) return null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.full_name === 'string'
        ? meta.full_name
        : typeof meta.name === 'string'
          ? meta.name
          : '';
    return { id: payload.sub, email, name: displayName(name, email) };
  } catch {
    return null;
  }
}

/** 로컬 개발·테스트 전용. 호스팅 플랫폼 형식의 헤더를 그대로 믿는다. */
function fromDevHeaders(request: Request): Identity | null {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) return null;
  const email = (request.headers.get('oai-authenticated-user-email') ?? '')
    .trim()
    .toLowerCase();
  let name = request.headers.get('oai-authenticated-user-full-name') ?? '';
  if (
    request.headers.get('oai-authenticated-user-full-name-encoding') ===
    'percent-encoded-utf-8'
  ) {
    try {
      name = decodeURIComponent(name);
    } catch {
      name = '';
    }
  }
  return { id, email, name: displayName(name, email) };
}

export async function identity(request: Request): Promise<Identity | null> {
  const auth = request.headers.get('authorization') ?? '';
  // Bearer가 있으면 그 결과만 쓴다. 실패해도 개발 헤더로 넘어가지 않는다.
  if (auth.startsWith('Bearer ')) return fromToken(auth.slice(7).trim());
  // 운영에서 켜지면 누구나 헤더로 사칭할 수 있다. 로컬 개발(vite dev)과 테스트에만 둔다.
  if ((env as unknown as AuthEnv).AUTH_DEV_HEADERS === '1')
    return fromDevHeaders(request);
  return null;
}
