// AI 변경안 생성·조회·승인·되돌리기. 모델 출력은 여기서 DB를 바꾸지 못하고,
// 사용자가 선택·편집·승인한 항목만 기존 원자적 저장 경계를 지난다.
import { identity, member, actorOf, projectState, AccessError } from '@/lib/projects';
import {
  database,
  readPolicy,
  readMembers,
  readSprint,
  save,
  Conflict,
} from '@/lib/sprint-store';
import { assertProjectMutationAllowed, PolicyError } from '@/lib/sprint-policy';
import { readSource, WRITABLE_PROJECT } from '@/lib/source-documents';
import {
  buildPrompt,
  fakeModel,
  PROMPT_VERSION,
  validateChanges,
  type Model,
} from '@/lib/ai-extraction';
import {
  appliedCandidateKeys,
  listProposals,
  prepareApplication,
  readProposal,
  revertCandidates,
  type AppliedEntry,
  type Context,
} from '@/lib/change-proposals';
import { cancelStatements, scheduleStatements } from '@/lib/reminder-store';
export const dynamic = 'force-dynamic';

// 운영 모델은 아직 연결하지 않았다(사용자 결정 2026-09-09). 가짜 모델로 흐름만 잇는다.
let model: Model = fakeModel();
export function useModel(next: Model) {
  model = next;
}

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
function failure(error: unknown) {
  if (error instanceof AccessError || error instanceof PolicyError)
    return reply({ error: error.message }, error.status);
  if (error instanceof Conflict)
    return reply(
      { error: error.message || '다른 변경이 있습니다. 최신 상태로 다시 검토해주세요.' },
      409,
    );
  if (error instanceof SyntaxError)
    return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  if (error instanceof Error && !/SQLITE|D1_|database|binding/i.test(error.message))
    return reply({ error: error.message }, 400);
  console.error('change proposal request failed', error);
  return reply({ error: '처리하지 못했습니다.' }, 503);
}

export async function GET(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project') ?? '';
    await member(projectId, user);
    const id = url.searchParams.get('proposal');
    if (!id)
      return reply({
        proposals: await listProposals(projectId),
        applications: await listApplications(projectId),
      });
    const proposal = await readProposal(projectId, id);
    if (!proposal) return reply({ error: '변경안을 찾을 수 없습니다.' }, 404);
    const sprint = await readSprint(projectId);
    return reply({
      proposal,
      // 오래된 변경안은 현재 값과의 차이를 함께 보여준다.
      stale: proposal.baseRevision !== sprint?.revision,
      currentRevision: sprint?.revision ?? 0,
    });
  } catch (e) {
    return failure(e);
  }
}

async function listApplications(projectId: string) {
  const rows = await database()
    .prepare(
      'SELECT id,proposal_id,source_id,reverts,approved_by,approved_at,revision,entries FROM ai_change_applications WHERE project_id=? ORDER BY approved_at DESC LIMIT 20',
    )
    .bind(projectId)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    id: String(r.id),
    proposalId: (r.proposal_id as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    reverts: (r.reverts as string | null) ?? null,
    approvedBy: String(r.approved_by),
    approvedAt: String(r.approved_at),
    revision: Number(r.revision),
    entries: JSON.parse(String(r.entries)) as AppliedEntry[],
  }));
}

export async function POST(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 60000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const projectId = typeof b.projectId === 'string' ? b.projectId : '';
    const action = String(b.action);
    const me = await member(projectId, user);
    const actor = actorOf(me);
    const policy = await readPolicy(projectId);
    const now = new Date();
    assertProjectMutationAllowed({
      policy,
      actor,
      action:
        action === 'create'
          ? 'createProposal'
          : action === 'apply'
            ? 'applyChanges'
            : action === 'revert'
              ? 'revertChanges'
              : action,
      now,
    });
    const sprint = await readSprint(projectId);
    if (!sprint) return reply({ error: '프로젝트를 찾을 수 없습니다.' }, 404);
    const members = await readMembers(projectId);
    const ctx: Context = {
      tasks: sprint.tasks,
      members,
      actor: { userId: user.id, role: me.role, person: me.person },
      deadline: policy?.deadlineAt ?? null,
      now,
    };
    const db = database();
    if (action === 'create') {
      const source = await readSource(
        projectId,
        typeof b.sourceId === 'string' ? b.sourceId : '',
      );
      if (!source) return reply({ error: '원문을 찾을 수 없습니다.' }, 404);
      const input = {
        source: { id: source.id, body: source.body },
        tasks: sprint.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          person: t.person,
          status: t.status ?? 'todo',
          remaining: t.remaining,
          done: t.done,
          dueAt: t.dueAt ?? null,
        })),
        members: members
          .filter((m) => !m.leftAt)
          .map((m) => ({ person: m.person, displayName: m.displayName })),
        deliverables: [] as string[],
        now: now.toISOString(),
        deadline: policy?.deadlineAt ?? null,
      };
      const proposalId = 'cp_' + crypto.randomUUID();
      let changes: ReturnType<typeof validateChanges>['changes'] = [];
      let rejected: ReturnType<typeof validateChanges>['rejected'] = [];
      let error = '';
      try {
        // 프롬프트에서도 원문은 인용 자료로만 다룬다.
        void buildPrompt(input);
        const output = await model.run(input);
        const checked = validateChanges(
          output.changes,
          input,
          await appliedCandidateKeys(projectId, source.id),
        );
        changes = checked.changes;
        rejected = checked.rejected;
      } catch (e) {
        // 모델 오류·잘못된 구조는 검토 가능한 실패로 남기고 업무는 바꾸지 않는다.
        error = e instanceof Error ? e.message : '모델 응답을 처리하지 못했습니다.';
      }
      // 모델 호출이 끝난 뒤 상태가 바뀌었을 수 있다. 실제 INSERT에도 프로젝트
      // 상태·마감·현재 멤버십 조건을 걸고, 세부 항목은 머리 행이 있을 때만 넣는다.
      const written = await db.batch([
        db
          .prepare(
            'INSERT INTO ai_change_proposals(id,project_id,source_id,base_revision,model,prompt_version,status,error,created_by,created_at)' +
              ' SELECT ?,p.project_id,?,?,?,?,?,?,?,?' +
              WRITABLE_PROJECT,
          )
          .bind(
            proposalId,
            source.id,
            sprint.revision,
            model.name,
            PROMPT_VERSION,
            error ? 'failed' : 'pending',
            error,
            user.id,
            now.toISOString(),
            projectId,
            user.id,
          ),
        ...changes.map((c) =>
          db
            .prepare(
              'INSERT INTO ai_proposal_changes(proposal_id,change_id,kind,task_id,new_key,before,after,evidence_start,evidence_end,evidence_quote,basis,needs_review,requires,blocked)' +
                ' SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM ai_change_proposals WHERE id=?',
            )
            .bind(
              proposalId,
              c.changeId,
              c.kind,
              c.taskId,
              c.newKey,
              JSON.stringify(c.before),
              JSON.stringify(c.after),
              c.evidence?.start ?? null,
              c.evidence?.end ?? null,
              c.evidence?.quote ?? '',
              c.basis,
              c.needsReview,
              c.requires,
              c.blocked,
              proposalId,
            ),
        ),
      ]);
      if (written[0].meta.changes !== 1)
        throw new PolicyError(
          '변경안을 만드는 사이에 프로젝트가 종료되었거나 권한이 바뀌었습니다. 최신 상태를 확인해주세요.',
        );
      // 생성만으로는 어떤 업무 값도 바뀌지 않는다.
      return reply(
        {
          proposalId,
          model: model.name,
          live: model.live,
          error,
          rejected,
          proposal: await readProposal(projectId, proposalId),
        },
        201,
      );
    }
    const mutationId =
      typeof b.mutationId === 'string' && /^[\w-]{8,80}$/.test(b.mutationId)
        ? b.mutationId
        : null;
    if (!mutationId) throw new PolicyError('요청 식별자가 필요합니다.');
    // 같은 승인/되돌리기 요청의 재전송은 같은 결과를 돌려주고 다시 적용하지 않는다.
    // 첫 요청이 이미 버전을 올렸으므로 버전 검사보다 먼저 판정한다.
    const existing = await db
      .prepare('SELECT id FROM ai_change_applications WHERE id=?')
      .bind(mutationId)
      .first();
    if (existing)
      return reply({
        applicationId: mutationId,
        repeated: true,
        state: await projectState(projectId, user),
      });
    if (!Number.isInteger(b.revision) || b.revision !== sprint.revision)
      throw new Conflict();
    if (action === 'apply') {
      const proposal = await readProposal(
        projectId,
        typeof b.proposalId === 'string' ? b.proposalId : '',
      );
      if (!proposal) return reply({ error: '변경안을 찾을 수 없습니다.' }, 404);
      if (proposal.status !== 'pending')
        throw new PolicyError('이미 처리했거나 실패한 변경안입니다.');
      const prepared = prepareApplication(
        proposal,
        (b.selections ?? []) as { changeId: string }[],
        ctx,
        await appliedCandidateKeys(projectId, proposal.sourceId),
      );
      // 변경안을 만든 당시의 기준 상태가 그대로여야 그대로 승인할 수 있다.
      // 첫 변경안 승인으로 업무가 바뀌었다면 두 번째 변경안은 재검토 대상이다.
      if (proposal.baseRevision !== sprint.revision)
        throw new Conflict(
          '변경안을 만든 뒤 기준 상태가 달라졌습니다. 최신 차이로 다시 검토해주세요.',
        );
      await writeApplication(
        projectId,
        sprint,
        prepared.entries,
        prepared.creations,
        {
          mutationId,
          proposalId: proposal.id,
          sourceId: proposal.sourceId,
          reverts: null,
          userId: user.id,
          name: me.display_name,
          now,
          members,
          deadlineNote: `AI 변경안 승인 · ${prepared.entries.length}건`,
        },
      );
      return reply({
        applicationId: mutationId,
        state: await projectState(projectId, user),
      });
    }
    if (action === 'revert') {
      const applicationId = typeof b.applicationId === 'string' ? b.applicationId : '';
      const row = await db
        .prepare(
          'SELECT * FROM ai_change_applications WHERE id=? AND project_id=?',
        )
        .bind(applicationId, projectId)
        .first<Record<string, unknown>>();
      if (!row) return reply({ error: '적용 기록을 찾을 수 없습니다.' }, 404);
      if (row.reverts)
        throw new PolicyError('되돌리기 기록은 다시 되돌리지 않습니다.');
      const already = await db
        .prepare(
          'SELECT id FROM ai_change_applications WHERE project_id=? AND reverts=?',
        )
        .bind(projectId, applicationId)
        .first();
      if (already)
        throw new PolicyError('이미 되돌린 변경입니다.');
      const entries = JSON.parse(String(row.entries)) as AppliedEntry[];
      const wanted = Array.isArray(b.changeIds)
        ? (b.changeIds as string[])
        : entries.map((e) => e.changeId);
      const candidates = revertCandidates(entries, ctx).filter((c) =>
        wanted.includes(c.entry.changeId),
      );
      const unsafe = candidates.filter((c) => c.status !== 'ready');
      if (unsafe.length)
        return reply(
          {
            error:
              '자동으로 되돌릴 수 없는 항목이 있습니다. 최신 값과 비교해 다시 검토해주세요.',
            conflicts: unsafe.map((c) => ({
              changeId: c.entry.changeId,
              status: c.status,
              reason: c.reason,
            })),
          },
          409,
        );
      if (!candidates.length)
        throw new PolicyError('되돌릴 항목을 선택해주세요.');
      const reverseEntries: AppliedEntry[] = [];
      const deletions: number[] = [];
      for (const c of candidates) {
        // 되돌리기도 권한을 다시 검사한다. 원승인자라는 이유로 권한을 주지 않는다.
        const task = ctx.tasks.find((t) => t.id === c.entry.taskId)!;
        if (c.entry.kind === 'createTask' || c.entry.kind === 'assignee' || c.entry.kind === 'dueAt') {
          if (me.role !== 'owner')
            throw new PolicyError('팀장만 되돌릴 수 있습니다.', 403);
        } else if (me.role !== 'owner' && task.person !== me.person)
          throw new PolicyError('본인의 업무만 되돌릴 수 있습니다.', 403);
        if (c.restore.delete) deletions.push(c.entry.taskId);
        reverseEntries.push({
          changeId: c.entry.changeId,
          kind: c.entry.kind,
          taskId: c.entry.taskId,
          before: c.entry.after,
          after: c.restore.delete ? { deleted: true } : c.restore,
          edited: false,
        });
      }
      await writeApplication(
        projectId,
        sprint,
        reverseEntries,
        [],
        {
          mutationId,
          proposalId: null,
          sourceId: (row.source_id as string | null) ?? null,
          reverts: applicationId,
          userId: user.id,
          name: me.display_name,
          now,
          members,
          deadlineNote: `AI 변경 되돌리기 · ${reverseEntries.length}건`,
          deletions,
        },
      );
      return reply({
        applicationId: mutationId,
        state: await projectState(projectId, user),
      });
    }
    throw new PolicyError('지원하지 않는 작업입니다.');
  } catch (e) {
    return failure(e);
  }
}

/** 승인 항목, 이력, 알림 예약 갱신을 기존 save 경계에서 한 번에 저장한다. */
async function writeApplication(
  projectId: string,
  sprint: Awaited<ReturnType<typeof readSprint>>,
  entries: AppliedEntry[],
  creations: {
    taskId: number;
    title: string;
    person: number;
    remaining: number;
    dependsOn: number[];
  }[],
  meta: {
    mutationId: string;
    proposalId: string | null;
    sourceId: string | null;
    reverts: string | null;
    userId: string;
    name: string;
    now: Date;
    members: { person: number; userId: string; leftAt: string | null }[];
    deadlineNote: string;
    deletions?: number[];
  },
) {
  const db = database();
  const s = sprint!;
  const gate = ' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)';
  await save(
    projectId,
    s,
    meta.reverts ? 'aiRevert' : 'aiApply',
    `${meta.name} · ${meta.deadlineNote}`,
    (m) => {
      const out = [];
      for (const c of creations)
        out.push(
          db
            .prepare(
              'INSERT INTO sprint_tasks(owner,id,title,person,remaining) SELECT owner,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
            )
            .bind(c.taskId, c.title, c.person, c.remaining, projectId, m),
          ...c.dependsOn.map((d) =>
            db
              .prepare(
                'INSERT INTO sprint_dependencies(owner,task_id,depends_on) SELECT owner,?,? FROM sprints WHERE owner=? AND mutation=?',
              )
              .bind(c.taskId, d, projectId, m),
          ),
        );
      for (const e of entries) {
        if (e.kind === 'createTask') continue;
        const sets: string[] = [];
        const args: unknown[] = [];
        for (const [field, value] of Object.entries(e.after)) {
          const column =
            field === 'dueAt'
              ? 'due_at'
              : field === 'person'
                ? 'person'
                : field === 'done'
                  ? 'done'
                  : field === 'evidence'
                    ? 'evidence'
                    : field === 'remaining'
                      ? 'remaining'
                      : field === 'status'
                        ? 'status'
                        : null;
          if (!column || field === 'deleted') continue;
          // NOT NULL 컬럼은 빈 값으로 되돌린다. 알 수 없는 값은 건드리지 않는다.
          if (value === null && (column === 'evidence' || column === 'status')) {
            if (column !== 'evidence') continue;
            sets.push('evidence=?');
            args.push('');
            continue;
          }
          if (value === null && column === 'remaining') continue;
          sets.push(`${column}=?`);
          args.push(typeof value === 'boolean' ? Number(value) : value);
        }
        if (e.kind === 'dueAt') {
          sets.push('deadline_version=deadline_version+1');
        }
        if (!sets.length) continue;
        out.push(
          db
            .prepare(
              `UPDATE sprint_tasks SET ${sets.join(',')} WHERE owner=? AND id=?` +
                gate,
            )
            .bind(...args, projectId, e.taskId, projectId, m),
        );
      }
      for (const taskId of meta.deletions ?? [])
        out.push(
          db
            .prepare(
              'DELETE FROM sprint_dependencies WHERE owner=? AND task_id=?' + gate,
            )
            .bind(projectId, taskId, projectId, m),
          db
            .prepare('DELETE FROM sprint_tasks WHERE owner=? AND id=?' + gate)
            .bind(projectId, taskId, projectId, m),
          ...cancelStatements(projectId, m, {
            kind: 'task',
            taskId,
            reason: '되돌리기로 업무 삭제',
          }),
        );
      // 마감·담당자·완료 변경은 B의 예약 갱신을 같은 저장 경계에서 수행한다.
      for (const e of entries) {
        if (!['dueAt', 'assignee', 'complete'].includes(e.kind)) continue;
        if (meta.deletions?.includes(e.taskId)) continue;
        out.push(
          ...cancelStatements(projectId, m, {
            kind: 'task',
            taskId: e.taskId,
            reason: 'AI 승인/되돌리기로 재검토',
          }),
        );
        const task = s.tasks.find((t) => t.id === e.taskId);
        const dueAt =
          'dueAt' in e.after
            ? (e.after.dueAt as string | null)
            : (task?.dueAt ?? null);
        const person =
          'person' in e.after ? (e.after.person as number) : (task?.person ?? -1);
        const done = 'done' in e.after ? Boolean(e.after.done) : (task?.done ?? false);
        const assignee = meta.members.find((x) => x.person === person);
        if (dueAt && !done && assignee && !assignee.leftAt)
          out.push(
            ...scheduleStatements(
              projectId,
              m,
              [
                {
                  kind: 'task' as const,
                  taskId: e.taskId,
                  userId: assignee.userId,
                  deadlineVersion: (task?.deadlineVersion ?? 0) + 1,
                  dueAt,
                },
              ],
              meta.now,
            ),
          );
      }
      if (meta.proposalId)
        out.push(
          db
            .prepare(
              "UPDATE ai_change_proposals SET status='applied' WHERE id=? AND project_id=?" +
                gate,
            )
            .bind(meta.proposalId, projectId, projectId, m),
        );
      out.push(
        db
          .prepare(
            'INSERT INTO ai_change_applications(id,project_id,proposal_id,source_id,reverts,approved_by,approved_at,revision,entries) SELECT ?,owner,?,?,?,?,?,revision,? FROM sprints WHERE owner=? AND mutation=?',
          )
          .bind(
            meta.mutationId,
            meta.proposalId,
            meta.sourceId,
            meta.reverts,
            meta.userId,
            meta.now.toISOString(),
            JSON.stringify(entries),
            projectId,
            m,
          ),
      );
      return out;
    },
    ['draft', 'active'],
  );
}
