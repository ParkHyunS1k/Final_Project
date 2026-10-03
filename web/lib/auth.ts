import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Identity = { id: string; email: string; name: string };

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** 토큰이 아니라 로그인 서비스(설정·키 서버) 쪽 문제. 401 대신 503으로 돌려준다. */
export class AuthUnavailable extends Error {
  status = 503;
  constructor() {
    super('인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
  }
}
// 키 서버 응답 실패·시간 초과·잘못된 JWKS. 그 밖의 jose 오류는 토큰 문제로 본다.
const SERVICE_ERRORS = new Set(['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

function displayName(name: string, email: string) {
  return (name || email.split('@')[0] || '팀원').slice(0, 60);
}

/** Supabase가 발급한 access token만 받는다. 토큰 문제는 null, 로그인 서비스 장애는 AuthUnavailable. */
async function fromToken(token: string): Promise<Identity | null | AuthUnavailable> {
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    console.warn('auth: SUPABASE_URL is not set');
    return new AuthUnavailable();
  }
  jwks ??= createRemoteJWKSet(new URL(base + '/auth/v1/.well-known/jwks.json'));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: base + '/auth/v1',
      audience: 'authenticated',
    });
    const email =
      typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!payload.sub || !email) return null;
    // 초대는 이메일 일치로 판정한다. 이메일 소유를 검증해 주는 Google 가입만 받는다.
    const app = (payload.app_metadata ?? {}) as Record<string, unknown>;
    if (app.provider !== 'google') return null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.full_name === 'string'
        ? meta.full_name
        : typeof meta.name === 'string'
          ? meta.name
          : '';
    return { id: payload.sub, email, name: displayName(name, email) };
  } catch (e) {
    // 토큰 값은 남기지 않는다. jose 오류 코드로 원인(만료, 키 없음, JWKS 조회 실패)을 구분한다.
    const code = (e as { code?: string }).code;
    if (!code || SERVICE_ERRORS.has(code)) {
      console.warn('auth: login service unavailable', code ?? (e as Error).name);
      return new AuthUnavailable();
    }
    console.warn('auth: token rejected', code);
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

/** 라우트는 AuthUnavailable이면 503, null이면 401을 돌려준다. */
export async function identity(
  request: Request,
): Promise<Identity | null | AuthUnavailable> {
  const auth = request.headers.get('authorization') ?? '';
  // Bearer가 있으면 그 결과만 쓴다. 실패해도 개발 헤더로 넘어가지 않는다.
  if (auth.startsWith('Bearer ')) return fromToken(auth.slice(7).trim());
  // 운영에서 켜지면 누구나 헤더로 사칭할 수 있다. 로컬 개발(next dev)과 테스트에만 둔다.
  // 운영(next start·Vercel은 NODE_ENV=production)에서는 값이 잘못 설정돼도 열리지 않는다.
  if (process.env.AUTH_DEV_HEADERS === '1' && process.env.NODE_ENV !== 'production')
    return fromDevHeaders(request);
  return null;
}
