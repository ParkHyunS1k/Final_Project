'use client';
import { useEffect, useState } from 'react';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Plus,
  Columns3,
  Table2,
  FileText,
  Clock3,
  CalendarClock,
  Link2,
  GitPullRequest,
} from 'lucide-react';
import { apiFetch } from '@/lib/supabase-browser';
import {
  DETAIL_MAX_PULLS,
  stalledHours,
  taskRef,
  type Pull,
  type PullDetail,
} from '@/lib/github-prs';
import { CHECK_LABEL, CheckIcon, PR_LABEL, PrPanel, stallText } from './dev-panel';
import {
  people as samplePeople,
  type Sprint as ServerSprint,
  type Task as ServerTask,
  type Plan,
  seoulTime,
} from '@/lib/sprint';
import type { Wire } from '@/lib/wire';
// 화면은 JSON으로 받은 값을 다룬다(시각은 ISO 문자열).
type Sprint = Wire<ServerSprint>;
type Task = Wire<ServerTask>;
import type { ProjectMeta } from './project-workspace';

type Checkin = {
  id: string;
  task_id: number;
  note: string;
  remaining: number;
  created_at: string;
};
type Mutate = (
  action: string,
  fields?: Record<string, unknown>,
  message?: string,
) => Promise<boolean>;
const statuses = [
  { id: 'todo', label: '시작 전' },
  { id: 'in_progress', label: '진행 중' },
  { id: 'done', label: '완료' },
];
export { PrPanel };

function statusOf(t: Task) {
  return t.done ? 'done' : (t.status ?? 'todo');
}
export function TaskCollection({
  sprint,
  plan,
  asOf,
  me,
  members,
  checkins,
  busy,
  error,
  mine,
  mutate,
  onEdit,
  onAdd,
  projectId,
  pulls: givenPulls,
}: {
  sprint: Sprint;
  plan: Plan;
  /** 서버가 알려준 현재 시각. 렌더 중 Date.now()를 쓰지 않는다. */
  asOf: string;
  me: ProjectMeta['me'];
  members: ProjectMeta['members'];
  checkins: Checkin[];
  busy: boolean;
  error: string;
  mine: boolean;
  mutate: Mutate;
  onEdit: (task: Task) => void;
  onAdd: () => void;
  /** 있으면 등록된 저장소의 PR을 읽어 업무에 붙인다. */
  projectId?: string;
  /** 업무 id별 연결 PR. 주면 불러오지 않는다(렌더 테스트용). */
  pulls?: Record<number, Pull[]>;
}) {
  // 보드가 기본이다(2026-11-09). 표는 날짜·예상 완료를 한눈에 볼 때 쓴다.
  const [view, setView] = useState('board');
  // PR 연결(2026-11-14): 화면을 열 때 한 번 읽는다. 실패하면 PR 표시만 빠진다.
  const [loadedPulls, setLoadedPulls] = useState<Record<number, Pull[]>>({});
  // 멈춤 판정 시각. 저장소가 있으면 PR 목록을 읽은 서버 시각(그 뒤 PR 활동은 모르므로), 없으면 'live'(asOf).
  // ponytail: PR 목록은 화면을 열 때 한 번 읽으므로 멈춤 배지도 그때 기준. 실시간이 필요하면 웹훅.
  const [pullsClock, setPullsClock] = useState<string | null>(null);
  useEffect(() => {
    if (givenPulls || !projectId) return;
    let alive = true;
    apiFetch('/api/github-prs?project=' + encodeURIComponent(projectId))
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive || !body?.links) return;
        setLoadedPulls(body.links);
        setPullsClock(body.repo ? (body.asOf ?? null) : 'live');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, givenPulls]);
  const pulls = givenPulls ?? loadedPulls;
  const [selected, setSelected] = useState<number | null>(null);
  // 개발 현황(2026-11-14): GitHub 호출 한도 때문에 업무 상세를 열 때 그 업무의 최근 PR 3개만 읽는다.
  // CI는 바뀌므로 상세를 열 때마다 다시 읽는다.
  const [details, setDetails] = useState<Record<number, PullDetail>>({});
  const [detailError, setDetailError] = useState('');
  const wantedPulls = (selected !== null ? (pulls[selected] ?? []) : [])
    .slice(0, DETAIL_MAX_PULLS)
    .map((p) => p.number)
    .join(',');
  useEffect(() => {
    if (!wantedPulls || !projectId) return;
    let alive = true;
    apiFetch(
      `/api/github-prs?project=${encodeURIComponent(projectId)}&pulls=${wantedPulls}`,
    )
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!alive) return;
        if (r.ok && body?.details) {
          setDetailError('');
          setDetails((d) => ({ ...d, ...body.details }));
        } else setDetailError(body?.error ?? 'CI·커밋 정보를 불러오지 못했어요.');
      })
      .catch(() => alive && setDetailError('CI·커밋 정보를 불러오지 못했어요.'));
    return () => {
      alive = false;
    };
  }, [projectId, selected, wantedPulls]);
  const stallClock = givenPulls || !projectId || pullsClock === 'live' ? asOf : pullsClock;
  const stalledOf = (t: Task) =>
    sprint.finished || !stallClock ? null : stalledHours(t, pulls[t.id] ?? [], stallClock);
  const people = sprint.people ?? samplePeople;
  const tasks = sprint.tasks.filter((t) => !mine || t.person === me.person);
  const owner = me.role === 'owner';
  const writable = (t: Task) =>
    !busy &&
    !sprint.finished &&
    Boolean(me.agreedAt) &&
    (owner || t.person === me.person);
  const task = sprint.tasks.find((t) => t.id === selected);
  // 병목 = 마감 안에 배치되지 않은 미완료 업무. 홈의 '병목 n건'과 같은 기준(plan.unscheduled).
  const blocked = (t: Task) => !t.done && plan.unscheduled.includes(t.id);
  function statusControl(t: Task) {
    return (
      <NativeSelect
        aria-label={`${t.title} 상태`}
        className={`status-select status-${statusOf(t)}`}
        value={statusOf(t)}
        disabled={!writable(t)}
        onChange={(e) => {
          const status = e.target.value;
          if (status === 'done' || t.done) {
            setSelected(t.id);
            return;
          }
          void mutate(
            'taskDetails',
            {
              taskId: t.id,
              status,
              description: t.description ?? '',
              remaining: t.remaining,
            },
            '업무 상태를 저장했습니다.',
          );
        }}
      >
        {statuses.map((s) => (
          <NativeSelectOption key={s.id} value={s.id}>
            {s.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }
  return (
    <div className="task-collection">
      <Tabs value={view} onValueChange={(value) => setView(String(value))}>
        <div className="collection-toolbar">
          <TabsList variant="line" aria-label="업무 보기">
            <TabsTrigger value="table">
              <Table2 size={15} />표
            </TabsTrigger>
            <TabsTrigger value="board">
              <Columns3 size={15} />
              보드
            </TabsTrigger>
          </TabsList>
          <span className="collection-count">{tasks.length}개 업무</span>
          {owner && (
            <button
              className="btn primary"
              disabled={busy || sprint.finished || !me.agreedAt}
              onClick={onAdd}
            >
              <Plus size={16} />
              업무 추가
            </button>
          )}
        </div>
        {!tasks.length && (
          <div className="collection-empty">
            <FileText size={28} />
            <h2>
              {mine
                ? '아직 배정된 업무가 없습니다.'
                : '첫 업무부터 시작해보세요.'}
            </h2>
            <p>
              {mine
                ? '팀장이 업무를 배정하면 이곳에 표시됩니다.'
                : '작게 나눈 업무에 담당자와 남은 시간을 정해주세요.'}
            </p>
          </div>
        )}
        <TabsContent value="table">
          {!!tasks.length && (
            <Table className="task-table">
              <TableHeader>
                <TableRow>
                  <TableHead>업무 이름</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>담당자</TableHead>
                  <TableHead>남은 시간</TableHead>
                  <TableHead>승인된 마감 · KST</TableHead>
                  <TableHead>예상 완료 · KST</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow
                    key={t.id}
                    className={blocked(t) ? 'is-blocked' : undefined}
                  >
                    <TableCell>
                      <button
                        className="task-title-button"
                        onClick={() => setSelected(t.id)}
                      >
                        <FileText size={16} />
                        <span>{t.title}</span>
                        {blocked(t) && <span className="race-tag">병목</span>}
                        {stalledOf(t) !== null && (
                          <span className="race-tag is-stalled">
                            {`멈춤 ${stallText(stalledOf(t)!)}`}
                          </span>
                        )}
                      </button>
                      <span className="task-subline">
                        {taskRef(t.id)}
                        {pulls[t.id]?.length ? ` · PR ${pulls[t.id].length}개` : ''}
                        {t.dependsOn.length
                          ? ` · 선행 ${t.dependsOn.length}개`
                          : ''}
                        {!t.done &&
                        t.dueAt &&
                        Date.parse(t.dueAt) < Date.parse(asOf)
                          ? ' · 마감 지남'
                          : ''}
                      </span>
                    </TableCell>
                    <TableCell>{statusControl(t)}</TableCell>
                    <TableCell>
                      <NativeSelect
                        aria-label={`${t.title} 담당자`}
                        value={t.person}
                        disabled={!owner || !writable(t) || t.done}
                        onChange={(e) =>
                          void mutate(
                            'editTask',
                            {
                              ...t,
                              taskId: t.id,
                              person: Number(e.target.value),
                            },
                            '담당자를 변경하고 일정을 다시 계산했습니다.',
                          )
                        }
                      >
                        {!members.some((m) => m.person === t.person) && (
                          <NativeSelectOption value={t.person} disabled>
                            {people[t.person]?.name ?? '미배정'}
                          </NativeSelectOption>
                        )}
                        {members.map((m) => (
                          <NativeSelectOption key={m.person} value={m.person}>
                            {m.display_name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <button
                        className="hours-button"
                        aria-label={`${t.title} 남은 시간 편집`}
                        onClick={() => setSelected(t.id)}
                      >
                        {t.remaining}h
                      </button>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          !t.done &&
                          t.dueAt &&
                          Date.parse(t.dueAt) < Date.parse(asOf)
                            ? 'schedule-warning'
                            : ''
                        }
                      >
                        {t.dueAt ? seoulTime(t.dueAt) : '미정'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={blocked(t) ? 'schedule-warning' : ''}>
                        {t.done
                          ? '결과 확인 완료'
                          : plan.finishes[t.id]
                            ? seoulTime(plan.finishes[t.id]) +
                              ' KST' +
                              (blocked(t) ? ' · 마감 초과' : '')
                            : '배치 불가'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="board">
          <div className="task-board">
            {statuses.map((s) => (
              <section
                className={`board-column status-${s.id}`}
                key={s.id}
                aria-label={s.label}
              >
                <h2>
                  <span className={`status-dot status-${s.id}`} />
                  {s.label}
                  <span>
                    {tasks.filter((t) => statusOf(t) === s.id).length}
                  </span>
                </h2>
                {tasks
                  .filter((t) => statusOf(t) === s.id)
                  .map((t) => (
                    <article
                      className={
                        'board-card' + (blocked(t) ? ' is-blocked' : '')
                      }
                      key={t.id}
                    >
                      <button
                        className="task-title-button"
                        onClick={() => setSelected(t.id)}
                      >
                        {t.title}
                        {blocked(t) && <span className="race-tag">병목</span>}
                        {stalledOf(t) !== null && (
                          <span className="race-tag is-stalled">
                            {`멈춤 ${stallText(stalledOf(t)!)}`}
                          </span>
                        )}
                      </button>
                      <div className="board-card-meta">
                        <span className="board-avatar" aria-hidden="true">
                          {(people[t.person]?.name ?? '?').slice(0, 1)}
                        </span>
                        {people[t.person]?.name ?? '미배정'}
                        {!!t.dependsOn.length && (
                          <span className="board-card-dep">
                            <Link2 size={12} />
                            선행 {t.dependsOn.length}
                          </span>
                        )}
                        <span className="board-card-ref">{taskRef(t.id)}</span>
                      </div>
                      {!!pulls[t.id]?.length && (
                        <p className="board-card-pr">
                          <GitPullRequest size={12} />
                          {pulls[t.id].slice(0, 2).map((p) => (
                            <span key={p.number} className={`pr-state pr-${p.state}`}>
                              #{p.number} {PR_LABEL[p.state]}
                              {details[p.number] && (
                                <span
                                  className={`pr-check-dot pr-check-${details[p.number].checks}`}
                                  title={CHECK_LABEL[details[p.number].checks]}
                                  aria-label={CHECK_LABEL[details[p.number].checks]}
                                >
                                  <CheckIcon checks={details[p.number].checks} />
                                </span>
                              )}
                            </span>
                          ))}
                          {pulls[t.id].length > 2 && <span>+{pulls[t.id].length - 2}</span>}
                        </p>
                      )}
                      {!t.done && (
                        <p
                          className={
                            'board-card-due' +
                            (blocked(t) ||
                            (t.dueAt && Date.parse(t.dueAt) < Date.parse(asOf))
                              ? ' schedule-warning'
                              : '')
                          }
                        >
                          <CalendarClock size={13} />
                          {t.dueAt
                            ? `마감 ${seoulTime(t.dueAt).slice(5)}` +
                              (Date.parse(t.dueAt) < Date.parse(asOf)
                                ? ' · 지남'
                                : '')
                            : plan.finishes[t.id]
                              ? `예상 완료 ${seoulTime(plan.finishes[t.id]).slice(5)}`
                              : '마감 안에 배치 불가'}
                        </p>
                      )}
                      <div className="board-card-bottom">
                        {statusControl(t)}
                        <button
                          className="hours-button"
                          aria-label={`${t.title} 남은 시간 편집`}
                          onClick={() => setSelected(t.id)}
                        >
                          <Clock3 size={13} />
                          {t.remaining}h
                        </button>
                      </div>
                    </article>
                  ))}
                {!tasks.some((t) => statusOf(t) === s.id) && (
                  <p className="board-empty">업무 없음</p>
                )}
              </section>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      {task && (
        <TaskDetail
          key={task.id}
          task={task}
          sprint={sprint}
          plan={plan}
          asOf={asOf}
          me={me}
          checkins={checkins}
          busy={busy}
          error={error}
          mutate={mutate}
          pulls={pulls[task.id] ?? []}
          details={details}
          detailError={detailError}
          stalled={stalledOf(task)}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setSelected(null);
            onEdit(task);
          }}
        />
      )}
    </div>
  );
}
function TaskDetail({
  task,
  sprint,
  plan,
  asOf,
  me,
  checkins,
  busy,
  error,
  mutate,
  pulls,
  details,
  detailError,
  stalled,
  onClose,
  onEdit,
}: {
  task: Task;
  sprint: Sprint;
  plan: Plan;
  asOf: string;
  me: ProjectMeta['me'];
  checkins: Checkin[];
  busy: boolean;
  error: string;
  mutate: Mutate;
  pulls: Pull[];
  details: Record<number, PullDetail>;
  detailError: string;
  stalled: number | null;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [base] = useState({ task, revision: sprint.revision });
  // 머지된 PR을 근거로 쓰기로 하면 완료 근거 칸을 채운다. 저장은 사람이 누른다.
  const [evidence, setEvidence] = useState('');
  const t = base.task;
  const people = sprint.people ?? samplePeople;
  const canEdit =
    !sprint.finished &&
    Boolean(me.agreedAt) &&
    (me.role === 'owner' || task.person === me.person) &&
    true;
  const stale = base.revision !== sprint.revision;
  async function submit(
    e: React.SyntheticEvent<HTMLFormElement>,
    action: string,
  ) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fields: Record<string, unknown> = {
      taskId: t.id,
      revision: base.revision,
    };
    if (action === 'taskDetails')
      Object.assign(fields, {
        description: f.get('description'),
        status: f.get('status'),
        remaining: Number(f.get('remaining')),
      });
    if (action === 'checkin')
      Object.assign(fields, {
        note: f.get('note'),
        remaining: Number(f.get('remaining')),
      });
    if (action === 'task')
      Object.assign(fields, {
        done: !t.done,
        evidence: f.get('evidence'),
        remaining: Number(f.get('remaining')),
      });
    if (
      await mutate(action, fields, '업무를 저장하고 일정을 다시 계산했습니다.')
    )
      onClose();
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent className="task-detail-sheet">
        <SheetHeader>
          <p className="work-kicker">업무</p>
          <SheetTitle>{task.title}</SheetTitle>
          <SheetDescription>
            설명과 진행 상황, 결과물을 함께 확인합니다.
          </SheetDescription>
        </SheetHeader>
        <div className="task-detail-body">
          <dl className="task-properties">
            <div>
              <dt>담당자</dt>
              <dd>{people[task.person]?.name ?? '미배정'}</dd>
            </div>
            <div>
              <dt>상태</dt>
              <dd>{statuses.find((s) => s.id === statusOf(task))?.label}</dd>
            </div>
            <div>
              <dt>승인된 마감</dt>
              <dd>
                {task.dueAt
                  ? seoulTime(task.dueAt) +
                    ' KST' +
                    (!task.done && Date.parse(task.dueAt) < Date.parse(asOf)
                      ? ' · 마감 지남'
                      : '')
                  : '미정'}
              </dd>
            </div>
            <div>
              <dt>예상 완료</dt>
              <dd>
                {task.done
                  ? '결과 확인 완료'
                  : plan.finishes[task.id]
                    ? seoulTime(plan.finishes[task.id]) + ' KST (예상)'
                    : '남은 기간 안에 배치되지 않습니다.'}
              </dd>
            </div>
          </dl>
          {me.role === 'owner' && canEdit && !task.done && (
            <button className="btn" disabled={busy} onClick={onEdit}>
              업무명 · 담당자 · 선행 작업 편집
            </button>
          )}
          {stale && (
            <output className="detail-conflict">
              다른 변경이 저장됐습니다. 입력을 확인한 뒤 이 패널을 닫고 다시
              열어주세요.
            </output>
          )}
          {canEdit && !task.done ? (
            <form onSubmit={(e) => submit(e, 'taskDetails')}>
              <fieldset disabled={!canEdit || task.done || busy || stale}>
                <div className="detail-form-row">
                  <label htmlFor="detail-status">
                    상태
                    <NativeSelect
                      id="detail-status"
                      name="status"
                      defaultValue={t.status ?? 'todo'}
                    >
                      <NativeSelectOption value="todo">
                        시작 전
                      </NativeSelectOption>
                      <NativeSelectOption value="in_progress">
                        진행 중
                      </NativeSelectOption>
                    </NativeSelect>
                  </label>
                  <label>
                    남은 시간
                    <input
                      name="remaining"
                      type="number"
                      min="0"
                      max="200"
                      step="0.5"
                      defaultValue={t.remaining}
                      required
                    />
                  </label>
                </div>
                <label>
                  업무 설명
                  <textarea
                    name="description"
                    rows={6}
                    maxLength={10000}
                    defaultValue={t.description ?? ''}
                    placeholder="어떤 일을 하고, 무엇을 확인하면 끝나나요?"
                  />
                </label>
                {canEdit && !task.done && (
                  <button className="btn primary">상세 저장</button>
                )}
              </fieldset>
            </form>
          ) : (
            <section className="detail-section">
              <h3>업무 설명</h3>
              <p>{task.description || '아직 업무 설명이 없습니다.'}</p>
            </section>
          )}
          <PrPanel
            task={task}
            pulls={pulls}
            details={details}
            detailError={detailError}
            stalled={stalled}
            asOf={asOf}
            canEdit={canEdit && !busy}
            onStart={() =>
              void mutate(
                'taskDetails',
                {
                  taskId: task.id,
                  status: 'in_progress',
                  description: task.description ?? '',
                  remaining: task.remaining,
                },
                '열린 PR이 있어 진행 중으로 바꿨습니다.',
              ).then((ok) => ok && onClose())
            }
            onUseEvidence={(text) => setEvidence(text)}
          />
          <section className="detail-section">
            <h3>선행 작업</h3>
            {task.dependsOn.length ? (
              <ul>
                {task.dependsOn.map((id) => {
                  const dep = sprint.tasks.find((d) => d.id === id);
                  return (
                    <li key={id}>
                      {dep?.done ? '✓ ' : '○ '}
                      {dep?.title ?? `업무 ${id}`}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">선행 작업 없이 시작할 수 있습니다.</p>
            )}
          </section>
          <section className="detail-section">
            <h3>체크인</h3>
            {checkins
              .filter((c) => c.task_id === task.id)
              .map((c) => (
                <article className="detail-checkin" key={c.id}>
                  <p>{c.note}</p>
                  <small>
                    남은 {c.remaining}h ·{' '}
                    {new Date(c.created_at).toLocaleString('ko-KR', {
                      timeZone: 'Asia/Seoul',
                    })}
                  </small>
                </article>
              ))}
            {!checkins.some((c) => c.task_id === task.id) && (
              <p className="muted">최근 기록에 이 업무의 체크인이 없습니다.</p>
            )}
            <p className="detail-caption">
              프로젝트의 최근 체크인 20건에서 표시합니다.
            </p>
            {canEdit && !task.done && (
              <form onSubmit={(e) => submit(e, 'checkin')}>
                <fieldset disabled={busy || stale}>
                  <label>
                    진행 상황
                    <textarea
                      name="note"
                      required
                      maxLength={1000}
                      rows={3}
                      placeholder="완료한 일과 막힌 점"
                    />
                  </label>
                  <label>
                    체크인 후 남은 시간
                    <input
                      name="remaining"
                      type="number"
                      min="0"
                      max="200"
                      step="0.5"
                      required
                      defaultValue={t.remaining}
                    />
                  </label>
                  <button className="btn">체크인 저장</button>
                </fieldset>
              </form>
            )}
          </section>
          <section className="detail-section">
            <h3>완료 근거</h3>
            {task.evidence && <p className="task-evidence">{task.evidence}</p>}
            {canEdit ? (
              <form onSubmit={(e) => submit(e, 'task')}>
                <fieldset disabled={busy || stale}>
                  {task.done ? (
                    <label>
                      다시 진행할 남은 시간
                      <input
                        name="remaining"
                        type="number"
                        min="0.5"
                        max="200"
                        step="0.5"
                        defaultValue={1}
                        required
                      />
                    </label>
                  ) : (
                    <label>
                      결과물 링크 또는 검증 결과
                      <textarea
                        name="evidence"
                        required
                        minLength={5}
                        maxLength={2000}
                        rows={3}
                        value={evidence}
                        onChange={(e) => setEvidence(e.target.value)}
                      />
                    </label>
                  )}
                  <button className="btn primary">
                    {task.done ? '다시 진행' : '근거를 저장하고 완료'}
                  </button>
                </fieldset>
              </form>
            ) : (
              !task.evidence && (
                <p className="muted">아직 완료 근거가 없습니다.</p>
              )
            )}
          </section>
          {error && (
            <p role="alert" className="dialog-error">
              {error}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
