'use client';
/* eslint-disable next/no-html-link-for-pages -- Sites sign-in requires top-level navigation, without router prefetch. */
import { useEffect, useState, useCallback } from 'react';
import { TaskEditor } from '@/components/task-editor';
import { TaskCollection } from '@/components/task-collection';
import {
  ProjectWorkspace,
  ProjectDetails,
  type ProjectMeta,
  workspaceViews,
} from '@/components/project-workspace';
import {
  ArrowRight,
  Check,
  Clock3,
  Flag,
  Zap,
  Sparkles,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  people as samplePeople,
  seoulTime,
  type Sprint,
  type Plan,
  type Schedule,
  type Task,
} from '@/lib/sprint';

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
      {(id, view, setView) => (
        <Dashboard key={id} projectId={id} tab={view} setTab={setView} />
      )}
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
function Dashboard({
  projectId,
  tab,
  setTab,
}: {
  projectId: string;
  tab: string;
  setTab: (view: string) => void;
}) {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [editingRevision, setEditingRevision] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [dialog, setDialog] = useState<Modal>(null);
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
      const res = await fetch(
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
    fetch('/api/sprint?project=' + encodeURIComponent(projectId), {
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
              setTab(input.view);
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
      const res = await fetch('/api/sprint', {
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
      const res = await fetch(
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
    if (!state) return;
    const t = state.sprint.tasks.find(
      (t) =>
        !t.done && (state.me.role === 'owner' || t.person === state.me.person),
    );
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
  const progress = state?.completion.total
    ? Math.round((state.completion.confirmed / state.completion.total) * 100)
    : 0;
  const deadline = state?.policy?.deadlineAt ?? null;
  const remainingHours = deadline
    ? (Date.parse(deadline) - Date.parse(state?.asOf ?? '1970-01-01')) / 3600000
    : null;
  const remainingDays =
    remainingHours === null ? null : Math.max(0, Math.ceil(remainingHours / 24));
  const phase = PHASE[lifecycle];
  return (
    <div className="app-shell">
      <div className="work-main">
        {!s ? (
          <section className="agent-card">
            <h1>스프린트 작업 공간</h1>
            {needsLogin && (
              <a
                className="btn primary"
                href="/signin-with-chatgpt?return_to=/"
                target="_top"
              >
                ChatGPT로 로그인
              </a>
            )}
            <p>{error || '저장한 프로젝트를 불러오는 중입니다.'}</p>
            {error && (
              <button className="btn primary" onClick={refresh}>
                다시 불러오기
              </button>
            )}
          </section>
        ) : (
          <>
            <header className="work-heading">
              <div>
                <p className="work-kicker">
                  {lifecycle === 'legacy'
                    ? '이전 규칙으로 만든 기록'
                    : deadline
                      ? `시작 ${seoulTime(state!.policy!.startedAt!)} · 마감 ${seoulTime(deadline)} KST`
                      : `시작하면 그 시각부터 ${state?.policy?.durationDays ?? 7}일`}
                </p>
                <h1>
                  {workspaceViews.find((v) => v.id === tab)?.label ??
                    '프로젝트 업무'}
                </h1>
              </div>
              <div className="work-heading-actions">
                <span className="pill">
                  {lifecycle === 'active'
                    ? `D−${remainingDays}`
                    : phase.label}{' '}
                  · 결과물 {state!.completion.confirmed}/
                  {state!.completion.total} 확인
                </span>
                <button
                  className="icon-btn"
                  disabled={busy}
                  onClick={refresh}
                  aria-label="최신 상태 불러오기"
                >
                  <RefreshCw size={17} />
                </button>
                <button className="btn" disabled={busy} onClick={exportProject}>
                  내보내기
                </button>
                {writable && agreedToGoal && (
                  <button className="btn" disabled={busy} onClick={openCheckin}>
                    체크인
                  </button>
                )}
              </div>
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
            {lifecycle === 'draft' && state!.readiness && (
              <section className="project-panel">
                <span className="eyebrow">START CHECK</span>
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
            {tab === 'docs' && <ProjectDetails state={state!} refresh={load} />}
            {tab === 'today' && (
              <section className="work-section">
                <section className="overview-grid">
                  <div className="countdown">
                    <div className="row">
                      <span className="eyebrow">THE FINISH LINE</span>
                      <Flag size={21} />
                    </div>
                    <div className="day-number">
                      {lifecycle === 'active'
                        ? `D−${remainingDays}`
                        : phase.label}
                      <span>
                        {lifecycle === 'completed'
                          ? '결과물 확인 완료'
                          : lifecycle === 'draft'
                            ? '아직 기간이 줄지 않아요'
                            : '하나씩, 확실하게'}
                      </span>
                    </div>
                    <div className="row tiny">
                      <span>
                        {state!.policy?.startedAt
                          ? seoulTime(state!.policy.startedAt) + ' 시작'
                          : '시작 전'}
                      </span>
                      <b>
                        {deadline ? seoulTime(deadline) + ' KST 마감' : '기한 미확정'}
                      </b>
                    </div>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">합의 결과물 확인</span>
                    <div className="stat-number">
                      {progress}
                      <small>%</small>
                    </div>
                    <Progress value={progress} aria-label="결과물 확인율" />
                    <p>
                      {state!.completion.total}개 중{' '}
                      {state!.completion.confirmed}개 팀장 확인
                    </p>
                    <div className="stat-footer">
                      <Check size={16} /> 업무 개수·보고 횟수는 완주 조건이
                      아닙니다
                    </div>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">마감까지 남은 작업</span>
                    <div className="stat-number">
                      {plan?.needed ?? 0}
                      <small>시간</small>
                    </div>
                    <span
                      className={`pill ${plan?.feasible ? 'green' : 'orange'}`}
                    >
                      {!tasks.length
                        ? '업무 계획 전'
                        : plan?.feasible
                          ? '현재 계산상 배치 가능'
                          : `${plan?.unscheduled.length ?? 0}개 작업 배치 불가`}
                    </span>
                    <p>
                      하루 {plan?.dailyHours ?? 8}시간 공통 가정 · 남은 예산{' '}
                      {Math.round((plan?.available ?? 0) * 10) / 10}시간
                      {plan?.provisional ? ' (예상)' : ''}
                    </p>
                    <button
                      className="text-link stat-footer"
                      onClick={() => setTab('team')}
                    >
                      공수 계산 보기 <ArrowRight size={15} />
                    </button>
                  </div>
                </section>
                <div className="content-grid">
                  <section>
                    <div className="section-heading">
                      <h2>
                        <Sparkles size={19} /> 메이트의 다음 한 수
                      </h2>
                      <span className="tiny muted">
                        공통 공수 · 의존관계 기반 계산
                      </span>
                    </div>
                    <div
                      className={`agent-card ${plan && !plan.feasible ? 'at-risk' : ''}`}
                    >
                      <div className="agent-top">
                        <span className="agent-mark">
                          <Zap size={20} />
                        </span>
                        <span
                          className={`pill ${plan?.feasible ? 'green' : 'orange'}`}
                        >
                          {lifecycle === 'completed'
                            ? '완주 확인'
                            : !tasks.length
                              ? '업무 계획 전'
                              : plan?.feasible
                                ? '진행 가능'
                                : '계획 조정 필요'}
                        </span>
                      </div>
                      <h3>
                        {lifecycle === 'completed'
                          ? '약속한 결과물을 확인했어요.'
                          : !tasks.length
                            ? '업무를 나누고 담당자를 정해요.'
                            : plan?.feasible
                              ? '핵심 흐름을 하나씩 연결해요.'
                              : '현재 계획으로는 마감을 넘기는 작업이 있어요.'}
                      </h3>
                      <p>
                        {lifecycle === 'completed'
                          ? '결과물과 변경 내역이 저장되었습니다. 보증금은 자동 환급되지 않습니다.'
                          : !tasks.length
                            ? '실행 계획에서 업무와 담당자를 추가해주세요. 담당자별 가용시간 입력은 없고, 전원 하루 8시간을 공통 가정으로 계산합니다.'
                            : plan?.feasible
                              ? '체크인으로 남은 공수를 갱신하면 예상 종료를 다시 계산합니다. 예상치는 승인된 업무 마감과 다릅니다.'
                              : '담당자별 남은 공수가 남은 기간을 넘습니다. 목표를 줄이거나 기한을 미루는 대신 담당 재배정·진행 순서·구현 방법을 바꿔주세요.'}
                      </p>
                      <div className="agent-impact">
                        <span>
                          <Clock3 size={15} /> 필요 {plan?.needed ?? 0}h / 남은
                          예산 {Math.round((plan?.available ?? 0) * 10) / 10}h
                        </span>
                        <span>
                          전원 하루 {plan?.dailyHours ?? 8}시간 공통 가정
                        </span>
                      </div>
                      <button className="text-link" onClick={() => setTab('plan')}>
                        실행 계획 보기 <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="section-heading task-heading">
                      <h2>최근 체크인</h2>
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
                          하루 한 번 완료·남은 일·막힘을 남겨주세요. 보고가
                          없어도 완주 판정에는 영향을 주지 않습니다.
                        </p>
                      )}
                    </div>
                  </section>
                  <aside>
                    <div className="section-heading">
                      <h2>담당자별 남은 공수</h2>
                    </div>
                    <div className="team-card">
                      {(plan?.perPerson ?? []).map((p) => (
                        <div className="member" key={p.person}>
                          <span
                            className="avatar"
                            style={{
                              background: people[p.person]?.color ?? '#eee',
                            }}
                          >
                            {people[p.person]?.initial ?? '?'}
                          </span>
                          <div>
                            <b>{people[p.person]?.name ?? '팀원'}</b>
                            <span>
                              필요 {p.needed}h / 남은 예산{' '}
                              {Math.round(p.available * 10) / 10}h
                            </span>
                          </div>
                          <span
                            className={`pill ${p.needed > p.available ? 'orange' : 'green'}`}
                          >
                            {p.needed > p.available ? '초과' : '여유'}
                          </span>
                        </div>
                      ))}
                      <div className="team-note">
                        합계가 충분해도 의존 작업 때문에 늦어질 수 있어요.
                      </div>
                    </div>
                    <div className="goal-card">
                      <span className="eyebrow">
                        {state!.agreement?.fixed_at
                          ? 'FIXED PROMISE'
                          : 'OUR PROMISE'}
                      </span>
                      <h3>
                        크게 벌이지 않고,
                        <br />
                        작게 완성하기.
                      </h3>
                      <p>{state!.agreement?.goal ?? state!.details?.goal}</p>
                      <div>
                        <Check size={15} /> 시작 시 합의한 결과물은 줄이지 않음
                      </div>
                      <div>
                        <Check size={15} /> 변경 사유와 승인 이력 저장
                      </div>
                    </div>
                  </aside>
                </div>
              </section>
            )}
            {(tab === 'plan' || tab === 'mine') && plan && (
              <section>
                <div className="work-health">
                  <span
                    className={`status-dot ${plan.feasible ? 'status-done' : 'status-in_progress'}`}
                  />
                  {!tasks.length
                    ? '업무와 담당자를 등록해 계획을 시작하세요.'
                    : plan.feasible
                      ? `마감 내 배치 가능 · 남은 ${plan.needed}h / 예산 ${Math.round(plan.available * 10) / 10}h`
                      : `${plan.unscheduled.length}개 업무 배치 불가 · 담당 재배정과 선행 작업을 확인해주세요.`}
                  <button onClick={() => setTab('today')}>
                    스프린트 현황 →
                  </button>
                </div>
                <TaskCollection
                  sprint={s}
                  plan={plan}
                  me={state!.me}
                  members={state!.members}
                  checkins={state!.checkins}
                  busy={busy || !writable || !agreedToGoal}
                  error={error}
                  mine={tab === 'mine'}
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
            {tab === 'team' && (
              <section className="work-section">
                <div className="section-heading">
                  <h2>공통 공수 계산</h2>
                  <span className="pill">
                    전원 하루 {plan?.dailyHours ?? 8}시간 가정
                  </span>
                </div>
                <p className="hint">
                  개인별 가용시간 입력은 없습니다. 하루{' '}
                  {plan?.dailyHours ?? 8}시간은 남은 기간과 남은 공수를 비교하기
                  위한 내부 계산 가정이며, 실제 근무 시간대나 출퇴근 시각을
                  뜻하지 않습니다.
                </p>
                <div className="people-grid">
                  {(plan?.perPerson ?? []).map((p) => (
                    <div className="person-card" key={p.person}>
                      <span
                        className="avatar large"
                        style={{
                          background: people[p.person]?.color ?? '#eee',
                        }}
                      >
                        {people[p.person]?.initial ?? '?'}
                      </span>
                      <h3>{people[p.person]?.name ?? '팀원'}</h3>
                      <p>{people[p.person]?.role ?? '팀원'}</p>
                      <div className="person-hours">
                        {Math.round(p.available * 10) / 10}
                        <small>시간 남은 예산</small>
                      </div>
                      <p className="tiny muted">
                        필요 {p.needed}h ·{' '}
                        {p.finish
                          ? `예상 종료 ${seoulTime(p.finish)} KST`
                          : '배정된 업무 없음'}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="section-heading">
                  <h2>팀 상태</h2>
                </div>
                <div className="team-card">
                  {state!.members.map((m) => (
                    <div className="member" key={m.person}>
                      <span
                        className="avatar"
                        style={{
                          background: people[m.person]?.color ?? '#eee',
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
              </section>
            )}
            {tab === 'result' && (
              <section className="work-section">
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
                    <span className="eyebrow">DELIVERABLES</span>
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
              ? '지금 남은 일을 알려주세요.'
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
                    '체크인을 저장하고 예상 일정을 재계산했습니다.',
                  )
                )
                  setDialog(null);
              }}
            >
              <label className="input-label" htmlFor="checkin-task">
                진행 중인 업무
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
                {tasks
                  .filter(
                    (t) =>
                      !t.done && (isOwner || t.person === state?.me.person),
                  )
                  .map((t) => (
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
