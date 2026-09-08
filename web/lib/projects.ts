import {
  database,
  Conflict,
  readSprint,
  save,
  responseState,
} from './sprint-store';
import { dateInSeoul, dates } from './sprint';
export class AccessError extends Error {
  constructor(
    message = '프로젝트에 접근할 권한이 없습니다.',
    public status = 403,
  ) {
    super(message);
  }
}
export type Identity = { id: string; email: string; name: string };
export function identity(request: Request): Identity | null {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) return null;
  const email = (request.headers.get('oai-authenticated-user-email') ?? '')
    .trim()
    .toLowerCase();
  let name = request.headers.get('oai-authenticated-user-full-name') ?? '';
  if (
    request.headers.get('oai-authenticated-user-full-name-encoding') ===
    'percent-encoded-utf-8'
  ) {
    try {
      name = decodeURIComponent(name);
    } catch {
      name = '';
    }
  }
  return {
    id,
    email,
    name: (name || email.split('@')[0] || '팀원').slice(0, 60),
  };
}
export async function adoptLegacy(user: Identity) {
  // Only the identity that owns a v2 row can import it. Never copy another user's data.
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
        "INSERT OR IGNORE INTO project_details(project_id,created_by,goal,deliverables,completion_criteria,legacy,created_at) VALUES(?,?,'기존 샘플 프로젝트','[\"핵심 사용자 흐름\"]','기존 결과물 확인 기준',1,?)",
      )
      .bind(user.id, user.id, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO project_members(project_id,user_id,display_name,role,person,agreed_at,joined_at) VALUES(?,?,?,'owner',0,?,?)",
      )
      .bind(user.id, user.id, user.name, existing.joined ? now : null, now),
  ]);
}
export async function member(project: string, user: Identity) {
  const row = await database()
    .prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?')
    .bind(project, user.id)
    .first<{
      project_id: string;
      user_id: string;
      display_name: string;
      role: string;
      person: number;
      agreed_at: string | null;
    }>();
  if (!row) throw new AccessError();
  return row;
}
export async function listProjects(user: Identity) {
  await adoptLegacy(user);
  const result = await database()
    .prepare(
      'SELECT s.owner AS id,s.title,s.start_date,s.deadline,s.revision,m.role FROM sprints s JOIN project_members m ON m.project_id=s.owner WHERE m.user_id=? ORDER BY s.updated_at DESC,s.owner',
    )
    .bind(user.id)
    .all<{
      id: string;
      title: string;
      start_date: string;
      deadline: string;
      revision: number;
      role: string;
    }>();
  return result.results;
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
        'SELECT display_name,role,person,agreed_at,joined_at FROM project_members WHERE project_id=? ORDER BY person',
      )
      .bind(project),
    db
      .prepare(
        "SELECT id,email,expires_at,status FROM project_invites WHERE project_id=? AND ?='owner' ORDER BY created_at DESC LIMIT 20",
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
      name: me.display_name,
    },
    details: details.results[0],
    members: members.results,
    invites: invites.results,
  };
}
export function textField(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label}: 1~${max}자로 입력해주세요.`);
  return value.trim();
}
export function projectInput(b: Record<string, unknown>, now = new Date()) {
  const title = textField(b.title, '프로젝트 이름', 100);
  const goal = textField(b.goal, '목표', 1000);
  const completion = textField(b.completionCriteria, '완료 기준', 2000);
  if (typeof b.deliverables !== 'string')
    throw new Error('필수 결과물을 입력해주세요.');
  const deliverables = b.deliverables
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !deliverables.length ||
    deliverables.length > 10 ||
    deliverables.some((s) => s.length > 200)
  )
    throw new Error('필수 결과물은 항목당 200자 이내, 1~10개입니다.');
  const start = String(b.startDate);
  const duration = b.duration;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    ![7, 8, 9, 10].includes(Number(duration)) ||
    typeof duration !== 'number'
  )
    throw new Error('시작 날짜와 7~10일 기간을 선택해주세요.');
  const day = new Date(start + 'T00:00:00Z');
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== start ||
    start < dateInSeoul(now)
  )
    throw new Error('시작일은 오늘 이후의 유효한 날짜여야 합니다.');
  day.setUTCDate(day.getUTCDate() + duration - 1);
  const end = day.toISOString().slice(0, 10);
  return {
    title,
    goal,
    completion,
    deliverables,
    start,
    deadline: end + 'T18:00:00+09:00',
  };
}
export async function createProject(
  user: Identity,
  b: Record<string, unknown>,
) {
  const v = projectInput(b);
  if (b.agreed !== true) throw new Error('목표와 완료 기준을 확인해주세요.');
  const id = 'p_' + crypto.randomUUID();
  const db = database();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO sprints(owner,title,start_date,deadline,joined,updated_at) VALUES(?,?,?,?,1,?)',
      )
      .bind(id, v.title, v.start, v.deadline, now),
    db
      .prepare(
        'INSERT INTO project_details(project_id,created_by,goal,deliverables,completion_criteria,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        id,
        user.id,
        v.goal,
        JSON.stringify(v.deliverables),
        v.completion,
        now,
      ),
    db
      .prepare(
        "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,joined_at) VALUES(?,?,?,'owner',0,?,?)",
      )
      .bind(id, user.id, user.name, now, now),
    ...dates(v.start, v.deadline.slice(0, 10)).map((date) =>
      db
        .prepare(
          'INSERT INTO sprint_capacity(owner,person,date,hours) VALUES(?,0,?,0)',
        )
        .bind(id, date),
    ),
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
) {
  const me = await member(project, user);
  if (me.role !== 'owner')
    throw new AccessError('초대 링크는 팀장만 만들 수 있습니다.');
  if (
    typeof email !== 'string' ||
    !/^\S+@\S+\.\S+$/.test(email) ||
    email.length > 254
  )
    throw new Error('팀원의 로그인 이메일을 입력해주세요.');
  email = email.trim().toLowerCase();
  const s = await readSprint(project);
  if (!s || s.finished)
    throw new Error('종료된 프로젝트에는 초대할 수 없습니다.');
  if (s.revision !== revision) throw new Conflict();
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
          'INSERT INTO project_invites(id,project_id,token_hash,email,expires_at,created_by,created_at) SELECT ?,owner,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
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
  );
  return { token, expiresAt: expires, id };
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
    String(invite.expires_at) <= new Date().toISOString()
  )
    throw new AccessError('만료되었거나 이미 처리된 초대입니다.', 410);
  const details = await database()
    .prepare(
      'SELECT s.title,s.deadline,s.finished,d.goal,d.deliverables,d.completion_criteria FROM sprints s JOIN project_details d ON d.project_id=s.owner WHERE s.owner=?',
    )
    .bind(invite.project_id)
    .first();
  if (!details || details.finished)
    throw new AccessError('종료된 프로젝트입니다.', 410);
  return { invite, details };
}
export async function acceptInvite(
  user: Identity,
  token: string,
  agreed: unknown,
) {
  if (agreed !== true)
    throw new Error('프로젝트 목표와 완료 기준을 확인해주세요.');
  const { invite } = await inspectInvite(user, token);
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
  if (!s) throw new AccessError();
  const rows = await db
    .prepare(
      'SELECT person FROM project_members WHERE project_id=? ORDER BY person',
    )
    .bind(project)
    .all<{ person: number }>();
  if (rows.results.length >= 4) throw new Error('팀은 최대 4명입니다.');
  const person = [0, 1, 2, 3].find(
    (i) => !rows.results.some((r) => r.person === i),
  )!;
  const now = new Date().toISOString();
  if (String(invite.expires_at) <= now)
    throw new AccessError('만료된 초대입니다.', 410);
  await save(
    project,
    s,
    'accept_invite',
    `${user.name} · 초대 수락 및 목표 확인`,
    (m) => [
      db
        .prepare(
          "UPDATE project_invites SET status='accepted',accepted_by=? WHERE id=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
        )
        .bind(user.id, invite.id, now, project, m),
      db
        .prepare(
          "INSERT INTO project_members(project_id,user_id,display_name,role,person,agreed_at,joined_at) SELECT owner,?,?,'member',?,?,? FROM sprints WHERE owner=? AND mutation=? AND EXISTS(SELECT 1 FROM project_invites WHERE id=? AND status='accepted' AND accepted_by=?)",
        )
        .bind(
          user.id,
          user.name,
          person,
          now,
          now,
          project,
          m,
          invite.id,
          user.id,
        ),
      ...dates(s.startDate, s.deadline.slice(0, 10)).map((date) =>
        db
          .prepare(
            'INSERT INTO sprint_capacity(owner,person,date,hours) SELECT owner,?,?,0 FROM sprints WHERE owner=? AND mutation=? ON CONFLICT(owner,person,date) DO UPDATE SET hours=0',
          )
          .bind(person, date, project, m),
      ),
    ],
  );
  return project;
}
