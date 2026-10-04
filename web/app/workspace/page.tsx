'use client';
/* eslint-disable next/no-html-link-for-pages -- Sites sign-in requires top-level navigation, without router prefetch. */
import { useEffect, useState, useCallback } from 'react';
import { TaskEditor } from '@/components/task-editor';
import { TaskCollection } from '@/components/task-collection';
import { ChangeReview } from '@/components/change-review';
import { RaceHome } from '@/components/race-home';
import {
  ProjectWorkspace,
  ProjectDetails,
  TeamInvites,
  type ProjectMeta,
  type WorkspaceNav,
  workspaceViews,
} from '@/components/project-workspace';
import { reportChoices, sprintDay, type View } from '@/lib/race';
import { RaceClock } from '@/components/race-clock';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Check,
  Clock3,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  people as samplePeople,
  seoulTime,
  type Sprint as ServerSprint,
  type Plan,
  type Schedule,
  type Task as ServerTask,
} from '@/lib/sprint';
import type { Wire } from '@/lib/wire';
// 화면은 JSON으로 받은 값을 다룬다(시각은 ISO 문자열).
type Sprint = Wire<ServerSprint>;
type Task = Wire<ServerTask>;
import { meetingSuggestions } from '@/lib/meeting-suggestions';
import { apiFetch, signInWithGoogle } from '@/lib/supabase-browser';

export type Lifecycle =
  | 'legacy'
  | 'draft'
  | 'active'
  | 'completed'
  | 'expired';
export type Deliverable = {
  deliverableId: string;
  position: number;
  title: string;
  fixedAt: string | null;
  evidence: string;
  evidenceBy: string | null;
  evidenceAt: string | null;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
};
type State = ProjectMeta & {
  asOf: string;
  lifecycle: Lifecycle;
  policy: {
    goalVersion: number;
    durationDays: number;
    dailyHours: number;
    startedAt: string | null;
    deadlineAt: string | null;
    completedAt: string | null;
  } | null;
  agreement: {
    goal_version: number;
    title: string;
    goal: string;
    scope: string;
    completion_criteria: string;
    fixed_at: string;
  } | null;
  deliverables: Deliverable[];
  completion: {
    ready: boolean;
    total: number;
    confirmed: number;
    missing: string[];
  };
  readiness: {
    ready: boolean;
    joined: number;
    agreed: number;
    missing: string[];
  } | null;
  plan: Plan | null;
  legacySchedule: Schedule | null;
  sprint: Sprint;
  checkins: {
    id: string;
    task_id: number;
    note: string;
    remaining: number;
    created_at: string;
  }[];
  events: {
    revision: number;
    action: string;
    detail: string;
    created_at: string;
  }[];
};
type Modal = 'checkin' | 'stepBack' | 'evidence' | null;
export default function Home() {
  return (
    <ProjectWorkspace>
      {(id, nav) => <Dashboard key={id} projectId={id} nav={nav} />}
    </ProjectWorkspace>
  );
}
const PHASE: Record<Lifecycle, { label: string; note: string }> = {
  legacy: {
    label: '이전 기록',
    note: '이전 규칙으로 만든 기록입니다. 열람과 내보내기만 할 수 있습니다.',
  },
  draft: {
    label: '준비 중',
    note: '아직 스프린트 기간이 소모되지 않습니다. 팀장이 시작해야 기한이 확정됩니다.',
  },
  active: { label: '진행 중', note: '' },
  completed: {
    label: '완주',
    note: '합의한 결과물을 모두 확인했습니다. 이후 변경은 저장되지 않습니다.',
  },
  expired: {
    label: '기한 종료',
    note: '마감이 지나 모든 변경이 잠겼습니다. 열람과 내보내기는 계속할 수 있습니다.',
  },
};
function Dashboard({ projectId, nav }: { projectId: string; nav: WorkspaceNav }) {
  const { view: tab, setView: setTab, mine, setMine } = nav;
  const [reviewing, setReviewing] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [editingRevision, setEditingRevision] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [dialog, setDialog] = useState<Modal>(null);
  // 초대 토큰은 한 번만 받으므로 대화상자를 닫아도 링크를 잃지 않게 여기에 둔다.
  const [inviteLink, setInviteLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState('');
  const [taskId, setTaskId] = useState(1);
  const [remaining, setRemaining] = useState(2);
  const [evidenceId, setEvidenceId] = useState('');
  const [evidence, setEvidence] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null | undefined>(
    undefined,
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const res = await apiFetch(
        '/api/sprint?project=' + encodeURIComponent(projectId),
        { cache: 'no-store', signal },
      );
      const body = (await res.json()) as State & { error?: string };
      if (res.status === 401) setNeedsLogin(true);
      if (!res.ok) throw new Error(body.error ?? '불러오지 못했습니다.');
      setState(body);
      return body as State;
    },
    [projectId],
  );
  useEffect(() => {
    const c = new AbortController();
    apiFetch('/api/sprint?project=' + encodeURIComponent(projectId), {
      cache: 'no-store',
      signal: c.signal,
    })
      .then(async (res) => {
        const body = (await res.json()) as State & { error?: string };
        if (res.status === 401) setNeedsLogin(true);
        if (!res.ok) throw new Error(body.error ?? '불러오지 못했습니다.');
        setState(body);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    const update = () => {
      if (!document.hidden) void load(c.signal).catch(() => {});
    };
    const interval = setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => {
      c.abort();
      clearInterval(interval);
      window.removeEventListener('focus', update);
    };
  }, [projectId, load]);
  // An optional navigation tool shares the same visible tabs; no data mutation is exposed.
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: object,
            options: { signal: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const c = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'navigate_sprint_demo',
            description: 'Open a sprint view. Does not modify project data.',
            inputSchema: {
              type: 'object',
              properties: {
                view: {
                  type: 'string',
                  enum: workspaceViews.map((v) => v.id),
                },
              },
              required: ['view'],
            },
            async execute(input: { view: string }) {
              if (!workspaceViews.some((v) => v.id === input.view))
                throw new Error('Invalid view');
              setTab(input.view as View);
              return { requestedView: input.view };
            },
          },
          { signal: c.signal },
        ),
      ).catch(() => {});
    } catch {
      /* Optional capability. */
    }
    return () => c.abort();
  }, [setTab]);
  async function mutate(
    action: string,
    fields: Record<string, unknown> = {},
    message = '저장했습니다.',
  ) {
    if (!state || busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch('/api/sprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          projectId,
          revision: state.sprint.revision,
          ...fields,
        }),
      });
      const body = (await res.json()) as State & { error?: string };
      if (!res.ok) {
        if (res.status === 409) {
          await load();
          if (
            action === 'createTask' ||
            action === 'editTask' ||
            action === 'taskDetails'
          )
            throw new Error(
              '편집 중 다른 변경이 저장됐습니다. 입력 내용을 확인한 뒤 창을 닫고 다시 열어주세요.',
            );
        }
        throw new Error(body.error ?? '저장하지 못했습니다.');
      }
      setState(body);
      setNotice(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했습니다.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await load();
      setNotice('서버의 최신 상태를 불러왔습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  async function exportProject() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(
        '/api/sprint?project=' + encodeURIComponent(projectId) + '&format=export',
        { cache: 'no-store' },
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? '내보내지 못했습니다.');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(body, null, 2)], {
          type: 'application/json',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `projectmate-${projectId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice('시작 합의·결과물·업무·변경 기록을 내보냈습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '내보내지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  function openCheckin() {
    const t = reportable.first;
    if (!t) {
      setNotice('본인에게 배정된 진행 중인 업무가 없습니다.');
      return;
    }
    setTaskId(t.id);
    setRemaining(t.remaining);
    setNote('');
    setDialog('checkin');
  }
  const s = state?.sprint;
  const people = s?.people ?? samplePeople;
  const isOwner = state?.me.role === 'owner';
  const plan = state?.plan;
  const lifecycle = state?.lifecycle ?? 'draft';
  const writable = lifecycle === 'draft' || lifecycle === 'active';
  const agreedToGoal =
    !!state?.policy &&
    state.me.agreedGoalVersion === state.policy.goalVersion &&
    !state.me.leftAt;
  const tasks = s?.tasks ?? [];
  const done = tasks.filter((t) => t.done).length;
  const meetingProposals =
    state && plan
      ? meetingSuggestions(
          tasks,
          plan,
          state.members.map((m) => ({ person: m.person, displayName: m.display_name })),
          new Date(state.asOf),
        )
      : [];
  const deadline = state?.policy?.deadlineAt ?? null;
  const phase = PHASE[lifecycle];
  const reportable = state
    ? reportChoices(tasks, state.me, isOwner)
    : { open: [] as Task[], first: null };
  const onClockZero = useCallback(() => {
    void load().catch(() => {});
  }, [load]);
  return (
    <div className="app-shell">
      <div className="work-main">
        {!s ? (
          <section className="agent-card">
            <h1>스프린트 작업 공간</h1>
            {needsLogin && (
              <button
                className="btn primary"
                onClick={() => signInWithGoogle().catch((e: Error) => setError(e.message))}
              >
                Google로 로그인
              </button>
            )}
            <p>{error || '저장한 프로젝트를 불러오는 중입니다.'}</p>
            {!error && !needsLogin && (
              <div className="loading-skeleton" aria-hidden="true">
                <Skeleton className="h-24" />
                <Skeleton className="h-40" />
              </div>
            )}
            {error && (
              <button className="btn primary" onClick={refresh}>
                다시 불러오기
              </button>
            )}
          </section>
        ) : (
          <>
            <header className="race-bar">
              <SidebarTrigger aria-label="사이드바 열기 또는 닫기" />
              <div className="race-title">
                <b>{state!.agreement?.title ?? s.title}</b>
                <span>
                  {lifecycle === 'active' && state!.policy?.startedAt
                    ? `DAY ${sprintDay(state!.policy.startedAt, Date.parse(state!.asOf), state!.policy.durationDays)} / ${state!.policy.durationDays} · `
                    : ''}
                  {phase.label}
                </span>
              </div>
              <RaceClock
                lifecycle={lifecycle}
                deadline={deadline}
                asOf={state!.asOf}
                durationDays={state!.policy?.durationDays ?? 7}
                onZero={onClockZero}
              />
              {writable && agreedToGoal && (
                <button
                  className="race-cta"
                  disabled={busy}
                  aria-disabled={!reportable.open.length}
                  onClick={openCheckin}
                >
                  진행 보고
                </button>
              )}
            </header>
            {phase.note && (
              <output className="work-health">
                <span
                  className={`status-dot ${writable ? 'status-in_progress' : 'status-done'}`}
                />
                {phase.note}
              </output>
            )}
            {state!.policy && !agreedToGoal && !state!.me.leftAt && (
              <section className="project-panel">
                <h2>최신 목표와 완료 기준을 확인해주세요.</h2>
                <p>
                  목표 v{state!.policy.goalVersion}에 동의해야 업무를 변경할 수
                  있습니다. 동의 전에는 읽기만 가능합니다.
                </p>
                <p>
                  <b>목표</b> {state!.agreement?.goal}
                </p>
                <p>
                  <b>기능 범위</b> {state!.agreement?.scope}
                </p>
                <p>
                  <b>완료 기준</b> {state!.agreement?.completion_criteria}
                </p>
                <ul>
                  {state!.deliverables.map((d) => (
                    <li key={d.deliverableId}>{d.title}</li>
                  ))}
                </ul>
                <label className="agree" htmlFor="agree-goal">
                  <Checkbox
                    id="agree-goal"
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(Boolean(v))}
                  />{' '}
                  이 목표와 완료 기준으로 진행하는 데 동의합니다.
                </label>
                <button
                  className="btn primary"
                  disabled={!agreed || busy || !writable}
                  onClick={() =>
                    mutate(
                      'agreeGoal',
                      { goalVersion: state!.policy!.goalVersion },
                      '목표 동의를 저장했습니다.',
                    )
                  }
                >
                  동의하고 계속
                </button>
              </section>
            )}
            {tab === 'home' && lifecycle === 'draft' && state!.readiness && (
              <section className="project-panel">
                <span className="eyebrow">시작 전 확인</span>
                <h2>시작 준비</h2>
                <p>
                  가입 {state!.readiness.joined}명 · 최신 목표 동의{' '}
                  {state!.readiness.agreed}명. 초대만 보낸 사람은 인원에 포함되지
                  않습니다.
                </p>
                {state!.readiness.missing.map((m) => (
                  <p key={m} className="tiny muted">
                    · {m}
                  </p>
                ))}
                <p className="tiny muted">
                  시작하면 그 시각부터 {state!.policy?.durationDays}일 뒤가
                  최종 기한이며, 목표·결과물·완료 기준과 기한은 더 이상 바꿀 수
                  없습니다.
                </p>
                {isOwner && (
                  <button
                    className="btn primary"
                    disabled={busy || !state!.readiness.ready}
                    onClick={() =>
                      mutate(
                        'start',
                        {},
                        '스프린트를 시작하고 목표와 기한을 고정했습니다.',
                      )
                    }
                  >
                    스프린트 시작
                  </button>
                )}
              </section>
            )}
            {tab === 'home' && (
              <section className="work-section">
                {lifecycle !== 'draft' && (
                  <RaceHome
                    lifecycle={lifecycle}
                    asOf={state!.asOf}
                    startedAt={state!.policy?.startedAt ?? null}
                    deadline={deadline}
                    tasks={tasks}
                    plan={plan ?? null}
                    members={state!.members}
                    me={state!.me}
                    people={people}
                    onTasks={() => setTab('tasks')}
                  />
                )}
                <div className="race-below">
                  <section>
                  <div className="section-heading task-heading">
                    <h2>회의 제안</h2>
                    <span className="tiny muted">
                      공통 공수 · 의존관계 기반 계산
                    </span>
                  </div>
                  <div className="task-list">
                    {meetingProposals.length === 0 ? (
                      <p className="empty-copy">지금은 따로 모일 일이 없습니다.</p>
                    ) : (
                      <>
                        {meetingProposals.map((sug) => (
                          <div className="task-row" key={sug.id}>
                            <Sparkles size={18} />
                            <div>
                              <b>{sug.title}</b>
                              <span>
                                {sug.suggestedAt
                                  ? seoulTime(sug.suggestedAt) + ' KST'
                                  : '시점 미정'}{' '}
                                · {sug.reason}
                              </span>
                              <ul className="tiny muted">
                                {sug.agenda.map((item, i) => (
                                  <li key={i}>{item}</li>
                                ))}
                              </ul>
                              <span className="tiny muted">
                                관련 담당자:{' '}
                                {sug.people
                                  .map(
                                    (p) =>
                                      state!.members.find((m) => m.person === p)
                                        ?.display_name ?? '담당자 미정',
                                  )
                                  .join(', ')}
                              </span>
                            </div>
                          </div>
                        ))}
                        <p className="tiny muted">
                          회의 후 업무 메뉴의 &apos;회의록으로 변경안 만들기&apos;에
                          회의록을 붙여넣으면 업무 변경안을 만들 수 있습니다.
                        </p>
                      </>
                    )}
                  </div>
                  </section>
                  <section>
                  <div className="section-heading task-heading">
                    <h2>최근 진행 보고</h2>
                  </div>
                  <div className="task-list">
                    {state!.checkins.length ? (
                      state!.checkins.slice(0, 3).map((c) => (
                        <div className="task-row" key={c.id}>
                          <Check size={18} />
                          <div>
                            <b>{c.note}</b>
                            <span>
                              {tasks.find((t) => t.id === c.task_id)?.title} ·
                              남은 {c.remaining}h ·{' '}
                              {new Date(c.created_at).toLocaleString('ko-KR', {
                                timeZone: 'Asia/Seoul',
                              })}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="empty-copy">
                        하루 한 번 진행 보고로 완료·남은 일·막힘을 남겨주세요. 보고가
                        없어도 완주 판정에는 영향을 주지 않습니다.
                      </p>
                    )}
                  </div>
                  </section>
                </div>
              </section>
            )}
            {tab === 'tasks' && plan && (
              <section>
                <div className="tasks-bar">
                  <span
                    className={`status-dot ${plan.feasible ? 'status-done' : 'status-in_progress'}`}
                  />
                  <span className="tasks-health">
                    {!tasks.length
                      ? '업무와 담당자를 등록해 계획을 시작하세요.'
                      : plan.feasible
                        ? `마감 내 배치 가능 · 남은 ${plan.needed}h / 예산 ${Math.round(plan.available * 10) / 10}h`
                        : `${plan.unscheduled.length}개 업무 배치 불가 · 담당 재배정과 선행 작업을 확인해주세요.`}
                  </span>
                  <button
                    className="btn toggle-btn"
                    aria-pressed={mine}
                    onClick={() => setMine(!mine)}
                  >
                    내 것만
                  </button>
                  <button className="btn" onClick={() => setReviewing(!reviewing)}>
                    {reviewing ? '업무 목록으로' : '회의록으로 변경안 만들기'}
                  </button>
                </div>
                {reviewing ? (
                <ChangeReview
                  projectId={projectId}
                  revision={s.revision}
                  tasks={s.tasks}
                  members={state!.members}
                  me={state!.me}
                  writable={writable && agreedToGoal && !state!.me.leftAt}
                  onApplied={(next) => setState(next as State)}
                />
                ) : (
                  <TaskCollection
                    sprint={s}
                    plan={plan}
                    asOf={state!.asOf}
                    me={state!.me}
                    members={state!.members}
                    checkins={state!.checkins}
                    busy={busy || !writable || !agreedToGoal}
                    error={error}
                    mine={mine}
                    mutate={mutate}
                    onAdd={() => {
                      setError('');
                      setEditingRevision(s.revision);
                      setEditingTask(null);
                    }}
                    onEdit={(t) => {
                      setError('');
                      setEditingRevision(s.revision);
                      setEditingTask(t);
                    }}
                  />
                )}
                <details className="workspace-history">
                  <summary>변경 기록</summary>
                  {state!.events.map((e) => (
                    <p key={e.revision}>
                      <span>v{e.revision}</span>
                      {e.detail}
                    </p>
                  ))}
                </details>
              </section>
            )}
            {tab === 'project' && (
              <section className="work-section project-stack">
                <ProjectDetails state={state!} />
                <section className="project-block">
                  <div className="section-heading">
                    <h2>팀원 · {state!.members.length}/4명</h2>
                  </div>
                  <div className="team-card">
                    {state!.members.map((m) => (
                      <div className="member" key={m.person}>
                        <span
                          className="avatar"
                          style={{
                            background: people[m.person]?.color ?? 'var(--gray-200)',
                          }}
                        >
                          {m.display_name.slice(0, 1)}
                        </span>
                        <div>
                          <b>{m.display_name}</b>
                          <span>
                            {m.role === 'owner' ? '팀장' : '팀원'} ·{' '}
                            {m.left_at
                              ? '참여 중단 보고'
                              : m.agreed_goal_version ===
                                  state!.policy?.goalVersion
                                ? `목표 v${m.agreed_goal_version} 동의`
                                : '재동의 필요'}
                          </span>
                        </div>
                      </div>
                    ))}
                    <div className="team-note">
                      참여 중단은 당사자가 보고하고, 남은 팀 기준의 변경안은
                      팀장이 검토합니다. 자동 재배정은 하지 않습니다.
                    </div>
                  </div>
                  <TeamInvites
                    state={state!}
                    refresh={load}
                    link={inviteLink}
                    setLink={setInviteLink}
                    writable={writable}
                  />
                </section>
                <section className="project-block">
                  <div className="section-heading">
                    <h2>
                      완주 확인 · 결과물 {state!.completion.confirmed}/{state!.completion.total}
                    </h2>
                  </div>
                  <div className="refund-grid">
                    <div className="refund-main">
                      <ShieldCheck size={30} />
                      <h2>
                        완주는 처음 약속한 결과물로,
                        <br />
                        보고 횟수로 판정하지 않아요.
                      </h2>
                      <p>
                        체크리스트를 모두 끝냈는지와 합의한 결과물을 달성했는지는
                        다릅니다. 업무 {done}/{tasks.length}개가 완료되어도 필수
                        결과물이 미확인이면 완주할 수 없습니다.
                      </p>
                      <div className="receipt">
                        <div>
                          <span>이용료 예시</span>
                          <b>100,000원</b>
                        </div>
                        <div>
                          <span>보증금 예시</span>
                          <b>200,000원</b>
                        </div>
                        <div className="receipt-total">
                          <span>실제 결제·환급</span>
                          <b>연결 안 됨</b>
                        </div>
                      </div>
                      <p>
                        결과물 근거 확인과 금전 환급 판정은 별개입니다. AI가
                        증빙의 진실성을 자동으로 보증하지 않습니다.
                      </p>
                    </div>
                    <div className="refund-criteria">
                      <span className="eyebrow">완주 기준</span>
                      <h3>합의한 결과물</h3>
                      {state!.deliverables.map((d) => (
                        <div className="criterion" key={d.deliverableId}>
                          <span
                            className={
                              d.confirmed ? 'criteria-check ok' : 'criteria-check'
                            }
                          >
                            {d.confirmed ? (
                              <Check size={16} />
                            ) : (
                              <Clock3 size={16} />
                            )}
                          </span>
                          <div>
                            <b>{d.title}</b>
                            <p>{d.evidence || '근거가 아직 없습니다.'}</p>
                            {writable && agreedToGoal && (
                              <>
                                <button
                                  className="text-link"
                                  disabled={busy}
                                  onClick={() => {
                                    setEvidenceId(d.deliverableId);
                                    setEvidence(d.evidence);
                                    setDialog('evidence');
                                  }}
                                >
                                  근거 기록·수정
                                </button>
                                {isOwner && (
                                  <button
                                    className="text-link"
                                    disabled={busy || !d.evidence}
                                    onClick={() =>
                                      mutate(
                                        'deliverableConfirm',
                                        {
                                          deliverableId: d.deliverableId,
                                          confirmed: !d.confirmed,
                                        },
                                        d.confirmed
                                          ? '확인을 취소했습니다.'
                                          : '팀장 확인을 저장했습니다.',
                                      )
                                    }
                                  >
                                    {d.confirmed
                                      ? '확인 취소'
                                      : '팀장이 직접 확인'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                      <button
                        className="btn primary wide"
                        disabled={
                          busy ||
                          !isOwner ||
                          lifecycle !== 'active' ||
                          !state!.completion.ready
                        }
                        onClick={() =>
                          mutate(
                            'finish',
                            {},
                            '완주 확인을 저장했습니다. 실제 환급은 발생하지 않습니다.',
                          )
                        }
                      >
                        {lifecycle === 'completed'
                          ? '완주 기록 저장됨'
                          : '기한 내 완주 확인'}
                      </button>
                      <p className="tiny muted">
                        확인 자료는 코드 저장소와 실행 방법, 핵심 기능 데모 또는
                        영상, 팀원별 기여 내용입니다. 배포 URL은 프로젝트에서 별도
                        합의한 경우에만 필요합니다.
                      </p>
                    </div>
                  </div>
                </section>
                <section className="project-block">
                  <div className="section-heading">
                    <h2>기타</h2>
                  </div>
                  <div className="project-actions">
                    <button className="btn" disabled={busy} onClick={exportProject}>
                      내보내기
                    </button>
                    {writable && agreedToGoal && !state!.me.leftAt && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setNote('');
                          setDialog('stepBack');
                        }}
                      >
                        참여 중단 보고
                      </button>
                    )}
                  </div>
                </section>
              </section>
            )}
          </>
        )}
        {error && s && (
          <div className="error-notice" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <output className="notice" aria-live="polite">
            <Check size={16} />
            {notice}
          </output>
        )}
      </div>
      {editingTask !== undefined && state && (
        <TaskEditor
          task={editingTask}
          tasks={state.sprint.tasks}
          members={state.members}
          projectDeadline={state.policy?.deadlineAt ?? null}
          busy={busy}
          error={error}
          onClose={() => setEditingTask(undefined)}
          onSave={(fields) =>
            mutate(
              editingTask ? 'editTask' : 'createTask',
              { ...fields, revision: editingRevision },
              '업무를 저장하고 예상 일정을 다시 계산했습니다.',
            )
          }
        />
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent className="demo-dialog">
          <DialogTitle>
            {dialog === 'checkin'
              ? '진행 보고'
              : dialog === 'stepBack'
                ? '참여 중단을 팀에 알립니다.'
                : '결과물 근거 기록'}
          </DialogTitle>
          <DialogDescription>
            {dialog === 'checkin'
              ? '막힌 점과 남은 공수를 저장하면 예상 종료를 다시 계산합니다. 보고가 없어도 완주 판정은 결과물 기준입니다.'
              : dialog === 'stepBack'
                ? '보고만으로 담당이나 기한이 바뀌지 않습니다. 남은 팀 기준의 변경은 팀장이 검토합니다.'
                : '저장소와 실행 방법, 데모 또는 영상, 팀원별 기여를 남겨주세요. 팀장이 사람의 판단으로 확인합니다.'}
          </DialogDescription>
          {dialog === 'checkin' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(
                    'checkin',
                    { taskId, note, remaining },
                    '진행 보고를 저장하고 예상 일정을 재계산했습니다.',
                  )
                )
                  setDialog(null);
              }}
            >
              <label className="input-label" htmlFor="checkin-task">
                보고할 업무
              </label>
              <NativeSelect
                id="checkin-task"
                value={taskId}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setTaskId(id);
                  setRemaining(
                    s?.tasks.find((t) => t.id === id)?.remaining ?? 0,
                  );
                }}
              >
                {reportable.open.map((t) => (
                    <NativeSelectOption key={t.id} value={t.id}>
                      {t.title}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <label className="input-label" htmlFor="remaining">
                앞으로 남은 시간
              </label>
              <input
                id="remaining"
                type="number"
                min="0"
                max="200"
                step="0.5"
                required
                value={remaining}
                onChange={(e) => setRemaining(Number(e.target.value))}
              />
              <label className="input-label" htmlFor="note">
                완료한 것 · 막힌 점
              </label>
              <textarea
                id="note"
                rows={4}
                maxLength={1000}
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="btn primary wide"
                disabled={busy || !note.trim()}
              >
                저장하고 재계산
              </button>
            </form>
          ) : dialog === 'stepBack' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(
                    'stepBack',
                    { note },
                    '참여 중단 보고를 저장했습니다.',
                  )
                )
                  setDialog(null);
              }}
            >
              <label className="input-label" htmlFor="leave-note">
                팀에 알릴 내용
              </label>
              <textarea
                id="leave-note"
                rows={4}
                maxLength={1000}
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="btn primary wide"
                disabled={busy || !note.trim()}
              >
                보고 저장
              </button>
            </form>
          ) : dialog === 'evidence' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(
                    'deliverableEvidence',
                    { deliverableId: evidenceId, evidence },
                    '결과물 근거를 저장했습니다. 팀장 확인이 필요합니다.',
                  )
                )
                  setDialog(null);
              }}
            >
              <label className="input-label" htmlFor="evidence">
                근거
              </label>
              <textarea
                id="evidence"
                rows={5}
                maxLength={2000}
                required
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
              <button
                className="btn primary wide"
                disabled={busy || evidence.trim().length < 5}
              >
                근거 저장
              </button>
            </form>
          ) : null}
          {busy && <p className="tiny muted">서버에 저장하는 중입니다…</p>}
          {error && (
            <p role="alert" className="dialog-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
