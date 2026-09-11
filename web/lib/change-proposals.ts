// 변경안 저장, 사용자 편집·선택 반영, 권한·충돌 검사, 역변경 계산.
// 모델 출력이 아니라 사용자가 승인한 항목만 이 경계를 지나 저장된다.
import { database } from './sprint-store';
import { PolicyError } from './sprint-policy';
import { validateHours, type Task } from './sprint';
import { OWNER_KINDS, type Kind, type ValidChange } from './ai-extraction';
import { text } from './utils';

export type StoredChange = ValidChange;

export function changeRow(row: Record<string, unknown>): StoredChange {
  return {
    changeId: String(row.change_id),
    kind: String(row.kind) as Kind,
    taskId: row.task_id === null ? null : Number(row.task_id),
    newKey: (row.new_key as string | null) ?? null,
    before: JSON.parse(String(row.before)),
    after: JSON.parse(String(row.after)),
    evidence:
      row.evidence_start === null
        ? null
        : {
            start: Number(row.evidence_start),
            end: Number(row.evidence_end),
            quote: String(row.evidence_quote),
          },
    basis: row.basis === 'fact' ? 'fact' : 'estimate',
    needsReview: text(row.needs_review),
    requires: row.requires === 'owner' ? 'owner' : 'assignee',
    blocked: text(row.blocked),
  };
}

export async function readProposal(projectId: string, proposalId: string) {
  const db = database();
  const head = await db
    .prepare('SELECT * FROM ai_change_proposals WHERE id=? AND project_id=?')
    .bind(proposalId, projectId)
    .first<Record<string, unknown>>();
  if (!head) return null;
  const rows = await db
    .prepare('SELECT * FROM ai_proposal_changes WHERE proposal_id=?')
    .bind(proposalId)
    .all<Record<string, unknown>>();
  return {
    id: String(head.id),
    projectId: String(head.project_id),
    sourceId: String(head.source_id),
    baseRevision: Number(head.base_revision),
    model: String(head.model),
    promptVersion: String(head.prompt_version),
    status: String(head.status),
    error: text(head.error),
    createdBy: String(head.created_by),
    createdAt: String(head.created_at),
    changes: rows.results.map(changeRow),
  };
}

export async function listProposals(projectId: string, limit = 10) {
  const rows = await database()
    .prepare(
      'SELECT id,source_id,base_revision,model,prompt_version,status,error,created_by,created_at FROM ai_change_proposals WHERE project_id=? ORDER BY created_at DESC LIMIT ?',
    )
    .bind(projectId, limit)
    .all<Record<string, unknown>>();
  return rows.results;
}

/**
 * 같은 원문에서 이미 만든 신규 업무를 식별하는 키.
 * 제목만 비교하지 않고 원문과 근거 위치를 함께 쓴다.
 */
export function candidateKey(
  sourceId: string,
  change: { evidence?: { start: number; end: number } | null; after: Record<string, unknown> },
) {
  const e = change.evidence;
  return e
    ? `${sourceId}#${e.start}-${e.end}`
    : `${sourceId}#title:${text(change.after.title)}`;
}

/** 되돌리지 않은 적용 기록에서 이미 만든 생성 후보 키를 모은다. */
export async function appliedCandidateKeys(projectId: string, sourceId: string) {
  const rows = await database()
    .prepare(
      'SELECT id,entries FROM ai_change_applications WHERE project_id=? AND source_id=? AND reverts IS NULL' +
        ' AND NOT EXISTS(SELECT 1 FROM ai_change_applications r WHERE r.project_id=ai_change_applications.project_id AND r.reverts=ai_change_applications.id)',
    )
    .bind(projectId, sourceId)
    .all<{ id: string; entries: string }>();
  const keys = new Set<string>();
  for (const r of rows.results)
    for (const e of JSON.parse(r.entries) as AppliedEntry[])
      if (e.kind === 'createTask' && typeof e.candidateKey === 'string')
        keys.add(e.candidateKey);
  return keys;
}

export type AppliedEntry = {
  changeId: string;
  kind: Kind;
  taskId: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  edited: boolean;
  // createTask에만 있다. 같은 원문의 재처리에서 중복 생성을 막는 식별자.
  candidateKey?: string;
};

export type Selection = {
  changeId: string;
  edited?: Record<string, unknown>;
};

function editable(kind: Kind) {
  return kind === 'createTask'
    ? ['title', 'person', 'remaining', 'dependsOn']
    : kind === 'status'
      ? ['status']
      : kind === 'remaining'
        ? ['remaining']
        : kind === 'assignee'
          ? ['person']
          : kind === 'dueAt'
            ? ['dueAt']
            : ['evidence'];
}

/** 사용자의 편집을 반영한다. 편집으로 변경 종류나 대상 업무를 바꿀 수는 없다. */
function applyEdits(change: StoredChange, edited: Record<string, unknown>) {
  const after = { ...change.after };
  let touched = false;
  for (const field of editable(change.kind)) {
    if (!(field in edited)) continue;
    after[field] = edited[field];
    touched = true;
  }
  return { after, edited: touched };
}

export type Context = {
  tasks: Task[];
  members: { person: number; userId: string; leftAt: string | null }[];
  actor: { userId: string; role: string; person: number };
  deadline: string | null;
  now: Date;
};

export type Prepared = {
  entries: AppliedEntry[];
  creations: {
    changeId: string;
    newKey: string;
    title: string;
    person: number;
    remaining: number;
    dependsOn: number[];
    taskId: number;
  }[];
};

/**
 * 선택·편집한 항목만 실제 적용 값으로 바꾼다. 권한, 현재 값 일치, 필수 항목 누락,
 * 함께 적용해야 하는 항목을 모두 검사하고 하나라도 실패하면 전체를 거절한다.
 */
export function prepareApplication(
  proposal: { changes: StoredChange[]; sourceId: string },
  selections: Selection[],
  ctx: Context,
  appliedKeys: Set<string> = new Set(),
): Prepared {
  if (!Array.isArray(selections) || !selections.length)
    throw new PolicyError('적용할 항목을 선택해주세요.');
  const chosen = selections.map((s) => {
    const change = proposal.changes.find((c) => c.changeId === s.changeId);
    if (!change)
      throw new PolicyError(`변경안에 없는 항목입니다: ${String(s.changeId)}`);
    return { change, edited: s.edited ?? {} };
  });
  if (new Set(chosen.map((c) => c.change.changeId)).size !== chosen.length)
    throw new PolicyError('같은 항목을 두 번 선택했습니다.');
  const isOwner = ctx.actor.role === 'owner';
  const entries: AppliedEntry[] = [];
  const creations: Prepared['creations'] = [];
  let nextId = Math.max(0, ...ctx.tasks.map((t) => t.id));
  const newKeys = new Map<string, number>();
  // 신규 업무를 먼저 배치해 다른 항목이 참조할 수 있게 한다.
  for (const { change } of chosen)
    if (change.kind === 'createTask') newKeys.set(change.newKey!, ++nextId);
  for (const { change, edited } of chosen) {
    if (change.blocked)
      throw new PolicyError(`${change.blocked} 항목을 제외하고 다시 승인해주세요.`);
    const { after, edited: wasEdited } = applyEdits(change, edited);
    // 자유로운 편집이 승인 권한 상승으로 이어지지 않는다.
    if (OWNER_KINDS.includes(change.kind) && !isOwner)
      throw new PolicyError(
        '신규 업무·담당 변경·마감 변경은 팀장 승인이 필요합니다.',
        403,
      );
    if (change.kind === 'createTask') {
      const title = text(after.title).trim();
      if (!title || title.length > 200)
        throw new PolicyError('신규 업무 이름을 1~200자로 입력해주세요.');
      const person = after.person;
      // 공식 업무 생성에 필수인 값은 사용자가 승인 전에 채운다.
      if (typeof person !== 'number' || !ctx.members.some((m) => m.person === person && !m.leftAt))
        throw new PolicyError(
          `"${title}" 담당자를 정한 뒤 승인해주세요. AI는 근거 없이 배정하지 않습니다.`,
        );
      const remaining = validateHours(after.remaining);
      if (!remaining)
        throw new PolicyError(`"${title}"의 남은 공수를 입력해주세요.`);
      const dependsOn = Array.isArray(after.dependsOn)
        ? (after.dependsOn as unknown[]).map((d) =>
            typeof d === 'string' && newKeys.has(d) ? newKeys.get(d)! : d,
          )
        : [];
      for (const d of dependsOn) {
        // 아직 문자열이면 같은 변경안의 신규 업무를 가리키는데 그 항목이 빠진 것이다.
        if (typeof d === 'string')
          throw new PolicyError(
            `"${title}"이(가) 참조하는 선행 업무가 이 승인에 포함되지 않았습니다. 함께 선택하거나 선행 작업에서 빼주세요.`,
          );
        if (typeof d !== 'number')
          throw new PolicyError('선행 작업 값이 올바르지 않습니다.');
        const known =
          ctx.tasks.some((t) => t.id === d) ||
          [...newKeys.values()].includes(d);
        // 함께 적용해야 하는 항목이 제외되면 이유를 보여주고 거절한다.
        if (!known)
          throw new PolicyError(
            `"${title}"이(가) 참조하는 선행 업무가 이 승인에 포함되지 않았습니다.`,
          );
      }
      const key = candidateKey(proposal.sourceId, change);
      // 승인 단계에서도 이미 적용한 생성 항목인지 다시 확인한다.
      if (appliedKeys.has(key))
        throw new PolicyError(
          `"${title}"은(는) 이 원문에서 이미 적용한 신규 업무입니다. 항목을 제외하고 다시 승인해주세요.`,
        );
      const taskId = newKeys.get(change.newKey!)!;
      creations.push({
        changeId: change.changeId,
        newKey: change.newKey!,
        title,
        person,
        remaining,
        dependsOn: dependsOn as number[],
        taskId,
      });
      entries.push({
        changeId: change.changeId,
        kind: change.kind,
        taskId,
        before: {},
        after: { title, person, remaining, dependsOn, changeVersion: 0 },
        edited: wasEdited,
        candidateKey: key,
      });
      continue;
    }
    const task = ctx.tasks.find((t) => t.id === change.taskId);
    if (!task) throw new PolicyError('대상 업무를 찾을 수 없습니다.');
    if (!isOwner && task.person !== ctx.actor.person)
      throw new PolicyError('본인의 업무만 승인할 수 있습니다.', 403);
    // 오래된 변경안은 최신 차이로 다시 검토하게 한다. 스냅샷을 덮어쓰지 않는다.
    for (const [field, value] of Object.entries(change.before)) {
      const current = (task as unknown as Record<string, unknown>)[field] ?? null;
      if ((current ?? null) !== (value ?? null))
        throw new PolicyError(
          `"${task.title}"의 ${field} 값이 그사이 바뀌었습니다. 최신 상태로 다시 검토해주세요.`,
          409,
        );
    }
    if (change.kind === 'remaining') after.remaining = validateHours(after.remaining);
    if (change.kind === 'dueAt' && typeof after.dueAt === 'string') {
      const at = Date.parse(after.dueAt);
      if (!Number.isFinite(at))
        throw new PolicyError('마감 값이 올바르지 않습니다.');
      if (!ctx.deadline)
        throw new PolicyError('시작 전에는 업무 마감을 지정할 수 없습니다.');
      if (at > Date.parse(ctx.deadline))
        throw new PolicyError('업무 마감은 프로젝트 최종 기한을 넘을 수 없습니다.');
      after.dueAt = new Date(at).toISOString();
    }
    if (change.kind === 'complete') {
      const evidence = text(after.evidence).trim();
      if (evidence.length < 5)
        throw new PolicyError(
          `"${task.title}"의 완료 근거를 5자 이상 입력한 뒤 승인해주세요.`,
        );
      after.evidence = evidence;
      after.done = true;
      after.remaining = 0;
    }
    if (change.kind === 'assignee') {
      const person = after.person;
      if (
        typeof person !== 'number' ||
        !ctx.members.some((m) => m.person === person && !m.leftAt)
      )
        throw new PolicyError('참여 중인 팀원에게만 배정할 수 있습니다.');
    }
    entries.push({
      changeId: change.changeId,
      kind: change.kind,
      taskId: task.id,
      before: change.before,
      after,
      edited: wasEdited,
    });
  }
  return { entries, creations };
}

export type RevertCandidate = {
  entry: AppliedEntry;
  status: 'ready' | 'changed' | 'blocked';
  reason: string;
  restore: Record<string, unknown>;
};

/**
 * 되돌리기 후보. 현재 값이 적용 후 값과 같은 필드만 안전하게 복구한다.
 * 이후 다른 사람이 수정한 필드는 덮어쓰지 않고 다시 검토하게 한다.
 */
export function revertCandidates(
  entries: AppliedEntry[],
  ctx: Context,
): RevertCandidate[] {
  return entries.map((entry) => {
    const task = ctx.tasks.find((t) => t.id === entry.taskId);
    if (!task)
      return {
        entry,
        status: 'blocked' as const,
        reason: '대상 업무가 없습니다.',
        restore: {},
      };
    if (entry.kind === 'createTask') {
      // 참조를 끊거나 다른 사람의 기록을 지우는 자동 복구는 막는다.
      const dependents = ctx.tasks.filter((t) =>
        t.dependsOn.includes(task.id),
      );
      if (dependents.length)
        return {
          entry,
          status: 'blocked' as const,
          reason: `다른 업무(${dependents.map((d) => d.title).join(', ')})가 이 업무를 기다립니다.`,
          restore: {},
        };
      if (task.done || task.evidence.trim())
        return {
          entry,
          status: 'blocked' as const,
          reason: '결과물 근거가 기록된 업무는 자동으로 삭제하지 않습니다.',
          restore: {},
        };
      // 생성 이후 이 업무에 어떤 수정이라도 있었으면 삭제하지 않는다.
      // 프로젝트의 다른 업무 수정은 영향을 주지 않는다.
      const created = Number(entry.after.changeVersion ?? 0);
      const changed =
        Number(task.changeVersion ?? 0) !== created ||
        task.title !== entry.after.title ||
        task.person !== entry.after.person ||
        task.remaining !== entry.after.remaining;
      return changed
        ? {
            entry,
            status: 'changed' as const,
            reason:
              '생성 이후 이 업무의 설명·상태·마감·보고가 바뀌었습니다. 기록을 지우지 않으려면 삭제 대신 다시 검토해주세요.',
            restore: {},
          }
        : {
            entry,
            status: 'ready' as const,
            reason: '',
            restore: { delete: true },
          };
    }
    const restore: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(entry.after)) {
      const current = (task as unknown as Record<string, unknown>)[field] ?? null;
      if ((current ?? null) !== (value ?? null))
        return {
          entry,
          status: 'changed' as const,
          reason: `${field} 값이 그 뒤에 다시 바뀌었습니다. 현재 ${text(current, '없음')} / 복구 후보 ${text(entry.before[field], '없음')}`,
          restore: {},
        };
      restore[field] = entry.before[field] ?? null;
    }
    return { entry, status: 'ready' as const, reason: '', restore };
  });
}
