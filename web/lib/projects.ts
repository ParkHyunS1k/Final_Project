import {
  database,
  Conflict,
  readSprint,
  readPolicy,
  readMembers,
  readDeliverables,
  save,
  responseState,
} from './sprint-store';
import {
  assertDuration,
  assertProjectMutationAllowed,
  deadlineFrom,
  effectiveLifecycle,
  MAX_MEMBERS,
  PolicyError,
  startReadiness,
  type Actor,
} from './sprint-policy';
import { assertEvidence, parseDeliverables } from './deliverables';
import { scheduleStatements } from './reminder-store';
/** 화면에서 확인한 목표와 저장 시점의 목표가 다를 때. 최신 내용을 함께 돌려준다. */
export class GoalChanged extends Error {
  details: unknown;
  status = 409;
  constructor(details: unknown) {
    super('목표가 바뀌었습니다. 최신 목표와 완료 기준을 확인한 뒤 다시 수락해주세요.');
    this.details = details;
  }
}
export class AccessError extends Error {
  constructor(
    message = '프로젝트에 접근할 권한이 없습니다.',
    public status = 403,
  ) {
    super(message);
  }
}
import type { Identity } from './auth';
import { DAILY_INVITE_LIMIT, deliverInvite, INVITE_SEND_LIMIT } from './invite-email';
export { identity, AuthUnavailable, type Identity } from './auth';
export async function adoptLegacy(user: Identity) {
  // Only the identity that owns a v2 row can import it. Never copy another user's data.
  // 이전 규칙 기록이므로 project_policy 행을 만들지 않는다. 열람·내보내기만 가능하다.
  const db = database();
  const existing = await db
    .prepare('SELECT owner,joined FROM sprints WHERE owner=?')
    .bind(user.id)
    .first();
  if (!existing) return;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_details(project_id,created_by,goal,deliverables,completion_criteria,legacy,created_at) VALUES(?,?,'기존 샘플 프로젝트','[\"핵심 사용자 흐름\"]','기존 결과물 확인 기준',true,?) ON CONFLICT DO NOTHING",
      )
      .bind(user.id, user.id, now),
    db
      .prepare(
        "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,joined_at,email) VALUES(?,?,?,'owner',0,?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(
        user.id,
        user.id,
        user.name,
        existing.joined ? now : null,
        now,
        user.email || null,
      ),
  ]);
}
export type MemberRow = {
  project_id: string;
  user_id: string;
  display_name: string;
  role: string;
  person: number;
  agreed_at: Date | null;
  agreed_goal_version: number;
  email: string | null;
  left_at: Date | null;
  left_note: string;
};
export async function member(project: string, user: Identity) {
  const row = await database()
    .prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?')
    .bind(project, user.id)
    .first<MemberRow>();
  if (!row) throw new AccessError();
  // 인증 계층이 준 주소만 연락처로 승격한다. 초대 주소·요청 본문 주소는 쓰지 않는다.
  if (user.email && row.email !== user.email) {
    await database()
      .prepare(
        'UPDATE project_members SET email=? WHERE project_id=? AND user_id=?',
      )
      .bind(user.email, project, user.id)
      .run();
    row.email = user.email;
  }
  return row;
}
export function actorOf(row: MemberRow): Actor {
  return {
    userId: row.user_id,
    role: row.role,
    person: row.person,
    agreedGoalVersion: Number(row.agreed_goal_version),
    leftAt: row.left_at,
  };
}
export async function listProjects(user: Identity) {
  await adoptLegacy(user);
  const result = await database()
    .prepare(
      'SELECT s.owner AS id,s.title,s.revision,m.role,p.lifecycle,p.started_at,p.deadline_at,p.duration_days FROM sprints s JOIN project_members m ON m.project_id=s.owner LEFT JOIN project_policy p ON p.project_id=s.owner WHERE m.user_id=? ORDER BY s.updated_at DESC,s.owner',
    )
    .bind(user.id)
    .all<{
      id: string;
      title: string;
      revision: number;
      role: string;
      lifecycle: string | null;
      started_at: Date | null;
      deadline_at: Date | null;
      duration_days: number | null;
    }>();
  const now = new Date();
  return result.results.map((r) => ({
    ...r,
    lifecycle: r.lifecycle
      ? effectiveLifecycle(
          {
            projectId: r.id,
            lifecycle: r.lifecycle as 'active',
            goalVersion: 0,
            durationDays: Number(r.duration_days ?? 0),
            dailyHours: 8,
            startedAt: r.started_at,
            deadlineAt: r.deadline_at,
            completedAt: null,
          },
          now,
        )
      : 'legacy',
  }));
}
export async function projectState(project: string, user: Identity) {
  const me = await member(project, user);
  const db = database();
  const [details, members, invites] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT goal,deliverables,completion_criteria,legacy FROM project_details WHERE project_id=?',
      )
      .bind(project),
    db
      .prepare(
        'SELECT display_name,role,person,agreed_at,agreed_goal_version,joined_at,left_at,left_note FROM project_members WHERE project_id=? ORDER BY person',
      )
      .bind(project),
    db
      .prepare(
        "SELECT id,email,expires_at,status,email_status,email_sent_at,email_sends FROM project_invites WHERE project_id=? AND ?='owner' ORDER BY created_at DESC LIMIT 20",
      )
      .bind(project, me.role),
  ]);
  return {
    ...(await responseState(project)),
    projectId: project,
    me: {
      role: me.role,
      person: me.person,
      agreedAt: me.agreed_at,
      agreedGoalVersion: Number(me.agreed_goal_version),
      leftAt: me.left_at,
      name: me.display_name,
    },
    details: details.results[0],
    members: members.results,
    invites: invites.results,
  };
}
// 멤버만 읽는 내보내기. 다른 멤버의 이메일·인증 정보는 포함하지 않는다.
export async function exportProject(project: string, user: Identity) {
  await member(project, user);
  const db = database();
  const state = await responseState(project);
  const [members, events, checkins] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT display_name,role,person,joined_at,left_at,left_note FROM project_members WHERE project_id=? ORDER BY person',
      )
      .bind(project),
    db
      .prepare(
        'SELECT revision,action,detail,created_at FROM sprint_events WHERE owner=? ORDER BY revision',
      )
      .bind(project),
    db
      .prepare(
        'SELECT task_id,note,remaining,created_at FROM sprint_checkins WHERE owner=? ORDER BY created_at',
      )
      .bind(project),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    projectId: project,
    lifecycle: state.lifecycle,
    policy: state.policy,
    agreement: state.agreement,
    deliverables: state.deliverables,
    tasks: state.sprint.tasks,
    members: members.results,
    checkins: checkins.results,
    events: events.results,
  };
}
export function textField(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label}: 1~${max}자로 입력해주세요.`);
  return value.trim();
}
export function goalInput(b: Record<string, unknown>) {
  return {
    title: textField(b.title, '프로젝트 이름', 100),
    goal: textField(b.goal, '목표', 1000),
    scope: textField(b.scope, '기능 범위', 2000),
    completion: textField(b.completionCriteria, '완료 기준', 2000),
    deliverables: parseDeliverables(b.deliverables),
    duration: assertDuration(b.duration),
  };
}
function deliverableStatements(
  project: string,
  mutation: string | null,
  titles: string[],
) {
  const db = database();
  const gate = mutation
    ? ' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)'
    : '';
  const args = mutation ? [project, mutation] : [];
  return [
    db
      .prepare(
        'DELETE FROM project_deliverables WHERE project_id=? AND fixed_at IS NULL' +
          gate,
      )
      .bind(project, ...args),
    ...titles.map((title, i) =>
      db
        .prepare(
          'INSERT INTO project_deliverables(project_id,deliverable_id,position,title) VALUES(?,?,?,?)',
        )
        .bind(project, 'd_' + crypto.randomUUID(), i, title),
    ),
  ];
}
// 생성은 준비(draft) 상태로 저장한다. 시작 시각·최종 기한은 아직 없다.
export async function createProject(
  user: Identity,
  b: Record<string, unknown>,
) {
  const v = goalInput(b);
  if (b.agreed !== true) throw new Error('목표와 완료 기준을 확인해주세요.');
  const id = 'p_' + crypto.randomUUID();
  const db = database();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO sprints(owner,title,start_date,deadline,joined,updated_at) VALUES(?,?,NULL,NULL,false,?)",
      )
      .bind(id, v.title, now),
    db
      .prepare(
        'INSERT INTO project_details(project_id,created_by,goal,deliverables,completion_criteria,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        id,
        user.id,
        v.goal,
        v.deliverables,
        v.completion,
        now,
      ),
    db
      .prepare(
        'INSERT INTO project_policy(project_id,lifecycle,goal_version,duration_days,created_at) VALUES(?,?,1,?,?)',
      )
      .bind(id, 'draft', v.duration, now),
    db
      .prepare(
        'INSERT INTO project_agreement(project_id,goal_version,title,goal,scope,completion_criteria,fixed_at) VALUES(?,1,?,?,?,?,?)',
      )
      .bind(id, v.title, v.goal, v.scope, v.completion, null),
    db
      .prepare(
        "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,agreed_goal_version,joined_at,email) VALUES(?,?,?,'owner',0,?,1,?,?)",
      )
      .bind(id, user.id, user.name, now, now, user.email || null),
    ...deliverableStatements(id, null, v.deliverables),
  ]);
  return id;
}
export async function tokenHash(token: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function createInvite(
  project: string,
  user: Identity,
  revision: number,
  email: unknown,
  origin: string,
) {
  const me = await member(project, user);
  const policy = await readPolicy(project);
  assertProjectMutationAllowed({
    policy,
    actor: actorOf(me),
    action: 'invite',
    now: new Date(),
  });
  if (
    typeof email !== 'string' ||
    // 주소 하나만. 쉼표·세미콜론·꺾쇠·공백이 있으면 메일 라이브러리가 여러 수신자로 읽는다.
    !/^[^\s@,;<>"'()[\]\\]+@[^\s@,;<>"'()[\]\\]+\.[^\s@,;<>"'()[\]\\]+$/.test(email.trim()) ||
    email.length > 254
  )
    throw new Error('팀원의 로그인 이메일을 입력해주세요.');
  email = email.trim().toLowerCase();
  const s = await readSprint(project);
  if (!s) throw new AccessError();
  if (s.revision !== revision) throw new Conflict();
  // 공개 주소라 누구나 프로젝트를 만들 수 있다. 우리 Gmail이 스팸 발송에 쓰이지 않게 사용자당 하루(KST) 초대 수를 묶는다.
  // 한 문장의 upsert는 행 잠금으로 동시 요청을 줄 세운다. 다른 검사를 다 통과한 뒤에 쓴다(저장이 충돌로 실패해도 한 칸은 쓴 것으로 남는다).
  const quota = await database()
    .prepare(
      "INSERT INTO invite_quota(user_id,day,n) VALUES(?,(now() AT TIME ZONE 'Asia/Seoul')::date,1) ON CONFLICT (user_id,day) DO UPDATE SET n=invite_quota.n+1 WHERE invite_quota.n < ? RETURNING n",
    )
    .bind(user.id, DAILY_INVITE_LIMIT)
    .first();
  if (!quota)
    throw new AccessError(`초대는 하루 ${DAILY_INVITE_LIMIT}개까지 만들 수 있습니다(한국 시간 0시에 초기화).`, 429);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await tokenHash(token);
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await save(
    project,
    s,
    'invite',
    `${me.display_name} · 초대 링크 생성`,
    (m) => [
      database()
        .prepare(
          'INSERT INTO project_invites(id,project_id,token_hash,email,expires_at,created_by,created_at,email_sends,email_sent_at) SELECT ?,owner,?,?,?,?,?,1,now() FROM sprints WHERE owner=? AND mutation=?',
        )
        .bind(
          id,
          hash,
          email,
          expires,
          user.id,
          new Date().toISOString(),
          project,
          m,
        ),
    ],
    ['draft', 'active'],
  );
  const mail = await deliverInvite({
    inviteId: id,
    sends: 1,
    to: email as string,
    token,
    origin,
    projectTitle: s.title,
    inviter: me.display_name,
    expiresAt: new Date(expires),
  });
  return { token, expiresAt: expires, id, email: mail };
}
/** 같은 초대에 새 링크를 발급해 다시 보낸다. 이전 링크는 즉시 무효. 한도는 저장 트랜잭션의 조건으로 지킨다. */
export async function resendInvite(
  project: string,
  user: Identity,
  revision: number,
  inviteId: unknown,
  origin: string,
) {
  const me = await member(project, user);
  assertProjectMutationAllowed({
    policy: await readPolicy(project),
    actor: actorOf(me),
    action: 'resendInvite',
    now: new Date(),
  });
  if (typeof inviteId !== 'string') throw new Error('다시 보낼 초대를 선택해주세요.');
  const invite = await database()
    .prepare('SELECT email,status,email_sends,email_sent_at FROM project_invites WHERE project_id=? AND id=?')
    .bind(project, inviteId)
    .first<{ email: string; status: string; email_sends: number; email_sent_at: Date | null }>();
  if (!invite) throw new AccessError('초대를 찾을 수 없습니다.', 404);
  if (invite.status !== 'pending') throw new Error('대기 중인 초대만 다시 보낼 수 있습니다.');
  if (invite.email_sends >= INVITE_SEND_LIMIT)
    throw new AccessError(`초대 메일은 ${INVITE_SEND_LIMIT}번까지 보낼 수 있습니다. 링크를 직접 전달해주세요.`, 429);
  if (invite.email_sent_at && Date.now() - invite.email_sent_at.getTime() < 60_000)
    throw new AccessError('1분 뒤에 다시 보낼 수 있습니다.', 429);
  const s = await readSprint(project);
  if (!s) throw new AccessError();
  if (s.revision !== revision) throw new Conflict();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await tokenHash(token);
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await save(
    project,
    s,
    'resend_invite',
    `${me.display_name} · 초대 링크 다시 발급`,
    (m) => [
      database()
        .prepare(
          "UPDATE project_invites SET token_hash=?,expires_at=?,email_sends=email_sends+1,email_sent_at=now(),email_status=NULL WHERE project_id=? AND id=? AND status='pending' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
        )
        .bind(hash, expires, project, inviteId, project, m),
    ],
    ['draft', 'active'],
    // 읽은 뒤 저장 사이에 한도가 바뀌었으면 아무것도 쓰지 않는다(409).
    {
      sql: "EXISTS(SELECT 1 FROM project_invites i WHERE i.project_id=sprints.owner AND i.id=? AND i.status='pending' AND i.email_sends<? AND (i.email_sent_at IS NULL OR i.email_sent_at < now() - interval '1 minute'))",
      args: [inviteId, INVITE_SEND_LIMIT],
    },
  );
  const mail = await deliverInvite({
    inviteId,
    sends: invite.email_sends + 1,
    to: invite.email,
    token,
    origin,
    projectTitle: s.title,
    inviter: me.display_name,
    expiresAt: new Date(expires),
  });
  return { token, expiresAt: expires, id: inviteId, email: mail };
}
export async function inspectInvite(user: Identity, token: string) {
  if (!/^[a-f0-9-]{72}$/.test(token))
    throw new AccessError('초대 링크가 유효하지 않습니다.', 404);
  const invite = await database()
    .prepare('SELECT * FROM project_invites WHERE token_hash=?')
    .bind(await tokenHash(token))
    .first<Record<string, unknown>>();
  if (!invite || invite.email !== user.email)
    throw new AccessError('초대받은 이메일의 계정으로 로그인해주세요.');
  if (
    invite.status !== 'pending' ||
    (invite.expires_at as Date).getTime() <= Date.now()
  )
    throw new AccessError('만료되었거나 이미 처리된 초대입니다.', 410);
  const project = String(invite.project_id);
  const policy = await readPolicy(project);
  const state = effectiveLifecycle(policy, new Date());
  if (state !== 'draft' && state !== 'active')
    throw new AccessError('참여할 수 없는 프로젝트입니다.', 410);
  const details = await database()
    .prepare(
      'SELECT s.title,a.goal,a.scope,a.completion_criteria,p.goal_version,p.lifecycle,p.deadline_at,p.duration_days FROM sprints s JOIN project_policy p ON p.project_id=s.owner LEFT JOIN project_agreement a ON a.project_id=s.owner WHERE s.owner=?',
    )
    .bind(project)
    .first();
  const deliverables = (await readDeliverables(project)).map((d) => d.title);
  return { invite, details: { ...details, deliverables } };
}
export async function acceptInvite(
  user: Identity,
  token: string,
  agreed: unknown,
  confirmedGoalVersion: unknown,
) {
  if (agreed !== true)
    throw new Error('프로젝트 목표와 완료 기준을 확인해주세요.');
  // 사용자가 화면에서 실제로 확인한 목표 버전을 받는다.
  // 누락된 값을 현재 버전으로 대신 채우지 않는다.
  if (!Number.isInteger(confirmedGoalVersion))
    throw new Error('확인한 목표 버전을 함께 보내주세요.');
  const { invite, details } = await inspectInvite(user, token);
  const project = String(invite.project_id);
  const db = database();
  const already = await db
    .prepare(
      'SELECT user_id FROM project_members WHERE project_id=? AND user_id=?',
    )
    .bind(project, user.id)
    .first();
  if (already) return project;
  const s = await readSprint(project);
  const policy = await readPolicy(project);
  if (!s || !policy) throw new AccessError();
  // 확인한 버전과 지금 저장하려는 버전이 다르면 최신 목표를 다시 보여준다.
  if (policy.goalVersion !== confirmedGoalVersion) throw new GoalChanged(details);
  const rows = await readMembers(project);
  if (rows.length >= MAX_MEMBERS)
    throw new Error(`팀은 최대 ${MAX_MEMBERS}명입니다.`);
  const person = [...Array(MAX_MEMBERS).keys()].find(
    (i) => !rows.some((r) => r.person === i),
  )!;
  const now = new Date().toISOString();
  if ((invite.expires_at as Date).getTime() <= Date.now())
    throw new AccessError('만료된 초대입니다.', 410);
  await save(
    project,
    s,
    'accept_invite',
    `${user.name} · 초대 수락 및 목표 v${policy.goalVersion} 확인`,
    (m) => [
      db
        .prepare(
          "UPDATE project_invites SET status='accepted',accepted_by=? WHERE id=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
        )
        .bind(user.id, invite.id, now, project, m),
      db
        .prepare(
          "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,agreed_goal_version,joined_at,email) SELECT owner,?,?,'member',?,?,?,?,? FROM sprints WHERE owner=? AND mutation=? AND EXISTS(SELECT 1 FROM project_invites WHERE id=? AND status='accepted' AND accepted_by=?)",
        )
        .bind(
          user.id,
          user.name,
          person,
          now,
          policy.goalVersion,
          now,
          user.email || null,
          project,
          m,
          invite.id,
          user.id,
        ),
      // 진행 중 프로젝트에 합류하면 남은 프로젝트 알림 단계만 예약한다.
      ...(policy.deadlineAt
        ? scheduleStatements(
            project,
            m,
            [
              {
                kind: 'project' as const,
                userId: user.id,
                deadlineVersion: 0,
                dueAt: policy.deadlineAt,
              },
            ],
            new Date(),
          )
        : []),
    ],
    ['draft', 'active'],
    // 저장 직전에 목표가 다시 바뀌면 가입·동의 기록을 남기지 않는다.
    {
      sql: 'EXISTS(SELECT 1 FROM project_policy p WHERE p.project_id=sprints.owner AND p.goal_version=?)',
      args: [policy.goalVersion],
    },
  );
  return project;
}
export { assertEvidence, parseDeliverables, startReadiness, PolicyError, deadlineFrom };
