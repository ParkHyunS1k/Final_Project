'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, Sparkles } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { SourceList, SourcePaste, type SourceSummary } from './source-paste';
import type { ProjectMeta } from './project-workspace';
import { seoulTime, type Task } from '@/lib/sprint';
import { text } from '@/lib/utils';
import type {
  ReplayChange,
  ReplayListItem,
  ReplayReview,
} from '@/lib/change-review-replay';

type Evidence = { start: number; end: number; quote: string };
export type Change = {
  changeId: string;
  kind: string;
  taskId: number | null;
  newKey: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  evidence: Evidence | null;
  basis: 'fact' | 'estimate';
  needsReview: string;
  requires: 'owner' | 'assignee';
  blocked: string;
};
type Proposal = {
  id: string;
  sourceId: string;
  baseRevision: number;
  model: string;
  promptVersion: string;
  status: string;
  error: string;
  createdAt: string;
  changes: Change[];
};
type Application = {
  id: string;
  reverts: string | null;
  approvedBy: string;
  approvedAt: string;
  revision: number;
  entries: {
    changeId: string;
    kind: string;
    taskId: number;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    edited: boolean;
  }[];
};
type ReviewMode = 'project' | 'replay';

const KIND_LABEL: Record<string, string> = {
  createTask: '신규 업무',
  status: '진행 상태',
  remaining: '남은 공수',
  assignee: '담당자',
  dueAt: '승인된 마감',
  complete: '완료 보고',
};

function describe(value: unknown) {
  if (value === null || value === undefined || value === '') return '없음';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '없음';
  return text(value, '값 있음');
}

function personName(person: unknown, members: ProjectMeta['members']) {
  // 재생 응답의 담당자는 평가 입력의 GitHub 로그인이다. 현재 팀원으로 바꾸지 않는다.
  if (typeof person === 'string' && person) return `@${person}`;
  return typeof person === 'number'
    ? (members.find((m) => m.person === person)?.display_name ?? `팀원 ${person}`)
    : '미정';
}

async function call(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = (await res.json()) as Record<string, unknown> & {
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? '처리하지 못했습니다.');
  return data;
}

/**
 * 원문 붙여넣기 → 변경안 검토 → 선택·편집 승인 → 이력·되돌리기.
 * 서버가 권한·버전·마감을 다시 검사하므로 이 화면의 편집이 권한을 넓히지 않는다.
 * 재생 모드는 저장된 평가 응답을 같은 카드로 보여줄 뿐 승인·저장 요청을 보내지 않는다.
 */
export function ChangeReview({
  projectId,
  revision,
  tasks,
  members,
  me,
  writable,
  onApplied,
}: {
  projectId: string;
  revision: number;
  tasks: Task[];
  members: ProjectMeta['members'];
  me: ProjectMeta['me'];
  writable: boolean;
  onApplied: (state: unknown) => void;
}) {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [sourceBody, setSourceBody] = useState('');
  const [duplicates, setDuplicates] = useState<{ id: string }[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [stale, setStale] = useState(false);
  const [applications, setApplications] = useState<Application[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<ReviewMode>('project');
  const [replayCases, setReplayCases] = useState<ReplayListItem[]>([]);
  const [replayId, setReplayId] = useState('');
  const [replay, setReplay] = useState<ReplayReview | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState('');
  // 늦게 도착한 재생 응답이 더 최근 선택이나 모드 전환을 덮지 않게 한다.
  const replaySeq = useRef(0);

  const refresh = useCallback(async () => {
    const list = (await call(
      '/api/sources?project=' + encodeURIComponent(projectId),
    )) as { sources: SourceSummary[] };
    setSources(list.sources);
    const history = (await call(
      '/api/change-proposals?project=' + encodeURIComponent(projectId),
    )) as { applications: Application[]; replayCases?: ReplayListItem[] };
    setApplications(history.applications);
    setReplayCases(history.replayCases ?? []);
  }, [projectId]);

  useEffect(() => {
    // 렌더 중이 아니라 마이크로태스크 이후에만 상태를 갱신한다.
    void Promise.resolve()
      .then(refresh)
      .catch((e: unknown) => setError((e as Error).message));
  }, [refresh]);

  async function run(work: () => Promise<void>, message = '') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      if (message) setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openSource(id: string) {
    await run(async () => {
      const data = (await call(
        `/api/sources?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(id)}`,
      )) as { source: { body: string }; duplicates: { id: string }[] };
      setSourceId(id);
      setSourceBody(data.source.body);
      setDuplicates(data.duplicates);
      setProposal(null);
    });
  }

  async function createProposal() {
    setAnalyzing(true);
    try {
      await run(async () => {
        const data = (await call('/api/change-proposals', {
          action: 'create',
          projectId,
          sourceId,
        })) as { proposal: Proposal; error: string };
        setProposal(data.proposal);
        setStale(false);
        setSelected(
          Object.fromEntries(
            data.proposal.changes
              .filter((c) => !c.blocked)
              .map((c) => [c.changeId, false]),
          ),
        );
        setEdits({});
        if (data.error) setError(data.error);
      }, '변경안을 만들었습니다. 아직 아무것도 적용되지 않았습니다.');
    } finally {
      setAnalyzing(false);
    }
  }

  async function openReplay(id: string) {
    const seq = ++replaySeq.current;
    setReplayId(id);
    setReplay(null);
    setReplayError('');
    setReplayBusy(true);
    try {
      const data = await call(
        `/api/change-proposals?project=${encodeURIComponent(projectId)}&replay=${encodeURIComponent(id)}`,
      );
      if (seq === replaySeq.current) setReplay(data.replay as ReplayReview);
    } catch (e) {
      if (seq === replaySeq.current) setReplayError((e as Error).message);
    } finally {
      if (seq === replaySeq.current) setReplayBusy(false);
    }
  }

  function switchMode(next: ReviewMode) {
    // 프로젝트 모드의 원문·변경안·선택·편집 상태는 그대로 둔다.
    if (next === 'project') {
      replaySeq.current += 1;
      setReplayBusy(false);
    } else if (replayId && !replay) void openReplay(replayId);
    setMode(next);
  }

  async function apply() {
    const selections = Object.entries(selected)
      .filter(([, on]) => on)
      .map(([changeId]) => ({ changeId, edited: edits[changeId] ?? {} }));
    if (!selections.length) {
      setError('적용할 항목을 선택해주세요.');
      return;
    }
    await run(async () => {
      const data = await call('/api/change-proposals', {
        action: 'apply',
        projectId,
        revision,
        proposalId: proposal!.id,
        // 같은 승인의 재전송이 중복 적용되지 않도록 요청 식별자를 붙인다.
        mutationId: 'apply-' + crypto.randomUUID(),
        selections,
      });
      onApplied(data.state);
      setProposal(null);
      await refresh();
    }, '선택한 변경만 적용하고 이력을 저장했습니다.');
  }

  async function revert(applicationId: string) {
    await run(async () => {
      const data = await call('/api/change-proposals', {
        action: 'revert',
        projectId,
        revision,
        applicationId,
        mutationId: 'revert-' + crypto.randomUUID(),
      });
      onApplied(data.state);
      await refresh();
    }, '되돌리기를 새 변경으로 저장했습니다. 원래 기록은 남습니다.');
  }

  function setEdit(changeId: string, field: string, value: unknown) {
    setEdits((prev) => ({
      ...prev,
      [changeId]: { ...prev[changeId], [field]: value },
    }));
  }

  function currentAfter(change: Change) {
    return { ...change.after, ...edits[change.changeId] };
  }

  /** 프로젝트 변경안과 재생 변경안이 같은 카드를 쓴다. 재생은 선택·편집·승인만 막는다. */
  function changeCard(c: Change | ReplayChange) {
    const replayItem = 'evidenceItems' in c;
    const after = replayItem ? c.after : currentAfter(c);
    const field = Object.keys(c.before)[0];
    const title = replayItem
      ? c.taskTitle
      : c.kind === 'createTask'
        ? text(after.title)
        : (tasks.find((t) => t.id === c.taskId)?.title ?? `업무 ${c.taskId}`);
    const beforeText =
      replayItem && field && c.unknownBefore.includes(field)
        ? '평가 입력에 없음'
        : c.kind === 'assignee'
          ? personName(c.before.person, members)
          : describe(Object.values(c.before)[0]);
    const afterText =
      c.kind === 'createTask'
        ? `${text(after.title)} · 담당자 ${personName(after.person, members)} · 공수 ${
            typeof after.remaining === 'number' ? `${after.remaining}시간` : '미정'
          }`
        : c.kind === 'assignee'
          ? personName(after.person, members)
          : c.kind === 'dueAt'
            ? after.dueAt
              ? replayItem
                ? text(after.dueAt)
                : seoulTime(text(after.dueAt)) + ' KST'
              : '없음'
            : describe(after[field] ?? Object.values(after)[0]);
    return (
      <div className="task-row change-row" key={c.changeId}>
        <label className="agree" htmlFor={`sel-${c.changeId}`}>
          <Checkbox
            id={`sel-${c.changeId}`}
            checked={!replayItem && !!selected[c.changeId]}
            disabled={replayItem || !!c.blocked || !writable}
            onCheckedChange={(v) =>
              setSelected((prev) => ({
                ...prev,
                [c.changeId]: Boolean(v),
              }))
            }
          />
        </label>
        <div>
          <b>
            {KIND_LABEL[c.kind] ?? c.kind} · {title}
          </b>
          <span>
            <span className={`pill ${c.basis === 'fact' ? 'green' : 'orange'}`}>
              {c.basis === 'fact' ? '원문 사실' : 'AI 추정'}
            </span>{' '}
            {c.requires === 'owner' ? '팀장 승인 필요' : '담당자 승인'}
            {!replayItem && edits[c.changeId] ? ' · 사용자 수정함' : ''}
          </span>
          <p className="tiny">
            변경 전 {c.kind === 'createTask' ? '없음' : beforeText} → 변경 후 {afterText}
          </p>
          {replayItem ? (
            c.evidenceItems.length ? (
              c.evidenceItems.map((e) => (
                <blockquote className="evidence" key={e.excerptIndex}>
                  “{e.quote}”
                  <span className="tiny muted">
                    {' '}
                    발췌 {e.excerptIndex} · 원문 {e.start}~{e.end}자 ·{' '}
                    <a href={e.sourceUrl} target="_blank" rel="noreferrer">
                      원본 보기
                    </a>
                  </span>
                </blockquote>
              ))
            ) : (
              <p className="tiny muted">원문 근거 없음 (AI 추정)</p>
            )
          ) : c.evidence ? (
            <blockquote className="evidence">
              “{c.evidence.quote}”
              <span className="tiny muted">
                {' '}
                원문 {c.evidence.start}~{c.evidence.end}자
              </span>
            </blockquote>
          ) : (
            <p className="tiny muted">원문 근거 없음 (AI 추정)</p>
          )}
          {c.needsReview && (
            <p className="tiny schedule-warning">
              <Clock3 size={13} /> 확인 필요: {c.needsReview}
            </p>
          )}
          {c.blocked && <p className="tiny schedule-warning">{c.blocked}</p>}
          {/* 승인 전에 사용자가 값을 채우거나 고친다. 재생에는 편집 칸이 없다. */}
          {!replayItem && (c.kind === 'createTask' || c.kind === 'assignee') && (
            <label className="input-label">
              담당자
              <NativeSelect
                value={typeof after.person === 'number' ? after.person : ''}
                onChange={(e) =>
                  setEdit(
                    c.changeId,
                    'person',
                    e.target.value === '' ? null : Number(e.target.value),
                  )
                }
              >
                <NativeSelectOption value="">미정</NativeSelectOption>
                {members
                  .filter((m) => !m.left_at)
                  .map((m) => (
                    <NativeSelectOption key={m.person} value={m.person}>
                      {m.display_name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </label>
          )}
          {!replayItem && (c.kind === 'createTask' || c.kind === 'remaining') && (
            <label className="input-label">
              남은 공수
              <input
                type="number"
                min="0.5"
                max="200"
                step="0.5"
                value={typeof after.remaining === 'number' ? after.remaining : ''}
                onChange={(e) =>
                  setEdit(
                    c.changeId,
                    'remaining',
                    e.target.value === '' ? null : Number(e.target.value),
                  )
                }
              />
            </label>
          )}
          {!replayItem && c.kind === 'complete' && (
            <label className="input-label">
              완료 근거
              <textarea
                rows={2}
                maxLength={2000}
                value={text(after.evidence)}
                onChange={(e) => setEdit(c.changeId, 'evidence', e.target.value)}
              />
            </label>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="work-section">
      <div className="section-heading">
        <h2>
          <Sparkles size={19} /> 붙여넣기와 AI 변경안
        </h2>
        <NativeSelect
          aria-label="보기 모드"
          value={mode}
          onChange={(e) => switchMode(e.target.value as ReviewMode)}
        >
          <NativeSelectOption value="project">프로젝트 원문 분석</NativeSelectOption>
          <NativeSelectOption value="replay">저장된 실제 AI 응답 재생</NativeSelectOption>
        </NativeSelect>
      </div>

      {mode === 'replay' ? (
        <section className="replay-panel">
          <p className="replay-banner" role="note">
            저장된 평가 응답 재생 · 우리 프로젝트에 반영되지 않음
          </p>
          <label className="input-label">
            재생할 사례
            <NativeSelect
              value={replayId}
              onChange={(e) => {
                if (e.target.value) void openReplay(e.target.value);
              }}
            >
              <NativeSelectOption value="">사례를 고르세요</NativeSelectOption>
              {replayCases.map((c) => (
                <NativeSelectOption key={c.caseId} value={c.caseId}>
                  {c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {replayBusy && (
            <output className="tiny muted" aria-live="polite">
              AI 응답을 불러오는 중입니다.
            </output>
          )}
          {replayError && (
            <div className="error-notice" role="alert">
              {replayError}{' '}
              <button className="text-link" onClick={() => void openReplay(replayId)}>
                다시 시도
              </button>
            </div>
          )}
          {replay && (
            <>
              <div className="section-heading">
                <h2>검토할 변경안</h2>
                <span className="tiny muted">
                  모델 {replay.model} · effort {replay.reasoningEffort} ·{' '}
                  {replay.caseId} ·{' '}
                  <a href={replay.source.url} target="_blank" rel="noreferrer">
                    원본 스레드
                  </a>
                </span>
              </div>
              {replay.status === 'failed' ? (
                <div className="error-notice" role="alert">
                  분석 결과를 불러오지 못했습니다. {replay.proposal.error}{' '}
                  <button
                    className="text-link"
                    onClick={() => void openReplay(replay.caseId)}
                  >
                    다시 시도
                  </button>
                </div>
              ) : (
                <>
                  <p>
                    <b>해석</b> {replay.summary}
                  </p>
                  {replay.decision === 'no_change' && (
                    <p className="empty-copy">변경할 업무가 없습니다.</p>
                  )}
                  {replay.decision === 'needs_clarification' && (
                    <p className="schedule-warning">
                      <Clock3 size={13} /> 확인 필요: {replay.clarification}
                    </p>
                  )}
                  {replay.decision === 'propose_changes' && (
                    <div className="task-list">
                      {replay.proposal.changes.map(changeCard)}
                    </div>
                  )}
                </>
              )}
              <div className="section-heading">
                <h2>원문</h2>
                <span className="tiny muted">{replay.source.title}</span>
              </div>
              <pre className="source-body">{replay.source.body}</pre>
            </>
          )}
        </section>
      ) : (
        <>
          <div className="content-grid">
            <section>
              <SourcePaste
                busy={busy}
                disabled={!writable}
                supersedes={sourceId || null}
                onSubmit={async (input) => {
                  let ok = false;
                  await run(async () => {
                    const data = (await call('/api/sources', {
                      projectId,
                      ...input,
                      supersedes: input.supersedes,
                    })) as { sourceId: string };
                    await refresh();
                    await openSource(data.sourceId);
                    ok = true;
                  }, '원문을 저장했습니다.');
                  return ok;
                }}
              />
              {sourceId && (
                <>
                  <div className="section-heading">
                    <h2>저장된 원문</h2>
                    <span className="tiny muted">그대로 보존됩니다</span>
                  </div>
                  <pre className="source-body">{sourceBody}</pre>
                  {duplicates.length > 0 && (
                    <p className="tiny muted">
                      같은 내용의 이전 원문이 {duplicates.length}건 있습니다. 같은
                      자료인지는 직접 확인해주세요.
                    </p>
                  )}
                  <button
                    className="btn primary"
                    disabled={busy || !writable}
                    onClick={createProposal}
                  >
                    {analyzing ? '분석 중…' : '이 원문으로 변경안 만들기'}
                  </button>
                </>
              )}
            </section>
            <aside>
              <div className="section-heading">
                <h2>원문 목록</h2>
              </div>
              <SourceList
                sources={sources}
                selected={sourceId}
                onSelect={(id) => void openSource(id)}
              />
            </aside>
          </div>

          {proposal && (
            <>
              <div className="section-heading">
                <h2>검토할 변경안</h2>
                <span className="tiny muted">
                  모델 {proposal.model} · {proposal.promptVersion} ·{' '}
                  {stale ? '기준 버전이 바뀜' : `버전 ${proposal.baseRevision} 기준`}
                </span>
              </div>
              {proposal.status === 'failed' && (
                <div className="empty-copy">
                  변경안을 만들지 못했습니다: {proposal.error}. 업무 기록은 바뀌지
                  않았습니다.{' '}
                  <button
                    className="text-link"
                    disabled={busy || !writable}
                    onClick={createProposal}
                  >
                    다시 분석
                  </button>
                </div>
              )}
              {!proposal.changes.length && proposal.status !== 'failed' && (
                <p className="empty-copy">
                  적용할 수 있는 변경 후보를 찾지 못했습니다.
                </p>
              )}
              <div className="task-list">{proposal.changes.map(changeCard)}</div>
              {!!proposal.changes.length && (
                <button
                  className="btn primary"
                  disabled={busy || !writable}
                  onClick={apply}
                >
                  선택한 항목만 승인
                </button>
              )}
            </>
          )}
        </>
      )}

      <div className="section-heading">
        <h2>적용 이력</h2>
        <span className="tiny muted">되돌리기도 새 변경으로 남습니다</span>
      </div>
      <div className="task-list">
        {applications.length ? (
          applications.map((a) => (
            <div className="task-row" key={a.id}>
              <Check size={18} />
              <div>
                <b>
                  {a.reverts ? '되돌리기' : 'AI 변경안 승인'} · {a.entries.length}건
                </b>
                <span>
                  {new Date(a.approvedAt).toLocaleString('ko-KR', {
                    timeZone: 'Asia/Seoul',
                  })}{' '}
                  · 버전 {a.revision} ·{' '}
                  {members.find((m) => m.display_name === a.approvedBy)
                    ?.display_name ?? a.approvedBy}
                </span>
                <p className="tiny">
                  {a.entries
                    .map(
                      (e) =>
                        `${KIND_LABEL[e.kind] ?? e.kind}${e.edited ? '(수정)' : ''}`,
                    )
                    .join(', ')}
                </p>
                {!a.reverts &&
                  writable &&
                  !applications.some((x) => x.reverts === a.id) && (
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() => void revert(a.id)}
                    >
                      이 승인 되돌리기
                    </button>
                  )}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-copy">아직 적용한 AI 변경이 없습니다.</p>
        )}
      </div>
      {error && (
        <div className="error-notice" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <output className="notice">
          <Check size={16} />
          {notice}
        </output>
      )}
      <p className="tiny muted">
        사용자가 선택·편집·승인한 내용만 반영됩니다. AI 제안을 따르지 않아도 처음
        약속한 결과물을 완성하면 완주할 수 있습니다. 제안 거절이나 무응답은 완주
        판정이나 추가 독촉의 이유가 되지 않습니다.
        {me.role === 'owner'
          ? ' 신규 업무·담당 변경·마감 변경은 팀장인 회원님이 승인합니다.'
          : ' 본인 업무의 상태·남은 공수·완료 보고만 승인할 수 있습니다.'}
      </p>
    </section>
  );
}
