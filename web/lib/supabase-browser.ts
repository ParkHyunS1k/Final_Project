import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// 값이 없으면(.env.local 미설정 로컬 개발) 토큰 없이 요청한다. 서버는 AUTH_DEV_HEADERS로만 받는다.
export const supabase =
  url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;

/**
 * 세션 갱신이 인증 서버 장애로 실패하면 토큰 없이 보내지 않는다. 그러면 401과 로그인 버튼이 떠
 * 재로그인만 반복된다. 문구에 '로그인'을 넣지 않아 화면이 로그인 버튼을 띄우지 않게 한다.
 */
export function bearerFrom(result: {
  data: { session: { access_token: string } | null };
  error: unknown;
}) {
  if (result.error) throw new Error('인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
  return result.data.session ? 'Bearer ' + result.data.session.access_token : null;
}

/** getSession()은 Google에서 돌아온 직후 ?code= 교환이 끝날 때까지 기다린다. */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const authorization = supabase && bearerFrom(await supabase.auth.getSession());
  const headers = new Headers(init.headers);
  if (authorization) headers.set('Authorization', authorization);
  return fetch(path, { ...init, headers });
}

/**
 * 지금 주소(?create=1, ?invite= 포함)로 돌아온다. 로그인을 취소하면 Supabase가 붙인
 * error 파라미터가 주소에 남는데, 그대로 다시 실으면 다음 로그인의 code 교환이 실패한다.
 */
export function returnUrl(href: string) {
  const u = new URL(href);
  for (const k of ['code', 'error', 'error_code', 'error_description'])
    u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error('NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY가 필요합니다.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl(location.href) },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase?.auth.signOut();
  location.assign('/');
}
