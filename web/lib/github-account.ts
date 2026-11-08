// 마이페이지에서 연결한 GitHub 계정(2026-11-08). 연결·해제는 브라우저가 Supabase linkIdentity로 하고,
// 서버는 사용자 토큰으로 Supabase에 직접 물어 DB를 맞춘다. 요청 본문의 아이디는 믿지 않는다.
// Supabase 조회가 실패하면 AuthUnavailable을 던지고 저장된 연결은 건드리지 않는다.
import { database } from './db';
import { AuthUnavailable } from './auth';

export type GithubIdentity = { githubId: string; login: string };
export type GithubAccount = { githubId: string; login: string; linkedAt: Date };
export type GithubIdentitySource = (request: Request) => Promise<GithubIdentity | null>;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REQUEST_TIMEOUT_MS = 10_000;

function text(v: unknown) {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

/**
 * Supabase /auth/v1/user 응답에서 GitHub 신원. identities 배열에 GitHub가 없을 때만 null(연결 해제로 처리).
 * 응답 구조가 이상하거나 GitHub 값이 틀리면 AuthUnavailable — 연결을 지우지 않는다.
 */
export function githubFromSupabaseUser(user: unknown): GithubIdentity | null {
  const identities = (user as { identities?: unknown } | null)?.identities;
  if (!Array.isArray(identities)) throw new AuthUnavailable();
  const found = identities.find((i) => (i as { provider?: unknown })?.provider === 'github') as
    | { id?: unknown; identity_data?: Record<string, unknown> }
    | undefined;
  if (!found) return null;
  const data = found.identity_data ?? {};
  const githubId = text(data.provider_id) || text(data.sub) || text(found.id);
  const login = text(data.user_name) || text(data.preferred_username);
  if (!githubId || !LOGIN.test(login)) throw new AuthUnavailable();
  return { githubId, login };
}

async function supabaseGithub(request: Request): Promise<GithubIdentity | null> {
  const auth = request.headers.get('authorization') ?? '';
  // Bearer가 없는 요청은 로컬 개발 헤더 로그인뿐이다. 연결된 GitHub가 없는 것으로 본다.
  if (!auth.startsWith('Bearer ')) return null;
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!base || !URL.canParse(base) || !key) {
    console.warn('github account: SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
    throw new AuthUnavailable();
  }
  let response: Response;
  try {
    response = await fetch(base + '/auth/v1/user', {
      headers: { authorization: auth, apikey: key },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn('github account: supabase user lookup failed', (e as Error).name);
    throw new AuthUnavailable();
  }
  if (response.status !== 200) {
    console.warn('github account: supabase user lookup status', response.status);
    throw new AuthUnavailable();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    // 본문 수신 시간 초과·JSON 오류는 연결 해제가 아니라 조회 실패다.
    console.warn('github account: supabase user body unreadable', (e as Error).name);
    throw new AuthUnavailable();
  }
  return githubFromSupabaseUser(body);
}

export let githubIdentitySource: GithubIdentitySource = supabaseGithub;
/** 테스트 대역. */
export function useGithubIdentitySource(next: GithubIdentitySource) {
  githubIdentitySource = next;
}

export async function readGithubAccount(userId: string): Promise<GithubAccount | null> {
  const r = await database()
    .prepare('SELECT github_id,login,linked_at FROM github_accounts WHERE user_id=?')
    .bind(userId)
    .first();
  return r ? { githubId: String(r.github_id), login: String(r.login), linkedAt: r.linked_at as Date } : null;
}

const eventId = () => 'gle_' + crypto.randomUUID();

/** Supabase 신원에 맞춰 연결을 저장·삭제하고 결과를 돌려준다. 바뀐 것만 한 트랜잭션에 기록한다. */
export async function syncGithubAccount(request: Request, userId: string, now: Date): Promise<GithubAccount | null> {
  const found = await githubIdentitySource(request);
  const db = database();
  if (!found) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO github_link_events(id,user_id,github_id,login,action,created_at) SELECT ?,user_id,github_id,login,'unlink',? FROM github_accounts WHERE user_id=?",
        )
        .bind(eventId(), now, userId),
      db.prepare('DELETE FROM github_accounts WHERE user_id=?').bind(userId),
    ]);
    return null;
  }
  const { githubId, login } = found;
  await db.batch([
    // 다른 사용자에게 남은 옛 행: Supabase는 한 신원을 한 사용자에게만 붙이므로 지금 사용자 것이다.
    db
      .prepare(
        "INSERT INTO github_link_events(id,user_id,github_id,login,action,created_at) SELECT ?,user_id,github_id,login,'transfer_out',? FROM github_accounts WHERE github_id=? AND user_id<>?",
      )
      .bind(eventId(), now, githubId, userId),
    db.prepare('DELETE FROM github_accounts WHERE github_id=? AND user_id<>?').bind(githubId, userId),
    // 내 행이 다른 GitHub였다면(해제 sync를 놓침) 그 해제부터 남긴다.
    db
      .prepare(
        "INSERT INTO github_link_events(id,user_id,github_id,login,action,created_at) SELECT ?,user_id,github_id,login,'unlink',? FROM github_accounts WHERE user_id=? AND github_id<>?",
      )
      .bind(eventId(), now, userId, githubId),
    db
      .prepare(
        "INSERT INTO github_link_events(id,user_id,github_id,login,action,created_at) SELECT ?,?,?,?,'link',? WHERE NOT EXISTS(SELECT 1 FROM github_accounts WHERE user_id=? AND github_id=?)",
      )
      .bind(eventId(), userId, githubId, login, now, userId, githubId),
    // 같은 GitHub면 연결 시각을 유지하고 아이디만 갱신한다.
    db
      .prepare(
        'INSERT INTO github_accounts(user_id,github_id,login,linked_at,updated_at) VALUES(?,?,?,?,?)' +
          ' ON CONFLICT (user_id) DO UPDATE SET github_id=excluded.github_id,login=excluded.login,updated_at=excluded.updated_at,' +
          'linked_at=CASE WHEN github_accounts.github_id=excluded.github_id THEN github_accounts.linked_at ELSE excluded.linked_at END',
      )
      .bind(userId, githubId, login, now, now),
  ]);
  return readGithubAccount(userId);
}
