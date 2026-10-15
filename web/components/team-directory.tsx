'use client';
// 공개 팀 목록(사이드바 '팀 찾기')과 팀장의 공개·참여 신청 관리. 규칙: docs/superpowers/specs/2026-10-15-team-list-join-design.md
// 참여 가능 여부·인원·목표 버전은 서버가 판단한다. 화면은 받은 값을 보여주고 결과를 다시 불러온다.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase-browser';

export type Team = {
  projectId: string;
  title: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  lifecycle: 'draft' | 'active';
  goalVersion: number;
  members: number;
  maxMembers: number;
  startedAt: string | null;
  deadlineAt: string | null;
  joinUntil: string | null;
  joinable: boolean;
  requested: boolean;
};
type JoinRequest = {
  requestId: string;
  projectId: string;
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  createdAt: string;
};
const STATUS: Record<JoinRequest['status'], string> = {
  pending: '팀장 확인 대기',
  approved: '승인됨',
  rejected: '거절됨',
  cancelled: '취소함',
  expired: '신청 마감',
};
const kst = (at: string) =>
  new Date(at).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function withTeam(list: Team[] | null, fresh: Team) {
  return list?.map((t) => (t.projectId === fresh.projectId ? { ...t, ...fresh } : t)) ?? null;
}

async function call<T>(path: string, body?: Record<string, unknown>) {
  const res = await apiFetch(path, {
    cache: 'no-store',
    ...(body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const data = (await res.json()) as T & { error?: string; details?: Team };
  if (!res.ok) {
    const failure = new Error(
      res.status === 401 ? '로그인이 필요합니다.' : data.error || '처리하지 못했습니다.',
    ) as Error & { details?: Team };
    if (res.status === 409 && data.details) failure.details = data.details;
    throw failure;
  }
  return data;
}

export function TeamDirectory() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [open, setOpen] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // 처음 열 때와 신청·취소 뒤에 서버 목록을 다시 받는다.
  function load() {
    return call<{ teams: Team[]; requests: JoinRequest[] }>('/api/teams').then((data) => {
      setTeams(data.teams);
      setRequests(data.requests);
    });
  }
  useEffect(() => {
    call<{ teams: Team[]; requests: JoinRequest[] }>('/api/teams')
      .then((data) => {
        setTeams(data.teams);
        setRequests(data.requests);
      })
      .catch((e: Error) => setMessage(e.message));
  }, []);
  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      setOpen('');
      setAgreed(false);
      // 목록을 다시 받은 뒤에 결과를 알린다. 안내와 화면 상태가 어긋나지 않게.
      await load();
      setMessage(done);
    } catch (e) {
      const changed = (e as { details?: Team }).details;
      // 저장 시점에 목표가 바뀌었으면 최신 목표로 다시 확인받는다.
      if (changed) {
        setTeams(withTeam(teams, changed));
        setAgreed(false);
      }
      setMessage((e as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const pending = (projectId: string) =>
    requests.find((r) => r.projectId === projectId && r.status === 'pending');
  return (
    <section className="project-panel team-directory">
      <h1>팀 찾기</h1>
      <p>
        팀장이 공개한 팀 중 지금 합류할 수 있는 팀입니다. 준비 중인 팀과 시작 후 24시간이 지나지 않은
        팀이 보입니다. 참여 신청 후 팀장이 승인하면 팀원이 됩니다.
      </p>
      {message && <output className="hint">{message}</output>}
      {teams === null ? (
        <p className="tiny muted">팀 목록을 불러오는 중입니다.</p>
      ) : !teams.length ? (
        <p className="muted">지금 합류할 수 있는 공개 팀이 없습니다.</p>
      ) : (
        <ul className="team-list">
          {teams.map((t) => {
            const mine = pending(t.projectId);
            return (
              <li key={t.projectId} className="team-entry">
                <div className="team-entry-head">
                  <h2>{t.title}</h2>
                  <span className={'pill' + (t.lifecycle === 'active' ? ' orange' : '')}>
                    {t.lifecycle === 'active' ? '진행 중' : '준비 중'}
                  </span>
                  <span className="pill">
                    {t.members}/{t.maxMembers}명
                  </span>
                </div>
                <p>{t.goal}</p>
                <dl className="team-entry-facts">
                  <dt>기능 범위</dt>
                  <dd>{t.scope}</dd>
                  <dt>완료 기준</dt>
                  <dd>{t.completionCriteria}</dd>
                  <dt>기한</dt>
                  <dd>
                    {t.deadlineAt
                      ? `${kst(t.deadlineAt)} 마감 · 신청은 ${t.joinUntil ? kst(t.joinUntil) : ''}까지`
                      : '시작하면 그 시각부터 7일'}
                  </dd>
                </dl>
                {mine ? (
                  <div className="team-entry-actions">
                    <span className="pill green">신청함 · 팀장 확인 대기</span>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => call('/api/teams', { action: 'cancel', requestId: mine.requestId }),
                          '신청을 취소했습니다.',
                        )
                      }
                    >
                      신청 취소
                    </button>
                  </div>
                ) : open === t.projectId ? (
                  <form
                    className="team-entry-actions"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        () =>
                          call('/api/teams', {
                            action: 'request',
                            projectId: t.projectId,
                            // 이 화면에서 실제로 확인한 목표 버전을 보낸다.
                            goalVersion: t.goalVersion,
                            agreed,
                          }),
                        `${t.title}에 참여를 신청했습니다. 팀장이 승인하면 내 프로젝트에 나타납니다.`,
                      );
                    }}
                  >
                    <label className="agreement">
                      <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                      목표 v{t.goalVersion}·기능 범위·완료 기준을 확인하고 참여를 신청합니다.
                    </label>
                    <button className="btn primary" disabled={!agreed || busy}>
                      신청 보내기
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setOpen('')}>
                      닫기
                    </button>
                  </form>
                ) : (
                  <div className="team-entry-actions">
                    <button
                      className="btn primary"
                      disabled={!t.joinable || busy}
                      onClick={() => {
                        setOpen(t.projectId);
                        setAgreed(false);
                      }}
                    >
                      {t.joinable ? '참여 신청' : t.members >= t.maxMembers ? '인원 마감' : '신청 불가'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {requests.length > 0 && (
        <>
          <h2>내 신청</h2>
          <ul className="team-requests">
            {requests.map((r) => (
              <li key={r.requestId}>
                {r.status === 'approved' ? (
                  <a href={'/workspace?project=' + encodeURIComponent(r.projectId)}>{r.title}</a>
                ) : (
                  r.title
                )}{' '}
                · {STATUS[r.status]} · {kst(r.createdAt)} 신청
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// 팀장 전용: 팀 목록 공개와 들어온 참여 신청 처리. 프로젝트 메뉴의 팀원 구역에 둔다.
export function TeamListing({
  state,
  refresh,
  writable,
}: {
  state: {
    projectId: string;
    me: { role: string };
    sprint: { revision: number };
    listed?: boolean;
    joinRequests?: { id: string; display_name: string; goal_version: number; created_at: string }[];
    policy?: { goalVersion: number } | null;
  };
  refresh: () => Promise<unknown>;
  writable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (state.me.role !== 'owner' || !state.policy) return null;
  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      await call('/api/projects', { projectId: state.projectId, revision: state.sprint.revision, ...body });
      await refresh();
      setMessage(done);
    } catch (e) {
      await refresh();
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const requests = state.joinRequests ?? [];
  return (
    <div className="team-listing">
      <label className="agreement">
        <input
          type="checkbox"
          checked={Boolean(state.listed)}
          disabled={busy || !writable}
          onChange={(e) =>
            void run(
              { action: 'setListed', listed: e.target.checked },
              e.target.checked ? '팀 찾기 목록에 공개했습니다.' : '팀 찾기 목록에서 내렸습니다.',
            )
          }
        />
        팀 찾기 목록에 공개 (이름·목표·범위·완료 기준·인원만 보입니다)
      </label>
      {requests.length > 0 && (
        <ul>
          {requests.map((r) => (
            <li key={r.id}>
              {r.display_name} · {kst(r.created_at)} 신청
              {state.policy && r.goal_version !== state.policy.goalVersion && ' · 이전 목표에 동의(승인 후 재동의 필요)'}{' '}
              <button
                className="btn primary"
                disabled={busy || !writable}
                onClick={() => void run({ action: 'decideJoin', requestId: r.id, approve: true }, `${r.display_name}님을 팀원으로 받았습니다.`)}
              >
                승인
              </button>{' '}
              <button
                className="btn"
                disabled={busy || !writable}
                onClick={() => void run({ action: 'decideJoin', requestId: r.id, approve: false }, '신청을 거절했습니다.')}
              >
                거절
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <output>{message}</output>}
    </div>
  );
}
