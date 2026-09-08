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
  dates,
  schedule,
  type Sprint,
  type Schedule,
  type Task,
} from '@/lib/sprint';

type Proposal = {
  id: string;
  base_revision: number;
  defer_ids: string;
  status: string;
  created_at: string;
};
type State = ProjectMeta & {
  asOf: string;
  sprint: Sprint;
  schedule: Schedule;
  proposal: Proposal | null;
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
type Modal = 'join' | 'checkin' | 'recovery' | null;
export default function Home() {
  return (
    <ProjectWorkspace>
      {(id, view, setView) => (
        <Dashboard key={id} projectId={id} tab={view} setTab={setView} />
      )}
    </ProjectWorkspace>
  );
}
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
  const [person, setPerson] = useState(0);
  const [capacityDate, setCapacityDate] = useState('');
  const [hours, setHours] = useState(2);
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
        setPerson(body.me.person);
        setHours(
          body.sprint.capacity.find((c) => c.person === body.me.person)
            ?.hours ?? 0,
        );
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
                  enum: ['today', 'plan', 'team', 'refund', 'mine', 'docs'],
                },
              },
              required: ['view'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: false },
            execute(input: unknown) {
              if (
                !input ||
                typeof input !== 'object' ||
                Object.keys(input).length !== 1 ||
                !('view' in input) ||
                typeof input.view !== 'string' ||
                !['today', 'plan', 'team', 'refund', 'mine', 'docs'].includes(
                  input.view,
                )
              )
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
  function openCheckin() {
    if (!state) return;
    const t = state.sprint.tasks.find(
      (t) =>
        !t.done &&
        !t.deferred &&
        (state.me.role === 'owner' || t.person === state.me.person),
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
  const plan = state?.schedule;
  const active = s?.tasks.filter((t) => !t.deferred) ?? [];
  const done = active.filter((t) => t.done).length;
  const progress = active.length ? Math.round((done / active.length) * 100) : 0;
  const proposal = state?.proposal;
  const proposalCurrent =
    proposal?.status === 'pending' && proposal.base_revision === s?.revision;
  const deferIds = proposal ? (JSON.parse(proposal.defer_ids) as number[]) : [];
  const after =
    s && proposal
      ? schedule(
          {
            ...s,
            tasks: s.tasks.map((t) =>
              deferIds.includes(t.id) ? { ...t, deferred: true } : t,
            ),
          },
          new Date(state?.asOf ?? '1970-01-01'),
        )
      : null;
  const days = s ? dates(s.startDate, s.deadline.slice(0, 10)) : [];
  const remainingDays = s
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(s.deadline) - Date.parse(state?.asOf ?? '1970-01-01')) /
            86400000,
        ),
      )
    : 0;
  const finished = s?.finished ?? false;
  const joined = Boolean(state?.me.agreedAt);
  const canFinish =
    joined &&
    Boolean(state?.checkins.length) &&
    active.length > 0 &&
    done === active.length;
  return (
    <div className="app-shell">
      <div className="work-main">
        {!s || !plan ? (
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
                  {s.startDate} — {s.deadline.slice(0, 10)} · 18:00 KST
                </p>
                <h1>
                  {workspaceViews.find((v) => v.id === tab)?.label ??
                    '프로젝트 업무'}
                </h1>
              </div>
              <div className="work-heading-actions">
                <span className="pill">
                  {finished ? '완주' : `D−${remainingDays}`} · {done}/
                  {active.length} 완료
                </span>
                <button
                  className="icon-btn"
                  disabled={busy}
                  onClick={refresh}
                  aria-label="최신 상태 불러오기"
                >
                  <RefreshCw size={17} />
                </button>
                <button
                  className="btn"
                  disabled={busy || finished}
                  onClick={() => (joined ? openCheckin() : setDialog('join'))}
                >
                  {joined ? '체크인' : '참여 조건 확인'}
                </button>
              </div>
            </header>
            {tab === 'docs' && <ProjectDetails state={state} refresh={load} />}
            {tab === 'today' && (
              <section className="work-section">
                <section className="overview-grid">
                  <div className="countdown">
                    <div className="row">
                      <span className="eyebrow">THE FINISH LINE</span>
                      <Flag size={21} />
                    </div>
                    <div className="day-number">
                      {finished ? 'DONE' : `D−${remainingDays}`}
                      <span>
                        {finished ? '결과물 확인 완료' : '하나씩, 확실하게'}
                      </span>
                    </div>
                    <div className="sprint-track">
                      {days.map((d, i) => (
                        <div
                          key={d}
                          className={
                            Date.parse(d + 'T00:00:00+09:00') <=
                            Date.parse(state?.asOf ?? '1970-01-01')
                              ? 'passed'
                              : ''
                          }
                        >
                          <span />
                          {i === 0
                            ? '01'
                            : i === days.length - 1
                              ? String(days.length).padStart(2, '0')
                              : ''}
                        </div>
                      ))}
                    </div>
                    <div className="row tiny">
                      <span>{s.startDate} 시작</span>
                      <b>18:00 KST 마감 ↗</b>
                    </div>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">결과 확인 진행</span>
                    <div className="stat-number">
                      {progress}
                      <small>%</small>
                    </div>
                    <Progress value={progress} aria-label="작업 완료율" />
                    <p>
                      {active.length}개 중 {done}개 확인
                    </p>
                    <div className="stat-footer">
                      <Check size={16} /> 결과물 근거를 함께 기록
                    </div>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">마감까지 남은 작업</span>
                    <div className="stat-number">
                      {plan.needed}
                      <small>시간</small>
                    </div>
                    <span
                      className={`pill ${plan.feasible ? 'green' : 'orange'}`}
                    >
                      {!s.tasks.length
                        ? '업무 계획 전'
                        : plan.feasible
                          ? '현재 계산상 배치 가능'
                          : `${plan.unscheduled.length}개 작업 배치 불가`}
                    </span>
                    <p>날짜별 가용시간 합계 {plan.available}시간</p>
                    <button
                      className="text-link stat-footer"
                      onClick={() => setTab('team')}
                    >
                      가용시간 수정 <ArrowRight size={15} />
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
                        가용시간 · 의존관계 기반 계산
                      </span>
                    </div>
                    <div
                      className={`agent-card ${!plan.feasible ? 'at-risk' : ''}`}
                    >
                      <div className="agent-top">
                        <span className="agent-mark">
                          <Zap size={20} />
                        </span>
                        <span
                          className={`pill ${plan.feasible ? 'green' : 'orange'}`}
                        >
                          {finished
                            ? '완주 확인'
                            : !s.tasks.length
                              ? '업무 계획 전'
                              : plan.feasible
                                ? '진행 가능'
                                : '계획 조정 필요'}
                        </span>
                      </div>
                      <h3>
                        {finished
                          ? '약속한 결과물을 확인했어요.'
                          : !s.tasks.length
                            ? '팀을 모으고 가용시간을 확인해요.'
                            : plan.feasible
                              ? '핵심 흐름을 하나씩 연결해요.'
                              : '현재 계획으로는 마감을 넘기는 작업이 있어요.'}
                      </h3>
                      <p>
                        {finished
                          ? '결과물과 변경 내역이 저장되었습니다. 보증금은 자동 환급되지 않습니다.'
                          : !s.tasks.length
                            ? '실행 계획에서 업무와 담당자를 추가하고, 팀 · 가용시간에서 작업 가능한 시간을 입력해주세요.'
                            : plan.feasible
                              ? '작업이 늘거나 시간이 줄면 체크인과 가용시간을 업데이트해주세요. 남은 일정은 저장할 때마다 다시 계산합니다.'
                              : '남은 공수와 담당자별 가용시간을 확인했어요. 필수 기능을 유지하면서 부가 기능을 다음으로 미룰 수 있는지 계산해볼게요.'}
                      </p>
                      <div className="agent-impact">
                        <span>
                          <Clock3 size={15} /> 필요 {plan.needed}h / 가용{' '}
                          {plan.available}h
                        </span>
                        <span>30분 단위 · 오전 9시부터 배치</span>
                      </div>
                      {!plan.feasible ? (
                        <button
                          className="btn dark"
                          disabled={busy || !joined}
                          onClick={async () => {
                            if (
                              await mutate(
                                'propose',
                                {},
                                '현재 상태를 기준으로 복구안을 만들었습니다.',
                              )
                            )
                              setDialog('recovery');
                          }}
                        >
                          복구안 계산하기 <ArrowRight size={16} />
                        </button>
                      ) : (
                        <button
                          className="text-link"
                          onClick={() => setTab('plan')}
                        >
                          실행 계획 보기 <ArrowRight size={16} />
                        </button>
                      )}
                      {proposal?.status === 'pending' && (
                        <button
                          className="text-link proposal-link"
                          onClick={() => setDialog('recovery')}
                        >
                          저장된 복구안 {proposalCurrent ? '검토' : '다시 확인'}{' '}
                          →
                        </button>
                      )}
                    </div>
                    <div className="section-heading task-heading">
                      <h2>최근 체크인</h2>
                    </div>
                    <div className="task-list">
                      {state.checkins.length ? (
                        state.checkins.slice(0, 3).map((c) => (
                          <div className="task-row" key={c.id}>
                            <Check size={18} />
                            <div>
                              <b>{c.note}</b>
                              <span>
                                {s.tasks.find((t) => t.id === c.task_id)?.title}{' '}
                                · 남은 {c.remaining}h ·{' '}
                                {new Date(c.created_at).toLocaleString(
                                  'ko-KR',
                                  { timeZone: 'Asia/Seoul' },
                                )}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="empty-copy">
                          완료한 일과 막힌 점을 첫 체크인으로 남겨주세요.
                        </p>
                      )}
                    </div>
                  </section>
                  <aside>
                    <div className="section-heading">
                      <h2>담당자별 남은 용량</h2>
                    </div>
                    <div className="team-card">
                      {plan.perPerson.map((p) => (
                        <div className="member" key={p.person}>
                          <span
                            className="avatar"
                            style={{ background: people[p.person].color }}
                          >
                            {people[p.person].initial}
                          </span>
                          <div>
                            <b>{people[p.person].name}</b>
                            <span>
                              필요 {p.needed}h / 가용 {p.available}h
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
                      <span className="eyebrow">OUR PROMISE</span>
                      <h3>
                        크게 벌이지 않고,
                        <br />
                        작게 완성하기.
                      </h3>
                      <p>{state.details.goal}</p>
                      <div>
                        <Check size={15} /> 필수 기능은 복구안에서도 유지
                      </div>
                      <div>
                        <Check size={15} /> 변경 사유와 승인 이력 저장
                      </div>
                    </div>
                  </aside>
                </div>
              </section>
            )}
            {(tab === 'plan' || tab === 'mine') && (
              <section>
                <div className="work-health">
                  <span
                    className={`status-dot ${plan.feasible ? 'status-done' : 'status-in_progress'}`}
                  />
                  {!s.tasks.length
                    ? '업무와 가용시간을 입력해 계획을 시작하세요.'
                    : plan.feasible
                      ? `마감 내 배치 가능 · 남은 ${plan.needed}h / 가용 ${plan.available}h`
                      : `${plan.unscheduled.length}개 업무 배치 불가 · 가용시간과 선행 작업을 확인해주세요.`}
                  <button onClick={() => setTab('today')}>
                    스프린트 현황 →
                  </button>
                </div>
                <TaskCollection
                  sprint={s}
                  plan={plan}
                  me={state.me}
                  members={state.members}
                  checkins={state.checkins}
                  busy={busy}
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
                  {state.events.map((e) => (
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
                  <h2>날짜별로 실제 쓸 수 있는 시간</h2>
                  <span className="pill">
                    {state.details.legacy
                      ? '기존 샘플 역할 포함'
                      : '초대받은 팀원과 공유'}
                  </span>
                </div>
                <div className="people-grid">
                  {people.map((p, i) => (
                    <div className="person-card" key={p.name}>
                      <span
                        className="avatar large"
                        style={{ background: p.color }}
                      >
                        {p.initial}
                      </span>
                      <h3>{p.name}</h3>
                      <p>{p.role}</p>
                      <div className="person-hours">
                        {s.capacity
                          .filter((c) => c.person === i)
                          .reduce((a, c) => a + c.hours, 0)}
                        <small>시간 / 스프린트</small>
                      </div>
                    </div>
                  ))}
                </div>
                <form
                  className="capacity-editor"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await mutate(
                      'capacity',
                      { person, date: capacityDate || days[0], hours },
                      '날짜별 가용시간을 저장하고 일정을 다시 계산했습니다.',
                    );
                  }}
                >
                  <label htmlFor="person">
                    담당자
                    <NativeSelect
                      id="person"
                      value={person}
                      onChange={(e) => {
                        const p = Number(e.target.value);
                        setPerson(p);
                        setHours(
                          s.capacity.find(
                            (c) =>
                              c.person === p &&
                              c.date === (capacityDate || days[0]),
                          )?.hours ?? 0,
                        );
                      }}
                    >
                      {people.map((p, i) => (
                        <NativeSelectOption
                          key={i}
                          value={i}
                          disabled={!isOwner && i !== state.me.person}
                        >
                          {p.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <label htmlFor="capacity-date">
                    날짜
                    <NativeSelect
                      id="capacity-date"
                      value={capacityDate || days[0]}
                      onChange={(e) => {
                        setCapacityDate(e.target.value);
                        setHours(
                          s.capacity.find(
                            (c) =>
                              c.person === person && c.date === e.target.value,
                          )?.hours ?? 0,
                        );
                      }}
                    >
                      {days.map((d) => (
                        <NativeSelectOption key={d} value={d}>
                          {d}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <label htmlFor="capacity-hours">
                    가능한 시간
                    <input
                      id="capacity-hours"
                      type="number"
                      min="0"
                      max="12"
                      step="0.5"
                      required
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                    />
                  </label>
                  <button
                    className="btn primary"
                    disabled={
                      busy ||
                      !joined ||
                      finished ||
                      (!isOwner && person !== state?.me.person)
                    }
                  >
                    저장하고 재계산
                  </button>
                </form>
                <p className="hint">
                  0시간은 작업 불가로 처리합니다. 현재 버전은 입력한 시간을 오전
                  9시부터 연속 배치하며, 이미 지난 시간은 제외합니다.
                </p>
                <div className="capacity-summary">
                  {days.map((d) => (
                    <div key={d}>
                      <b>{d.slice(5)}</b>
                      {people.map((p, i) => (
                        <span key={i}>
                          {p.name}{' '}
                          {s.capacity.find(
                            (c) => c.person === i && c.date === d,
                          )?.hours ?? 0}
                          h
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {tab === 'refund' && (
              <section className="work-section">
                <div className="refund-grid">
                  <div className="refund-main">
                    <ShieldCheck size={30} />
                    <h2>
                      완주는 결과로 확인하고,
                      <br />
                      참여 약속은 기록으로 남겨요.
                    </h2>
                    <p>금액과 반환 정책은 검토 중인 예시입니다.</p>
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
                      팀원의 이탈과 개인의 성실한 기여는 별도로 검토합니다. 결과
                      확인 버튼은 금전 환급 판정이 아닙니다.
                    </p>
                  </div>
                  <div className="refund-criteria">
                    <span className="eyebrow">COMPLETION CHECK</span>
                    <h3>완주 확인 목록</h3>
                    {[
                      {
                        ok: joined,
                        title: '참여 조건 확인',
                        desc: '서비스 파일럿 조건 v1 동의 기록',
                      },
                      {
                        ok: Boolean(state.checkins.length),
                        title: '진행 상황 공유',
                        desc: `체크인 ${state.checkins.length}건 표시 · 최근 20건`,
                      },
                      {
                        ok: done === active.length,
                        title: '결과물 근거 확인',
                        desc: `활성 작업 ${done}/${active.length}개 확인`,
                      },
                    ].map((c) => (
                      <div className="criterion" key={c.title}>
                        <span
                          className={
                            c.ok ? 'criteria-check ok' : 'criteria-check'
                          }
                        >
                          {c.ok ? <Check size={16} /> : <Clock3 size={16} />}
                        </span>
                        <div>
                          <b>{c.title}</b>
                          <p>{c.desc}</p>
                        </div>
                      </div>
                    ))}
                    <button
                      className="btn primary wide"
                      disabled={!canFinish || finished || busy || !isOwner}
                      onClick={() =>
                        mutate(
                          'finish',
                          {},
                          '완주 확인을 저장했습니다. 실제 환급은 발생하지 않습니다.',
                        )
                      }
                    >
                      {finished ? '완주 기록 저장됨' : '기한 내 완주 확인'}
                    </button>
                    <p className="tiny muted">
                      이 버전은 결과물의 내용을 AI가 자동 검증하지 않습니다.
                      팀이 직접 확인한 근거를 저장합니다.
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
              '업무를 저장하고 일정을 다시 계산했습니다.',
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
            {dialog === 'join'
              ? '함께 끝내기로 약속해요.'
              : dialog === 'checkin'
                ? '지금 남은 일을 알려주세요.'
                : '현재 상태로 계산한 복구안'}
          </DialogTitle>
          <DialogDescription>
            {dialog === 'join'
              ? '목표를 확인하고 참여하는 파일럿입니다. 실제 결제는 없습니다.'
              : dialog === 'checkin'
                ? '막힌 점과 남은 공수를 저장하면 마감 내 배치 가능성을 다시 계산합니다.'
                : '필수 기능을 유지하면서 부가 기능을 다음 스프린트로 옮기는 안입니다.'}
          </DialogDescription>
          {dialog === 'join' ? (
            <>
              <p>
                체크인, 결과물 확인, 계획 변경 기록을 서버에 저장합니다. 보증금
                금액은 예시이며 실제 결제와 환급은 진행하지 않습니다.
              </p>
              <label className="agree" htmlFor="agree">
                <Checkbox
                  id="agree"
                  checked={agreed}
                  onCheckedChange={(v) => setAgreed(Boolean(v))}
                />{' '}
                참여 조건을 확인했습니다.
              </label>
              <button
                className="btn primary wide"
                disabled={!agreed || busy}
                onClick={async () => {
                  if (
                    await mutate(
                      'join',
                      { agreed },
                      '참여 약속을 저장했습니다.',
                    )
                  )
                    setDialog(null);
                }}
              >
                약속하고 시작
              </button>
            </>
          ) : dialog === 'checkin' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(
                    'checkin',
                    { taskId, note, remaining },
                    '체크인을 저장하고 일정을 재계산했습니다.',
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
                {active
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
          ) : dialog === 'recovery' && proposal ? (
            <>
              <span className={`pill ${proposalCurrent ? 'green' : 'orange'}`}>
                {proposalCurrent
                  ? `현재 버전 ${s?.revision} 기준`
                  : '상태가 바뀌었거나 이미 처리된 제안'}
              </span>
              {s?.tasks
                .filter((t) => deferIds.includes(t.id))
                .map((t) => (
                  <div className="recovery-step" key={t.id}>
                    <Flag size={19} />
                    <div>
                      <b>{t.title}</b>
                      <p>
                        {people[t.person].name} · {t.remaining}h를 다음
                        스프린트로 이동
                      </p>
                    </div>
                  </div>
                ))}
              <div className="recovery-summary">
                {plan?.needed}h → <b>{after?.needed}h</b>
              </div>
              <p>
                적용 후 계산:{' '}
                {after?.feasible
                  ? '마감 내 배치 가능'
                  : '현재 시점에는 배치 불가'}
                . 필수 기능과 최종 마감은 유지합니다.
              </p>
              <button
                className="btn primary wide"
                disabled={
                  busy || !proposalCurrent || !after?.feasible || !isOwner
                }
                onClick={async () => {
                  if (
                    await mutate(
                      'approve',
                      { proposalId: proposal.id },
                      '복구안을 적용하고 변경 이력을 저장했습니다.',
                    )
                  )
                    setDialog(null);
                }}
              >
                검토한 복구안 승인
              </button>
              <button
                className="btn"
                disabled={busy || !proposalCurrent || !isOwner}
                onClick={async () => {
                  if (
                    await mutate(
                      'reject',
                      { proposalId: proposal.id },
                      '복구안을 거절했습니다.',
                    )
                  )
                    setDialog(null);
                }}
              >
                이 안은 사용하지 않기
              </button>
              {!proposalCurrent && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    mutate('propose', {}, '최신 상태로 새 제안을 만들었습니다.')
                  }
                >
                  최신 상태로 다시 계산
                </button>
              )}
            </>
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
