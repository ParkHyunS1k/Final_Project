// 저장된 실제 AI 평가 응답을 기존 변경안 검토 화면 형식으로 바꾼다.
// 재생은 읽기 전용이다. DB를 읽거나 쓰지 않고, 평가의 문자열 task_id·GitHub 로그인을
// 현재 프로젝트의 숫자 ID로 바꾸지 않는다.
import fixture from '@/fixtures/change-review-replays.json';
import { OWNER_KINDS, type Kind } from '@/lib/ai-extraction';
import { seoulTime } from '@/lib/sprint';

export type ReplayDecision = 'propose_changes' | 'no_change' | 'needs_clarification';

type EvalChange = {
  kind: string;
  task_id: string | null;
  status: string | null;
  person: string | null;
  remaining_hours: number | null;
  due_at: string | null;
  title: string | null;
  basis: 'fact' | 'estimate';
  evidence_excerpt_indices: number[];
};

export type EvalResponse = {
  id: string;
  summary_ko: string;
  decision: ReplayDecision;
  clarification_reason_ko: string | null;
  changes: EvalChange[];
};

export type ReplayFixture = {
  caseId: string;
  variant: string;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  thread: { title: string; url: string };
  excerpts: { index: number; text: string; authorLogin: string; createdAt: string; sourceUrl: string }[];
  tasks: { task_id: string; title: string; state: string; closed_reason: string | null; assignees: string[] }[];
  members: string[];
  response: EvalResponse;
  provenance: { resultPath: string; resultSha256: string; candidatePath: string; candidateLineSha256: string };
};

export type ReplayEvidence = {
  excerptIndex: number;
  start: number;
  end: number;
  quote: string;
  sourceUrl: string;
};

export type ReplayChange = {
  changeId: string;
  kind: string;
  taskId: string | null;
  taskTitle: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  unknownBefore: string[];
  evidenceItems: ReplayEvidence[];
  basis: 'fact' | 'estimate';
  needsReview: string;
  requires: 'owner' | 'assignee';
  blocked: string;
};

export type ReplayReview = {
  origin: 'replay';
  readOnly: true;
  caseId: string;
  model: string;
  variant: string;
  reasoningEffort: string;
  status: 'ready' | 'failed';
  decision: ReplayDecision;
  summary: string;
  clarification: string | null;
  source: { title: string; url: string; body: string };
  proposal: {
    id: string;
    model: string;
    promptVersion: 'evaluation-2026-09-11';
    status: 'pending' | 'failed';
    error: string;
    changes: ReplayChange[];
  };
};

export type ReplayListItem = {
  caseId: string;
  label: string;
  decision: ReplayDecision;
  model: string;
  variant: string;
};

const BLOCKED = '저장된 평가 응답 재생은 적용할 수 없습니다.';
const DECISION_LABEL: Record<ReplayDecision, string> = {
  propose_changes: '변경 제안',
  no_change: '변경 없음',
  needs_clarification: '확인 필요',
};
const cases = (fixture as unknown as { cases: ReplayFixture[] }).cases;

/** 발췌를 머리말과 함께 한 원문으로 합친다. 근거 위치는 머리말이 아니라 발췌 본문을 가리킨다. */
function sourceBody(c: ReplayFixture) {
  let body = '';
  const ranges = new Map<number, { start: number; end: number }>();
  for (const e of c.excerpts) {
    if (body) body += '\n\n';
    body += `[발췌 ${e.index}] ${e.authorLogin} · ${seoulTime(e.createdAt)} KST\n`;
    ranges.set(e.index, { start: body.length, end: body.length + e.text.length });
    body += e.text;
  }
  return { body, ranges };
}

function beforeAfter(change: EvalChange, task: ReplayFixture['tasks'][number] | undefined) {
  switch (change.kind) {
    case 'createTask':
      return {
        before: {},
        after: { title: change.title, person: change.person, remaining: change.remaining_hours, dependsOn: [] },
        unknownBefore: [],
      };
    case 'status':
      return { before: { status: task?.state ?? null }, after: { status: change.status }, unknownBefore: [] };
    case 'assignee':
      return { before: { person: task?.assignees[0] ?? null }, after: { person: change.person }, unknownBefore: [] };
    // 평가 입력에는 이전 공수·마감이 없다. 없음으로 단정하지 않고 모른다고 표시한다.
    case 'remaining':
      return { before: { remaining: null }, after: { remaining: change.remaining_hours }, unknownBefore: ['remaining'] };
    case 'dueAt':
      return { before: { dueAt: null }, after: { dueAt: change.due_at }, unknownBefore: ['dueAt'] };
    default:
      // 평가 스키마에서 남은 종류는 complete뿐이다.
      return { before: { done: task?.state === 'closed' }, after: { done: true }, unknownBefore: [] };
  }
}

export function replayReview(c: ReplayFixture): ReplayReview {
  const { body, ranges } = sourceBody(c);
  const errors: string[] = [];
  const changes = c.response.changes.map((change, k): ReplayChange => {
    const task = c.tasks.find((t) => t.task_id === change.task_id);
    const evidenceItems: ReplayEvidence[] = [];
    for (const index of change.evidence_excerpt_indices) {
      const excerpt = c.excerpts.find((e) => e.index === index);
      const range = ranges.get(index);
      // 근거를 조용히 버리지 않는다. 입력에 없는 발췌를 가리키면 재생 전체를 실패로 둔다.
      if (!excerpt || !range) {
        errors.push(`근거 발췌 ${index}번이 입력에 없습니다.`);
        continue;
      }
      evidenceItems.push({ excerptIndex: index, ...range, quote: excerpt.text, sourceUrl: excerpt.sourceUrl });
    }
    return {
      changeId: `${c.caseId}-${k}`,
      kind: change.kind,
      taskId: change.task_id,
      taskTitle: change.kind === 'createTask' ? (change.title ?? '') : (task?.title ?? change.task_id ?? ''),
      ...beforeAfter(change, task),
      evidenceItems,
      basis: change.basis,
      needsReview:
        (change.kind === 'createTask' || change.kind === 'assignee') && change.person === null ? '담당자 미정' : '',
      requires: OWNER_KINDS.includes(change.kind as Kind) ? 'owner' : 'assignee',
      blocked: BLOCKED,
    };
  });
  const failed = errors.length > 0;
  return {
    origin: 'replay',
    readOnly: true,
    caseId: c.caseId,
    model: c.model,
    variant: c.variant,
    reasoningEffort: c.reasoningEffort,
    status: failed ? 'failed' : 'ready',
    decision: c.response.decision,
    summary: c.response.summary_ko,
    clarification: c.response.clarification_reason_ko,
    source: { title: c.thread.title, url: c.thread.url, body },
    proposal: {
      id: `replay-${c.caseId}`,
      model: c.model,
      promptVersion: 'evaluation-2026-09-11',
      status: failed ? 'failed' : 'pending',
      error: errors.join(' '),
      changes,
    },
  };
}

export function replayCases(): ReplayListItem[] {
  return cases.map((c) => {
    const unassigned = c.response.changes.some(
      (ch) => (ch.kind === 'createTask' || ch.kind === 'assignee') && ch.person === null,
    );
    return {
      caseId: c.caseId,
      label: `${DECISION_LABEL[c.response.decision]}${unassigned ? '·담당자 미정' : ''} — ${c.thread.title}`,
      decision: c.response.decision,
      model: c.model,
      variant: c.variant,
    };
  });
}

export function readReplay(caseId: string): ReplayReview | null {
  const c = cases.find((x) => x.caseId === caseId);
  return c ? replayReview(c) : null;
}
