/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// 값이 없으면(.env.local 미설정 로컬 개발) 토큰 없이 요청한다. 서버는 AUTH_DEV_HEADERS로만 받는다.
export const supabase =
  url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;

/** getSession()은 Google에서 돌아온 직후 ?code= 교환이 끝날 때까지 기다린다. */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const session = supabase && (await supabase.auth.getSession()).data.session;
  const headers = new Headers(init.headers);
  if (session) headers.set('Authorization', 'Bearer ' + session.access_token);
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
  if (!supabase) throw new Error('VITE_SUPABASE_URL·VITE_SUPABASE_ANON_KEY가 필요합니다.');
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl(location.href) },
  });
}

export async function signOut() {
  await supabase?.auth.signOut();
  location.assign('/');
}
