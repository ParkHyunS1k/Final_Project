// 공개 팀 목록과 참여 신청(2026-10-15). 규칙: docs/superpowers/specs/2026-10-15-team-list-join-design.md
// 목록·신청 응답에는 다른 사용자의 ID·이메일·팀원 이름을 넣지 않는다.
import { database, readSprint, readPolicy, readMembers, save, Conflict } from './sprint-store';
import {
  assertProjectMutationAllowed,
  joinUntil,
  joinWindowOpen,
  JOIN_WINDOW_HOURS,
  MAX_MEMBERS,
  PolicyError,
  policyRow,
} from './sprint-policy';
import { scheduleStatements } from './reminder-store';
import { AccessError, GoalChanged, actorOf, member, type Identity } from './projects';

/** 한 사용자가 동시에 기다릴 수 있는 신청 수. 여러 팀에 한꺼번에 뿌리지 않게 묶는다. */
export const MAX_PENDING_REQUESTS = 5;

// 참여 창을 DB 시각으로 다시 본다(joinWindowOpen과 같은 규칙). 별칭만 바꿔 넣는다.
function windowSql(p: string) {
  return (
    `(${p}.lifecycle='draft' OR (${p}.lifecycle='active' AND ${p}.started_at > now() - interval '${JOIN_WINDOW_HOURS} hours'` +
    ` AND (${p}.deadline_at IS NULL OR ${p}.deadline_at > now())))`
  );
}
const MEMBER_COUNT = '(SELECT count(*) FROM project_members m WHERE m.project_id=s.owner)::int';

type TeamRow = {
  id: string;
  title: string;
  goal: string;
  scope: string;
  completion_criteria: string;
  members: number;
  requested: boolean;
  listed: boolean;
} & Record<string, unknown>;

function teamOf(r: TeamRow, now: Date) {
  const policy = policyRow({ ...r, project_id: r.id })!;
  const open = joinWindowOpen(policy, now);
  const members = Number(r.members);
  return {
    projectId: r.id,
    title: r.title,
    goal: r.goal,
    scope: r.scope,
    completionCriteria: r.completion_criteria,
    lifecycle: policy.lifecycle as 'draft' | 'active',
    goalVersion: policy.goalVersion,
    members,
    maxMembers: MAX_MEMBERS,
    startedAt: policy.startedAt,
    deadlineAt: policy.deadlineAt,
    joinUntil: policy.startedAt ? joinUntil(policy.startedAt) : null,
    open,
    joinable: open && members < MAX_MEMBERS && !r.requested,
    requested: Boolean(r.requested),
  };
}
const TEAM_SELECT =
  `SELECT s.owner AS id,s.title,a.goal,a.scope,a.completion_criteria,p.lifecycle,p.goal_version,p.duration_days,p.daily_hours,p.started_at,p.deadline_at,p.completed_at,p.listed,${MEMBER_COUNT} AS members,` +
  "EXISTS(SELECT 1 FROM project_join_requests r WHERE r.project_id=s.owner AND r.user_id=? AND r.status='pending') AS requested " +
  'FROM sprints s JOIN project_policy p ON p.project_id=s.owner JOIN project_agreement a ON a.project_id=s.owner ';

/** 공개 중이고 참여 창이 열린 팀. 내가 속한 팀은 뺀다. 내 최근 신청도 함께 돌려준다. */
export async function listTeams(user: Identity) {
  const db = database();
  const [teams, requests] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        TEAM_SELECT +
          `WHERE p.listed AND ${windowSql('p')} AND NOT EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=s.owner AND m.user_id=?) ORDER BY p.created_at DESC,s.owner LIMIT 50`,
      )
      .bind(user.id, user.id),
    db
      .prepare(
        'SELECT r.id,r.project_id,s.title,r.status,r.created_at,r.decided_at FROM project_join_requests r JOIN sprints s ON s.owner=r.project_id WHERE r.user_id=? ORDER BY r.created_at DESC,r.id LIMIT 20',
      )
      .bind(user.id),
  ]);
  const now = new Date();
  return {
    teams: (teams.results as TeamRow[])
      .map((r) => teamOf(r, now))
      .filter((t) => t.open)
      .map(({ open: _, ...t }) => t),
    requests: requests.results.map((r) => ({
      requestId: String(r.id),
      projectId: String(r.project_id),
      title: String(r.title),
      status: String(r.status),
      createdAt: r.created_at,
      decidedAt: r.decided_at ?? null,
    })),
  };
}

/** 목록에서 참여 신청. 프로젝트 revision을 올리지 않는다(팀장의 편집과 충돌하지 않게). */
export async function requestJoin(user: Identity, b: Record<string, unknown>) {
  if (typeof b.projectId !== 'string') throw new Error('참여할 팀을 선택해주세요.');
  if (b.agreed !== true) throw new Error('팀의 목표와 완료 기준을 확인해주세요.');
  // 화면에서 실제로 확인한 목표 버전만 받는다. 현재 버전으로 대신 채우지 않는다.
  if (!Number.isInteger(b.goalVersion)) throw new Error('확인한 목표 버전을 함께 보내주세요.');
  const project = b.projectId;
  const db = database();
  const row = await db
    .prepare(TEAM_SELECT + 'WHERE s.owner=?')
    .bind(user.id, project)
    .first<TeamRow>();
  // 비공개 팀은 존재 여부도 알리지 않는다.
  if (!row || !row.listed) throw new AccessError('참여할 수 있는 팀을 찾을 수 없습니다.', 404);
  const mine = await db
    .prepare(
      "SELECT (SELECT 1 FROM project_members WHERE project_id=? AND user_id=?) AS member,(SELECT id FROM project_join_requests WHERE project_id=? AND user_id=? AND status='pending') AS pending,(SELECT count(*) FROM project_join_requests WHERE user_id=? AND status='pending')::int AS waiting",
    )
    .bind(project, user.id, project, user.id, user.id)
    .first<{ member: number | null; pending: string | null; waiting: number }>();
  if (mine?.member) throw new Error('이미 참여 중인 팀입니다.');
  if (mine?.pending) return { requestId: mine.pending, status: 'pending' as const };
  const team = teamOf(row, new Date());
  if (!team.open)
    throw new AccessError(`시작 후 ${JOIN_WINDOW_HOURS}시간이 지났거나 끝난 팀이라 신청할 수 없습니다.`, 410);
  if (team.members >= MAX_MEMBERS) throw new Error(`팀은 최대 ${MAX_MEMBERS}명입니다.`);
  const { open: _, joinable: __, requested: ___, ...details } = team;
  if (team.goalVersion !== b.goalVersion) throw new GoalChanged(details);
  if (Number(mine?.waiting) >= MAX_PENDING_REQUESTS)
    throw new AccessError(`대기 중인 신청은 ${MAX_PENDING_REQUESTS}개까지입니다. 결과를 기다리거나 신청을 취소해주세요.`, 429);
  const id = 'jr_' + crypto.randomUUID();
  // 위 검사를 저장 시점에 한 문장의 조건으로 다시 본다. 하나라도 바뀌었으면 아무것도 쓰지 않는다.
  const inserted = await db
    .prepare(
      'INSERT INTO project_join_requests(id,project_id,user_id,display_name,email,goal_version,status,created_at) ' +
        "SELECT ?,s.owner,?,?,?,?,'pending',now() FROM sprints s JOIN project_policy p ON p.project_id=s.owner " +
        `WHERE s.owner=? AND p.listed AND p.goal_version=? AND ${windowSql('p')} AND ${MEMBER_COUNT} < ? ` +
        'AND NOT EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=s.owner AND m.user_id=?) ' +
        "AND (SELECT count(*) FROM project_join_requests w WHERE w.user_id=? AND w.status='pending') < ? " +
        'ON CONFLICT DO NOTHING RETURNING id',
    )
    .bind(
      id,
      user.id,
      user.name,
      user.email || null,
      b.goalVersion,
      project,
      b.goalVersion,
      MAX_MEMBERS,
      user.id,
      user.id,
      MAX_PENDING_REQUESTS,
    )
    .first();
  if (!inserted) throw new Conflict();
  return { requestId: id, status: 'pending' as const };
}

/** 신청자 본인이 대기 중인 신청을 취소한다. */
export async function cancelJoin(user: Identity, requestId: unknown) {
  if (typeof requestId !== 'string') throw new Error('취소할 신청을 선택해주세요.');
  const r = await database()
    .prepare(
      "UPDATE project_join_requests SET status='cancelled',decided_at=now(),decided_by=? WHERE id=? AND user_id=? AND status='pending'",
    )
    .bind(user.id, requestId, user.id)
    .run();
  if (r.meta.changes !== 1) throw new AccessError('취소할 수 있는 신청이 없습니다.', 404);
}

/** 팀장이 목록 공개를 켜고 끈다. 이미 들어온 신청은 그대로 남는다. */
export async function setListed(project: string, user: Identity, revision: number, listed: unknown) {
  if (typeof listed !== 'boolean') throw new Error('공개 여부를 선택해주세요.');
  const me = await member(project, user);
  assertProjectMutationAllowed({
    policy: await readPolicy(project),
    actor: actorOf(me),
    action: 'setListed',
    now: new Date(),
  });
  const s = await readSprint(project);
  if (!s) throw new AccessError();
  if (s.revision !== revision) throw new Conflict();
  await save(
    project,
    s,
    'set_listed',
    `${me.display_name} · 팀 목록 ${listed ? '공개' : '비공개'}`,
    (m) => [
      database()
        .prepare(
          'UPDATE project_policy SET listed=? WHERE project_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
        )
        .bind(listed, project, project, m),
    ],
    ['draft', 'active'],
  );
}

/** 팀장이 참여 신청을 승인하거나 거절한다. 승인은 신청 상태 변경과 멤버 추가를 한 트랜잭션으로 한다. */
export async function decideJoin(
  project: string,
  user: Identity,
  revision: number,
  requestId: unknown,
  approve: unknown,
) {
  if (typeof requestId !== 'string') throw new Error('처리할 신청을 선택해주세요.');
  if (typeof approve !== 'boolean') throw new Error('승인 또는 거절을 선택해주세요.');
  const me = await member(project, user);
  const policy = await readPolicy(project);
  const now = new Date();
  assertProjectMutationAllowed({ policy, actor: actorOf(me), action: 'decideJoin', now });
  const db = database();
  const req = await db
    .prepare('SELECT * FROM project_join_requests WHERE id=? AND project_id=?')
    .bind(requestId, project)
    .first<{ user_id: string; display_name: string; email: string | null; goal_version: number; status: string; created_at: Date }>();
  if (!req) throw new AccessError('신청을 찾을 수 없습니다.', 404);
  if (req.status !== 'pending') throw new PolicyError('이미 처리된 신청입니다.', 409);
  const s = await readSprint(project);
  if (!s || !policy) throw new AccessError();
  if (s.revision !== revision) throw new Conflict();
  const decided = (m: string, status: 'approved' | 'rejected') =>
    db
      .prepare(
        "UPDATE project_join_requests SET status=?,decided_at=now(),decided_by=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
      )
      .bind(status, user.id, requestId, project, m);
  const pending = {
    sql: "EXISTS(SELECT 1 FROM project_join_requests r WHERE r.id=? AND r.project_id=sprints.owner AND r.status='pending')",
    args: [requestId] as unknown[],
  };
  if (!approve) {
    await save(project, s, 'reject_join', `${me.display_name} · 참여 신청 거절: ${req.display_name}`, (m) => [decided(m, 'rejected')], ['draft', 'active'], pending);
    return;
  }
  if (!joinWindowOpen(policy, now))
    throw new PolicyError(`시작 후 ${JOIN_WINDOW_HOURS}시간이 지나 목록 신청은 승인할 수 없습니다. 이메일 초대를 이용해주세요.`, 410);
  const rows = await readMembers(project);
  if (rows.some((r) => r.userId === req.user_id)) throw new PolicyError('이미 팀원입니다. 신청은 거절로 정리해주세요.', 409);
  if (rows.length >= MAX_MEMBERS) throw new PolicyError(`팀은 최대 ${MAX_MEMBERS}명입니다.`);
  const person = [...Array(MAX_MEMBERS).keys()].find((i) => !rows.some((r) => r.person === i))!;
  await save(
    project,
    s,
    'approve_join',
    `${me.display_name} · 참여 신청 승인: ${req.display_name}(목표 v${req.goal_version} 확인)`,
    (m) => [
      decided(m, 'approved'),
      // 신청 때 확인한 목표 버전으로 가입한다. 그 뒤 목표가 바뀌었으면 기존 재동의 흐름을 거친다.
      db
        .prepare(
          "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,agreed_goal_version,joined_at,email) SELECT owner,?,?,'member',?,?,?,now(),? FROM sprints WHERE owner=? AND mutation=? AND EXISTS(SELECT 1 FROM project_join_requests WHERE id=? AND status='approved')",
        )
        .bind(req.user_id, req.display_name, person, req.created_at, req.goal_version, req.email, project, m, requestId),
      // 진행 중 합류는 초대 수락과 같이 남은 프로젝트 알림 단계만 예약한다.
      ...(policy.deadlineAt
        ? scheduleStatements(project, m, [{ kind: 'project' as const, userId: req.user_id, deadlineVersion: 0, dueAt: policy.deadlineAt }], now)
        : []),
    ],
    ['draft', 'active'],
    // 읽은 뒤 저장 사이에 인원·참여 창·멤버 여부가 바뀌었으면 아무것도 쓰지 않는다(409).
    {
      sql:
        pending.sql +
        ' AND (SELECT count(*) FROM project_members m WHERE m.project_id=sprints.owner) < ?' +
        ' AND NOT EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=sprints.owner AND m.user_id=?)' +
        ` AND EXISTS(SELECT 1 FROM project_policy p WHERE p.project_id=sprints.owner AND ${windowSql('p')})`,
      args: [requestId, MAX_MEMBERS, req.user_id],
    },
  );
}
