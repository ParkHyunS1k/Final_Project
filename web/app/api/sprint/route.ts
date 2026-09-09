import {
  identity,
  member,
  actorOf,
  listProjects,
  projectState,
  exportProject,
  goalInput,
  AccessError,
} from '@/lib/projects';
import {
  database,
  readSprint,
  readPolicy,
  readMembers,
  readDeliverables,
  bumpTaskVersion,
  save,
  Conflict,
} from '@/lib/sprint-store';
import { validateHours, taskInput, seoulTime } from '@/lib/sprint';
import {
  assertProjectMutationAllowed,
  deadlineFrom,
  PolicyError,
  startReadiness,
} from '@/lib/sprint-policy';
import { assertEvidence, completionCheck } from '@/lib/deliverables';
import {
  cancelStatements,
  scheduleStatements,
} from '@/lib/reminder-store';
export const dynamic = 'force-dynamic';

/**
 * 승인된 업무 마감. 팀장의 명시적 입력만 확정하며, 프로젝트 최종 기한을 넘길 수 없다.
 * 준비 중에는 최종 기한이 없으므로 마감을 미정으로만 둔다(독촉도 예약되지 않는다).
 */
function taskDueAt(
  value: unknown,
  policy: { deadlineAt: string | null },
  now: Date,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new PolicyError('업무 마감 형식이 올바르지 않습니다.');
  const at = Date.parse(value);
  if (!Number.isFinite(at))
    throw new PolicyError('업무 마감 형식이 올바르지 않습니다.');
  if (!policy.deadlineAt)
    throw new PolicyError(
      '스프린트를 시작한 뒤에 업무 마감을 지정할 수 있습니다.',
    );
  if (at > Date.parse(policy.deadlineAt))
    throw new PolicyError('업무 마감은 프로젝트 최종 기한을 넘을 수 없습니다.');
  if (at <= now.getTime())
    throw new PolicyError('업무 마감은 현재 시각 이후여야 합니다.');
  return new Date(at).toISOString();
}
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
export async function GET(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const url = new URL(request.url);
    const projects = await listProjects(user);
    const id = url.searchParams.get('project') || String(projects[0]?.id || '');
    if (!id) return reply({ error: '프로젝트를 먼저 만들어주세요.' }, 404);
    // 마감·완주 이후에도 열람과 내보내기는 유지한다.
    if (url.searchParams.get('format') === 'export')
      return reply(await exportProject(id, user));
    return reply(await projectState(id, user));
  } catch (error) {
    if (error instanceof AccessError)
      return reply({ error: error.message }, error.status);
    console.error('sprint read failed', error);
    return reply({ error: '저장한 프로젝트를 불러오지 못했습니다.' }, 503);
  }
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
  if (raw.length > 16000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw);
    if (
      !b ||
      typeof b !== 'object' ||
      Array.isArray(b) ||
      typeof b.action !== 'string' ||
      !Number.isInteger(b.revision)
    )
      throw new Error('요청 형식이 올바르지 않습니다.');
    const projects = await listProjects(user);
    const id =
      typeof b.projectId === 'string'
        ? b.projectId
        : String(projects[0]?.id || '');
    const me = await member(id, user);
    const actor = actorOf(me);
    const policy = await readPolicy(id);
    const s = await readSprint(id);
    if (!s) return reply({ error: '프로젝트를 먼저 열어주세요.' }, 404);
    const now = new Date();
    const db = database();
    const timestamp = now.toISOString();
    // assignee 범위 action은 대상 업무의 담당자를 함께 검사한다.
    const target =
      typeof b.taskId === 'number'
        ? s.tasks.find((t) => t.id === b.taskId)
        : undefined;
    assertProjectMutationAllowed({
      policy,
      actor,
      action: b.action,
      now,
      assigneePerson: target?.person,
      targetUserId: typeof b.userId === 'string' ? b.userId : user.id,
    });
    if (b.revision !== s.revision) throw new Conflict();
    const open = ['draft', 'active'] as const;
    if (b.action === 'agreeGoal') {
      // 진행 중 참여자는 고정 목표에 동의할 뿐, 목표를 다시 열지 않는다.
      if (b.goalVersion !== policy!.goalVersion)
        throw new Conflict('목표가 다시 바뀌었습니다. 최신 내용을 확인해주세요.');
      await save(
        id,
        s,
        'agreeGoal',
        `${me.display_name} · 목표 v${policy!.goalVersion} 동의`,
        (m) => [
          db
            .prepare(
              'UPDATE project_members SET agreed_at=?,agreed_goal_version=? WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(
              timestamp,
              policy!.goalVersion,
              id,
              user.id,
              id,
              m,
            ),
        ],
        [...open],
      );
    } else if (b.action === 'editGoal') {
      const v = goalInput(b);
      const version = policy!.goalVersion + 1;
      s.title = v.title;
      await save(
        id,
        s,
        'editGoal',
        `목표 v${version} 편집 · 전원 재동의 필요`,
        (m) => {
          const gate =
            ' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)';
          return [
            db
              .prepare(
                'UPDATE sprints SET title=? WHERE owner=?' + gate,
              )
              .bind(v.title, id, id, m),
            db
              .prepare(
                'UPDATE project_policy SET goal_version=?,duration_days=? WHERE project_id=?' +
                  gate,
              )
              .bind(version, v.duration, id, id, m),
            db
              .prepare(
                'UPDATE project_agreement SET goal_version=?,title=?,goal=?,scope=?,completion_criteria=? WHERE project_id=?' +
                  gate,
              )
              .bind(version, v.title, v.goal, v.scope, v.completion, id, id, m),
            db
              .prepare(
                'UPDATE project_details SET goal=?,deliverables=?,completion_criteria=? WHERE project_id=?' +
                  gate,
              )
              .bind(
                v.goal,
                JSON.stringify(v.deliverables),
                v.completion,
                id,
                id,
                m,
              ),
            // 편집한 팀장은 새 버전에 동의한 상태, 나머지는 재동의 대상이다.
            db
              .prepare(
                'UPDATE project_members SET agreed_goal_version=? WHERE project_id=? AND user_id=?' +
                  gate,
              )
              .bind(version, id, user.id, id, m),
            db
              .prepare(
                'DELETE FROM project_deliverables WHERE project_id=? AND fixed_at IS NULL' +
                  gate,
              )
              .bind(id, id, m),
            ...v.deliverables.map((title, i) =>
              db
                .prepare(
                  'INSERT INTO project_deliverables(project_id,deliverable_id,position,title) SELECT owner,?,?,? FROM sprints WHERE owner=? AND mutation=?',
                )
                .bind('d_' + crypto.randomUUID(), i, title, id, m),
            ),
          ];
        },
        ['draft'],
      );
    } else if (b.action === 'start') {
      const members = await readMembers(id);
      const deliverables = await readDeliverables(id);
      const check = startReadiness(
        members,
        policy!.goalVersion,
        deliverables.length,
      );
      if (!check.ready) throw new PolicyError(check.missing.join(' '));
      const deadline = deadlineFrom(now, policy!.durationDays);
      await save(
        id,
        s,
        'start',
        `스프린트 시작 · ${policy!.durationDays}일 · 마감 ${deadline}`,
        (m) => {
          const gate =
            ' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)';
          return [
            // 중복 시작은 lifecycle 조건에서 걸러지고 기한을 다시 계산하지 않는다.
            db
              .prepare(
                "UPDATE project_policy SET lifecycle='active',started_at=?,deadline_at=? WHERE project_id=? AND lifecycle='draft'" +
                  gate,
              )
              .bind(timestamp, deadline, id, id, m),
            db
              .prepare(
                'UPDATE project_agreement SET fixed_at=? WHERE project_id=?' +
                  gate,
              )
              .bind(timestamp, id, id, m),
            db
              .prepare(
                'UPDATE project_deliverables SET fixed_at=? WHERE project_id=? AND fixed_at IS NULL' +
                  gate,
              )
              .bind(timestamp, id, id, m),
            db
              .prepare(
                'UPDATE sprints SET start_date=?,deadline=? WHERE owner=?' + gate,
              )
              .bind(timestamp.slice(0, 10), deadline, id, id, m),
            // 프로젝트 알림은 현재 팀원 각자에게 예약한다.
            ...scheduleStatements(
              id,
              m,
              members
                .filter((x) => !x.leftAt)
                .map((x) => ({
                  kind: 'project' as const,
                  userId: x.userId,
                  deadlineVersion: 0,
                  dueAt: deadline,
                })),
              now,
            ),
          ];
        },
        ['draft'],
      );
    } else if (b.action === 'createTask' || b.action === 'editTask') {
      const creating = b.action === 'createTask';
      const existing = s.tasks.find((t) => t.id === b.taskId);
      if (!creating && (!existing || existing.done))
        throw new Error('진행 중인 업무만 편집할 수 있습니다.');
      if (creating && s.tasks.length >= 100)
        throw new Error(
          '한 스프린트에는 최대 100개의 업무를 등록할 수 있습니다.',
        );
      const taskId = creating
        ? Math.max(0, ...s.tasks.map((t) => t.id)) + 1
        : existing!.id;
      const input = taskInput(b, s.tasks, taskId);
      const teamNow = await readMembers(id);
      const assignee = teamNow.find(
        (m) => m.person === input.person && !m.leftAt,
      );
      if (!assignee)
        throw new Error('참여 중인 팀원에게만 업무를 배정할 수 있습니다.');
      // 승인된 업무 마감. 팀장의 명시적 입력만 확정하며 예상 종료와 별개다.
      const dueAt = taskDueAt(b.dueAt, policy!, now);
      const previous = existing ?? null;
      const dueChanged = (previous?.dueAt ?? null) !== dueAt;
      const personChanged = previous ? previous.person !== input.person : true;
      const deadlineVersion =
        (previous?.deadlineVersion ?? 0) + (dueChanged ? 1 : 0);
      await save(
        id,
        s,
        b.action,
        `${input.title} · ${assignee.displayName} · 남은 ${input.remaining}h · 마감 ${dueAt ? seoulTime(dueAt) + ' KST' : '미정'} · 선행 ${input.dependsOn.join(', ') || '없음'}`,
        (m) => [
          creating
            ? db
                .prepare(
                  'INSERT INTO sprint_tasks(owner,id,title,person,remaining,due_at,deadline_version) SELECT owner,?,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
                )
                .bind(
                  taskId,
                  input.title,
                  input.person,
                  input.remaining,
                  dueAt,
                  deadlineVersion,
                  id,
                  m,
                )
            : db
                .prepare(
                  'UPDATE sprint_tasks SET title=?,person=?,remaining=?,due_at=?,deadline_version=? WHERE owner=? AND id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
                )
                .bind(
                  input.title,
                  input.person,
                  input.remaining,
                  dueAt,
                  deadlineVersion,
                  id,
                  taskId,
                  id,
                  m,
                ),
          db
            .prepare(
              'DELETE FROM sprint_dependencies WHERE owner=? AND task_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(id, taskId, id, m),
          ...input.dependsOn.map((d) =>
            db
              .prepare(
                'INSERT INTO sprint_dependencies(owner,task_id,depends_on) SELECT owner,?,? FROM sprints WHERE owner=? AND mutation=?',
              )
              .bind(taskId, d, id, m),
          ),
          ...(creating ? [] : [bumpTaskVersion(id, m, taskId)]),
          // 마감이나 담당자가 바뀌면 이전 담당자의 미발송 예약을 취소하고
          // 새 담당자에게 미래 단계만 다시 예약한다.
          ...(dueChanged || personChanged
            ? [
                ...cancelStatements(id, m, {
                  kind: 'task',
                  taskId,
                  reason: dueChanged ? '승인된 마감 변경' : '담당자 변경',
                }),
                ...(dueAt
                  ? scheduleStatements(
                      id,
                      m,
                      [
                        {
                          kind: 'task' as const,
                          taskId,
                          userId: assignee.userId,
                          deadlineVersion,
                          dueAt,
                        },
                      ],
                      now,
                    )
                  : []),
              ]
            : []),
        ],
        [...open],
      );
    } else if (b.action === 'taskDetails') {
      const t = s.tasks.find((t) => t.id === b.taskId && !t.done);
      if (!t) throw new Error('진행 중인 업무만 수정할 수 있습니다.');
      if (b.status !== 'todo' && b.status !== 'in_progress')
        throw new Error('시작 전 또는 진행 중 상태를 선택해주세요.');
      if (typeof b.description !== 'string' || b.description.length > 10000)
        throw new Error('업무 설명은 10000자 이내로 입력해주세요.');
      t.status = b.status;
      t.description = b.description;
      t.remaining = validateHours(b.remaining);
      await save(
        id,
        s,
        'taskDetails',
        `${t.title} · ${t.status === 'todo' ? '시작 전' : '진행 중'} · 남은 ${t.remaining}h · 상세 수정`,
        (m) => [bumpTaskVersion(id, m, t.id)],
        [...open],
      );
    } else if (b.action === 'checkin') {
      const t = s.tasks.find((t) => t.id === b.taskId && !t.done);
      if (!t) throw new Error('진행 중인 업무를 선택해주세요.');
      if (typeof b.note !== 'string' || !b.note.trim() || b.note.length > 1000)
        throw new Error('체크인 내용을 1~1000자로 입력해주세요.');
      t.remaining = validateHours(b.remaining);
      await save(
        id,
        s,
        'checkin',
        `${t.title} · 남은 ${t.remaining}시간`,
        (m) => [
          db
            .prepare(
              'INSERT INTO sprint_checkins(id,owner,task_id,note,remaining,created_at) SELECT ?,owner,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
            )
            .bind(
              crypto.randomUUID(),
              t.id,
              b.note.trim(),
              t.remaining,
              timestamp,
              id,
              m,
            ),
          bumpTaskVersion(id, m, t.id),
        ],
        [...open],
      );
    } else if (b.action === 'task') {
      const t = s.tasks.find((t) => t.id === b.taskId);
      if (!t) throw new Error('업무를 찾을 수 없습니다.');
      if (typeof b.done !== 'boolean')
        throw new Error('완료 상태가 올바르지 않습니다.');
      if (b.done) {
        t.evidence = assertEvidence(b.evidence);
        t.remaining = 0;
      } else {
        t.remaining = validateHours(b.remaining);
        if (t.remaining === 0)
          throw new Error('다시 진행할 업무의 남은 시간을 입력해주세요.');
        t.evidence = '';
        t.status = 'in_progress';
      }
      t.done = b.done;
      const assignedTo = (await readMembers(id)).find(
        (m) => m.person === t.person,
      );
      await save(
        id,
        s,
        'task',
        `${t.title} · ${t.done ? '기록 완료' : '다시 진행'}`,
        (m) => [
          bumpTaskVersion(id, m, t.id),
          ...(b.done
            ? cancelStatements(id, m, {
                kind: 'task',
                taskId: t.id,
                reason: '업무 완료',
              })
            : // 재개해도 이미 지난 단계는 소급 발송하지 않는다.
              t.dueAt && assignedTo && !assignedTo.leftAt
              ? scheduleStatements(
                  id,
                  m,
                  [
                    {
                      kind: 'task' as const,
                      taskId: t.id,
                      userId: assignedTo.userId,
                      deadlineVersion: t.deadlineVersion ?? 0,
                      dueAt: t.dueAt,
                    },
                  ],
                  now,
                )
              : []),
        ],
        [...open],
      );
    } else if (b.action === 'deliverableEvidence') {
      const list = await readDeliverables(id);
      const d = list.find((d) => d.deliverableId === b.deliverableId);
      if (!d) throw new Error('결과물을 찾을 수 없습니다.');
      const evidence = assertEvidence(b.evidence);
      await save(
        id,
        s,
        'deliverableEvidence',
        `${d.title} · 근거 기록`,
        (m) => [
          // 증빙을 바꿔도 시작 시 고정한 제목·순서는 변하지 않는다.
          db
            .prepare(
              'UPDATE project_deliverables SET evidence=?,evidence_by=?,evidence_at=?,confirmed=0,confirmed_by=NULL,confirmed_at=NULL WHERE project_id=? AND deliverable_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(
              evidence,
              user.id,
              timestamp,
              id,
              d.deliverableId,
              id,
              m,
            ),
        ],
        [...open],
      );
    } else if (b.action === 'deliverableConfirm') {
      const list = await readDeliverables(id);
      const d = list.find((d) => d.deliverableId === b.deliverableId);
      if (!d) throw new Error('결과물을 찾을 수 없습니다.');
      if (typeof b.confirmed !== 'boolean')
        throw new Error('확인 여부를 선택해주세요.');
      if (b.confirmed && d.evidence.trim().length < 5)
        throw new Error('근거가 기록된 결과물만 확인할 수 있습니다.');
      await save(
        id,
        s,
        'deliverableConfirm',
        // 팀장이 사람의 판단으로 확인한다. AI가 증빙의 진실성을 보증하지 않는다.
        `${d.title} · 팀장 ${b.confirmed ? '확인' : '확인 취소'}`,
        (m) => [
          db
            .prepare(
              'UPDATE project_deliverables SET confirmed=?,confirmed_by=?,confirmed_at=? WHERE project_id=? AND deliverable_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(
              Number(b.confirmed),
              b.confirmed ? user.id : null,
              b.confirmed ? timestamp : null,
              id,
              d.deliverableId,
              id,
              m,
            ),
        ],
        [...open],
      );
    } else if (b.action === 'finish') {
      // 완주 판정은 결과물 확인만 본다. 체크인 수·업무 수는 조건이 아니다.
      const check = completionCheck(await readDeliverables(id));
      if (!check.ready)
        throw new PolicyError(
          check.total
            ? `아직 확인되지 않은 필수 결과물이 있습니다: ${check.missing.join(', ')}`
            : '확인할 필수 결과물이 없습니다.',
        );
      s.finished = true;
      await save(
        id,
        s,
        'finish',
        '기한 내 합의 결과물 전체 확인 · 금전 환급은 운영자 검토 전',
        (m) => [
          db
            .prepare(
              "UPDATE project_policy SET lifecycle='completed',completed_at=? WHERE project_id=? AND lifecycle='active' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
            )
            .bind(timestamp, id, id, m),
          // 완주하면 남은 모든 독촉을 중단한다.
          ...cancelStatements(id, m, { reason: '프로젝트 완주' }),
        ],
        ['active'],
      );
    } else if (b.action === 'stepBack') {
      // 당사자가 알리고, 남은 팀 기준의 변경안은 팀장이 검토한다. 자동 재배정은 없다.
      if (typeof b.note !== 'string' || !b.note.trim() || b.note.length > 1000)
        throw new Error('참여 중단 사유를 1~1000자로 남겨주세요.');
      await save(
        id,
        s,
        'stepBack',
        `${me.display_name} · 참여 중단 보고`,
        (m) => [
          db
            .prepare(
              'UPDATE project_members SET left_at=?,left_note=? WHERE project_id=? AND user_id=? AND left_at IS NULL AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(timestamp, b.note.trim(), id, user.id, id, m),
          ...cancelStatements(id, m, {
            userId: user.id,
            reason: '참여 중단 보고',
          }),
        ],
        [...open],
      );
    } else throw new Error('지원하지 않는 작업입니다.');
    return reply(await projectState(id, user));
  } catch (error) {
    if (error instanceof AccessError)
      return reply({ error: error.message }, error.status);
    if (error instanceof PolicyError)
      return reply({ error: error.message }, error.status);
    if (error instanceof Conflict)
      return reply(
        {
          error:
            error.message ||
            '다른 변경이 있거나 오래된 제안입니다. 최신 상태를 불러온 뒤 다시 검토해주세요.',
        },
        409,
      );
    if (error instanceof SyntaxError)
      return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    // Validation errors are user-facing; infrastructure details never leave the server.
    if (
      error instanceof Error &&
      /D1_|SQLITE|database|binding/i.test(error.message)
    ) {
      console.error('sprint write failed', error);
      return reply(
        { error: '저장하지 못했습니다. 잠시 후 다시 시도해주세요.' },
        503,
      );
    }
    return reply(
      {
        error:
          error instanceof Error
            ? error.message
            : '요청을 처리하지 못했습니다.',
      },
      400,
    );
  }
}
