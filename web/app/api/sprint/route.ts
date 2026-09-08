import {
  identity,
  member,
  listProjects,
  projectState,
  AccessError,
} from '@/lib/projects';
import { database, readSprint, save, Conflict } from '@/lib/sprint-store';
import { recovery, schedule, validateHours, taskInput } from '@/lib/sprint';
export const dynamic = 'force-dynamic';
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
    const projects = await listProjects(user);
    const id =
      new URL(request.url).searchParams.get('project') ||
      String(projects[0]?.id || '');
    if (!id) return reply({ error: '프로젝트를 먼저 만들어주세요.' }, 404);
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
    if (
      ['approve', 'reject', 'finish', 'createTask', 'editTask'].includes(
        b.action,
      ) &&
      me.role !== 'owner'
    )
      throw new AccessError('팀장만 실행할 수 있습니다.');
    const s = await readSprint(id);
    if (!s) return reply({ error: '프로젝트를 먼저 열어주세요.' }, 404);
    if (b.revision !== s.revision) throw new Conflict();
    if (s.finished) throw new Error('완료된 스프린트는 변경할 수 없습니다.');
    const db = database();
    const timestamp = new Date().toISOString();
    if (b.action === 'join') {
      if (b.agreed !== true) throw new Error('참여 조건에 동의해주세요.');
      s.joined = true;
      await save(
        id,
        s,
        'join',
        '참여 조건 service-pilot-v1 확인 · 실제 결제 없음',
        (m) => [
          db
            .prepare(
              'UPDATE project_members SET agreed_at=? WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(timestamp, id, user.id, id, m),
        ],
      );
    } else {
      if (!me.agreed_at) throw new Error('참여 조건을 먼저 확인해주세요.');
      if (b.action === 'createTask' || b.action === 'editTask') {
        const creating = b.action === 'createTask';
        const existing = s.tasks.find((t) => t.id === b.taskId);
        if (!creating && (!existing || existing.done || existing.deferred))
          throw new Error('진행 중인 업무만 편집할 수 있습니다.');
        if (creating && s.tasks.length >= 100)
          throw new Error(
            '한 스프린트에는 최대 100개의 업무를 등록할 수 있습니다.',
          );
        const taskId = creating
          ? Math.max(0, ...s.tasks.map((t) => t.id)) + 1
          : existing!.id;
        const input = taskInput(b, s.tasks, taskId);
        const assignee = await db
          .prepare(
            'SELECT display_name FROM project_members WHERE project_id=? AND person=?',
          )
          .bind(id, input.person)
          .first<{ display_name: string }>();
        if (!assignee)
          throw new Error(
            '초대를 수락한 팀원에게만 업무를 배정할 수 있습니다.',
          );
        await save(
          id,
          s,
          b.action,
          `${input.title} · ${assignee.display_name} · 남은 ${input.remaining}h · ${input.optional ? '부가' : '필수'} · 선행 ${input.dependsOn.join(', ') || '없음'}`,
          (m) => [
            creating
              ? db
                  .prepare(
                    'INSERT INTO sprint_tasks(owner,id,title,person,remaining,optional) SELECT owner,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
                  )
                  .bind(
                    taskId,
                    input.title,
                    input.person,
                    input.remaining,
                    Number(input.optional),
                    id,
                    m,
                  )
              : db
                  .prepare(
                    'UPDATE sprint_tasks SET title=?,person=?,remaining=?,optional=? WHERE owner=? AND id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
                  )
                  .bind(
                    input.title,
                    input.person,
                    input.remaining,
                    Number(input.optional),
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
          ],
        );
      } else if (b.action === 'taskDetails') {
        const t = s.tasks.find(
          (t) => t.id === b.taskId && !t.deferred && !t.done,
        );
        if (!t) throw new Error('진행 중인 업무만 수정할 수 있습니다.');
        if (me.role !== 'owner' && t.person !== me.person)
          throw new AccessError('본인의 업무만 변경할 수 있습니다.');
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
        );
      } else if (b.action === 'checkin') {
        const t = s.tasks.find(
          (t) => t.id === b.taskId && !t.done && !t.deferred,
        );
        if (!t) throw new Error('진행 중인 업무를 선택해주세요.');
        if (me.role !== 'owner' && t.person !== me.person)
          throw new AccessError('본인의 업무만 변경할 수 있습니다.');
        if (
          typeof b.note !== 'string' ||
          !b.note.trim() ||
          b.note.length > 1000
        )
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
          ],
        );
      } else if (b.action === 'capacity') {
        if (me.role !== 'owner' && b.person !== me.person)
          throw new AccessError('본인의 가용시간만 변경할 수 있습니다.');
        const c = s.capacity.find(
          (c) => c.person === b.person && c.date === b.date,
        );
        if (!c) throw new Error('스프린트 안의 팀원과 날짜를 선택해주세요.');
        c.hours = validateHours(b.hours);
        if (c.hours > 12) throw new Error('하루 작업시간은 0~12시간입니다.');
        await save(
          id,
          s,
          'capacity',
          `${c.date} · 팀원 ${c.person + 1} 가용시간 ${c.hours}h`,
        );
      } else if (b.action === 'task') {
        const t = s.tasks.find((t) => t.id === b.taskId && !t.deferred);
        if (!t) throw new Error('업무를 찾을 수 없습니다.');
        if (me.role !== 'owner' && t.person !== me.person)
          throw new AccessError('본인의 업무만 변경할 수 있습니다.');
        if (typeof b.done !== 'boolean')
          throw new Error('완료 상태가 올바르지 않습니다.');
        if (b.done) {
          if (
            typeof b.evidence !== 'string' ||
            b.evidence.trim().length < 5 ||
            b.evidence.length > 2000
          )
            throw new Error('검증 결과나 결과물 링크를 5~2000자로 남겨주세요.');
          t.evidence = b.evidence.trim();
          t.remaining = 0;
        } else {
          t.remaining = validateHours(b.remaining);
          if (t.remaining === 0)
            throw new Error('다시 진행할 업무의 남은 시간을 입력해주세요.');
          t.evidence = '';
          t.status = 'in_progress';
        }
        t.done = b.done;
        await save(
          id,
          s,
          'task',
          `${t.title} · ${t.done ? '결과 확인' : '다시 진행'}`,
        );
      } else if (b.action === 'propose') {
        const plan = recovery(s);
        if (!plan)
          throw new Error(
            schedule(s).feasible
              ? '현재 계획은 마감 안에 배치됩니다.'
              : '부가 기능을 미뤄도 마감을 지키기 어렵습니다. 필수 범위나 가용시간을 팀과 다시 합의해주세요.',
          );
        const proposalId = crypto.randomUUID();
        await save(
          id,
          s,
          'propose',
          '가용시간과 의존관계에 따른 범위 축소안 생성',
          (m) => [
            db
              .prepare(
                "UPDATE sprint_proposals SET status='superseded' WHERE owner=? AND status='pending' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
              )
              .bind(id, id, m),
            db
              .prepare(
                "INSERT INTO sprint_proposals(id,owner,base_revision,defer_ids,status,created_at) SELECT ?,owner,revision,?,'pending',? FROM sprints WHERE owner=? AND mutation=?",
              )
              .bind(
                proposalId,
                JSON.stringify(plan.deferIds),
                timestamp,
                id,
                m,
              ),
          ],
        );
      } else if (b.action === 'approve' || b.action === 'reject') {
        if (typeof b.proposalId !== 'string')
          throw new Error('제안을 선택해주세요.');
        const proposal = await db
          .prepare('SELECT * FROM sprint_proposals WHERE owner=? AND id=?')
          .bind(id, b.proposalId)
          .first();
        if (!proposal || proposal.status !== 'pending')
          throw new Error('대기 중인 제안이 아닙니다.');
        if (Number(proposal.base_revision) !== s.revision) throw new Conflict();
        const ids = JSON.parse(String(proposal.defer_ids)) as number[];
        if (b.action === 'approve') {
          if (
            ids.some(
              (taskId) =>
                !s.tasks.some(
                  (t) =>
                    t.id === taskId && t.optional && !t.done && !t.deferred,
                ),
            )
          )
            throw new Error('제안의 업무 상태가 바뀌었습니다.');
          s.tasks = s.tasks.map((t) =>
            ids.includes(t.id) ? { ...t, deferred: true } : t,
          );
          if (!schedule(s).feasible)
            throw new Error(
              '현재 시점에는 이 복구안으로 마감을 지킬 수 없습니다. 다시 계산해주세요.',
            );
        }
        await save(
          id,
          s,
          b.action,
          b.action === 'approve'
            ? `다음 스프린트로 이동: ${ids.join(', ')}`
            : '복구안 거절',
          (m) => [
            db
              .prepare(
                'UPDATE sprint_proposals SET status=? WHERE owner=? AND id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
              )
              .bind(
                b.action === 'approve' ? 'approved' : 'rejected',
                id,
                b.proposalId,
                id,
                m,
              ),
          ],
        );
      } else if (b.action === 'finish') {
        const checkin = await db
          .prepare('SELECT id FROM sprint_checkins WHERE owner=? LIMIT 1')
          .bind(id)
          .first();
        if (
          !s.tasks.some((t) => !t.deferred) ||
          !checkin ||
          s.tasks.some(
            (t) => !t.deferred && (!t.done || t.evidence.trim().length < 5),
          )
        )
          throw new Error('체크인과 모든 필수 결과물 확인을 마쳐주세요.');
        if (Date.now() > Date.parse(s.deadline))
          throw new Error(
            '마감이 지난 스프린트입니다. 기한 내 완주로 처리할 수 없습니다.',
          );
        s.finished = true;
        await save(
          id,
          s,
          'finish',
          '기한 내 결과물 확인 완료 · 금전 환급은 운영자 검토 전',
        );
      } else throw new Error('지원하지 않는 작업입니다.');
    }
    return reply(await projectState(id, user));
  } catch (error) {
    if (error instanceof AccessError)
      return reply({ error: error.message }, error.status);
    if (error instanceof Conflict)
      return reply(
        {
          error:
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
