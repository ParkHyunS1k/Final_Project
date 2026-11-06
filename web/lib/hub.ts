import { database, readPolicy, readSprint } from './sprint-store';
import {
  createProject,
  createInvite,
  listProjects,
  member,
  actorOf,
} from './projects';
import { assertProjectMutationAllowed } from './sprint-policy';
import type { Identity } from './auth';
import {
  templateById,
  scopedTemplate,
  type ProjectTemplate,
} from './career/catalog';
import {
  CareerError,
  textInput,
  skillIds,
  recommendations,
  gapsFor,
} from './career/profile';
import { readProfile, readExperiences, experienceSkills } from './career/store';
import { dateInSeoul } from './sprint';
import { setListed } from './teams';
import { assertNotRestricted } from './sanction';

export type HubRecord = {
  id: string;
  kind: 'portfolio' | 'job' | 'checkin';
  payload: {
    title?: string;
    url?: string;
    text?: string;
    status?: string;
    skills?: string[];
  };
  created_at: Date;
};
export function safeLink(value: unknown) {
  const raw = textInput(value ?? '', '주소', 0, 2000);
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CareerError('https://로 시작하는 주소를 입력해주세요.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new CareerError('인증 정보가 없는 HTTPS 주소만 저장할 수 있습니다.');
  return url.href;
}
// 학습 기록: '공부함' 체크인 날짜 수와 연속 일수만 센다. 등급·뱃지는 동료평가 하나로 통일해 여기서는 점수·레벨·배지를 만들지 않는다(2026-11-07).
export function learningStats(records: HubRecord[], now = new Date()) {
  const days = new Set(
    records
      .filter((r) => r.kind === 'checkin' && r.payload.status === 'studied')
      .map((r) => r.id.slice('checkin:'.length)),
  );
  const cursor = new Date(dateInSeoul(now) + 'T00:00:00Z');
  if (!days.has(cursor.toISOString().slice(0, 10)))
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return {
    streak,
    days: days.size,
    today:
      records.find((r) => r.id === 'checkin:' + dateInSeoul(now))?.payload
        .status ?? '',
  };
}
export async function readHub(user: Identity) {
  const db = database();
  const [profile, experiences, projects, records, directory, interests] =
    await Promise.all([
      readProfile(user.id),
      readExperiences(user.id),
      listProjects(user),
      db
        .prepare(
          'SELECT id,kind,payload,created_at FROM hub_records WHERE user_id=? ORDER BY created_at DESC',
        )
        .bind(user.id)
        .all<HubRecord>(),
      db
        .prepare(`SELECT p.project_id,s.title,d.goal,h.template,h.scope_level,p.lifecycle,p.started_at,p.deadline_at,
      (SELECT count(*)::int FROM project_members m WHERE m.project_id=p.project_id AND m.left_at IS NULL) AS members,
      EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.project_id AND m.user_id=? AND m.left_at IS NULL) AS joined,
      EXISTS(SELECT 1 FROM hub_interests i WHERE i.project_id=p.project_id AND i.user_id=?) AS interested
      FROM project_policy p JOIN sprints s ON s.owner=p.project_id JOIN project_details d ON d.project_id=p.project_id LEFT JOIN hub_projects h ON h.project_id=p.project_id
      WHERE p.listed=true AND EXISTS(SELECT 1 FROM project_members owner WHERE owner.project_id=p.project_id AND owner.role='owner' AND owner.left_at IS NULL) AND p.lifecycle IN ('draft','active') AND (p.deadline_at IS NULL OR p.deadline_at>now())
      ORDER BY CASE WHEN p.lifecycle='active' THEN 0 ELSE 1 END,s.updated_at DESC LIMIT 40`)
        .bind(user.id, user.id)
        .all<{
          project_id: string;
          title: string;
          goal: string;
          template: ProjectTemplate | null;
          scope_level: number;
          lifecycle: string;
          started_at: Date | null;
          deadline_at: Date | null;
          members: number;
          joined: boolean;
          interested: boolean;
        }>(),
      db
        .prepare(
          `SELECT i.project_id,i.user_id,i.display_name,i.email,i.created_at,s.title,(i.invitation IS NOT NULL) AS invited FROM hub_interests i JOIN project_members m ON m.project_id=i.project_id AND m.user_id=? AND m.role='owner' AND m.left_at IS NULL JOIN sprints s ON s.owner=i.project_id ORDER BY i.created_at DESC LIMIT 40`,
        )
        .bind(user.id)
        .all<{
          project_id: string;
          display_name: string;
          user_id: string;
          email: string;
          invited: boolean;
          created_at: Date;
          title: string;
        }>(),
    ]);
  const settings = await db
    .prepare(
      `SELECT h.project_id,h.mode,p.listed FROM hub_projects h JOIN project_policy p ON p.project_id=h.project_id JOIN project_members m ON m.project_id=p.project_id WHERE m.user_id=? AND m.role='owner' AND m.left_at IS NULL`,
    )
    .bind(user.id)
    .all<{ project_id: string; mode: string; listed: boolean }>();
  const extra = experienceSkills(experiences);
  const invitations = await db
    .prepare(
      `SELECT h.project_id,s.title,h.invitation->>'token' AS token FROM hub_interests h JOIN project_invites i ON i.id=h.invitation->>'id' AND i.token_hash=h.invitation->>'hash' JOIN sprints s ON s.owner=h.project_id JOIN project_policy p ON p.project_id=h.project_id WHERE h.user_id=? AND i.email=? AND i.status='pending' AND i.expires_at>now() AND p.lifecycle IN ('draft','active') AND (p.deadline_at IS NULL OR p.deadline_at>now()) ORDER BY i.created_at DESC`,
    )
    .bind(user.id, user.email)
    .all<{ project_id: string; title: string; token: string }>();
  return {
    name: user.name,
    projects,
    records: records.results,
    directory: directory.results,
    interests: interests.results,
    invitations: invitations.results,
    settings: settings.results,
    profile,
    recommendations: profile ? recommendations(profile, extra) : [],
    gaps: profile ? gapsFor(profile, extra) : [],
    stats: learningStats(records.results),
  };
}
export async function createTemplateProject(
  user: Identity,
  b: Record<string, unknown>,
) {
  const original = templateById(String(b.templateId));
  if (!original || ![1, 2, 3].includes(Number(b.scopeLevel)))
    throw new CareerError('템플릿과 기능 범위를 선택해주세요.');
  if (
    !['solo', 'team'].includes(String(b.mode)) ||
    b.agreed !== true ||
    typeof b.listed !== 'boolean'
  )
    throw new CareerError('진행 방식과 목표를 확인해주세요.');
  const requestId = textInput(b.requestId, '요청 번호', 8, 100);
  const db = database();
  const findExisting = () =>
    db
      .prepare(
        'SELECT project_id FROM career_project_links WHERE created_by=? AND request_id=?',
      )
      .bind(user.id, requestId)
      .first<{ project_id: string }>();
  const existing = await findExisting();
  if (existing) return existing.project_id;
  const template = scopedTemplate(original, Number(b.scopeLevel));
  const profile = await readProfile(user.id);
  try {
    return await createProject(
      user,
      {
        title: template.title,
        goal: template.goal,
        scope: template.scope,
        duration: 7,
        agreed: true,
      },
      (id) => [
        db
          .prepare(
            'INSERT INTO career_project_links(project_id,template_id,template_version,goal_version,created_by,profile_id,request_id) VALUES(?,?,?,1,?,?,?)',
          )
          .bind(
            id,
            template.id,
            template.version,
            user.id,
            profile?.id ?? null,
            requestId,
          ),
        db
          .prepare(
            'INSERT INTO hub_projects(project_id,template,scope_level,mode) VALUES(?,?,?,?)',
          )
          .bind(id, template, b.scopeLevel, b.mode),
        db
          .prepare('UPDATE project_policy SET listed=? WHERE project_id=?')
          .bind(b.mode === 'team' && b.listed, id),
        ...template.tasks.flatMap((task, i) => [
          db
            .prepare(
              'INSERT INTO sprint_tasks(owner,id,title,person,remaining,description) VALUES(?,?,?,0,?,?)',
            )
            .bind(
              id,
              i + 1,
              task.title,
              task.hours,
              task.evidence +
                '\n예상 시간은 초안입니다. 실제 진행에 맞게 조절하세요.',
            ),
          db
            .prepare(
              'INSERT INTO career_task_links(project_id,task_id,template_key,work_role,skill_ids) VALUES(?,?,?,?,?)',
            )
            .bind(id, i + 1, task.key, task.role, task.skills),
          ...task.dependsOn.map((key) =>
            db
              .prepare(
                'INSERT INTO sprint_dependencies(owner,task_id,depends_on) VALUES(?,?,?)',
              )
              .bind(
                id,
                i + 1,
                template.tasks.findIndex((t) => t.key === key) + 1,
              ),
          ),
        ]),
      ],
      { simple: true },
    );
  } catch (error) {
    const retry = await findExisting();
    if (retry) return retry.project_id;
    throw error;
  }
}
export async function hubAction(
  user: Identity,
  b: Record<string, unknown>,
  origin: string,
) {
  const db = database();
  if (b.action === 'createTemplate')
    return { projectId: await createTemplateProject(user, b) };
  if (b.action === 'checkin') {
    if (!['studied', 'stuck', 'rest'].includes(String(b.status)))
      throw new CareerError('오늘 상태를 선택해주세요.');
    const payload = {
      status: String(b.status),
      skills: skillIds(b.skills ?? []),
      text: textInput(b.text ?? '', '학습 기록', 0, 1000),
    };
    await db
      .prepare(
        `INSERT INTO hub_records(user_id,id,kind,payload) VALUES(?,?,'checkin',?) ON CONFLICT(user_id,id) DO UPDATE SET payload=excluded.payload WHERE hub_records.kind='checkin'`,
      )
      .bind(user.id, 'checkin:' + dateInSeoul(new Date()), payload)
      .run();
    return { saved: true };
  }
  if (b.action === 'saveRecord') {
    if (!['portfolio', 'job'].includes(String(b.kind)))
      throw new CareerError('기록 종류를 확인해주세요.');
    const id = textInput(b.id, '기록 번호', 8, 100);
    if (id.startsWith('checkin:'))
      throw new CareerError('기록 번호를 확인해주세요.');
    const payload = {
      title: textInput(b.title, '제목', 1, 100),
      url: safeLink(b.url),
      text: textInput(
        b.text ?? '',
        '내용',
        0,
        b.kind === 'job' ? 20000 : 20000,
      ),
    };
    const result = await db
      .prepare(
        `INSERT INTO hub_records(user_id,id,kind,payload) SELECT ?,?,?,? WHERE (SELECT count(*) FROM hub_records WHERE user_id=? AND kind=?)<100 OR EXISTS(SELECT 1 FROM hub_records WHERE user_id=? AND id=?) ON CONFLICT(user_id,id) DO UPDATE SET payload=excluded.payload WHERE hub_records.kind=excluded.kind`,
      )
      .bind(user.id, id, b.kind, payload, user.id, b.kind, user.id, id)
      .run();
    if (!result.meta.changes)
      throw new CareerError(
        '기록 종류별 최대 100개까지 저장할 수 있습니다.',
        409,
      );
    return { saved: true };
  }
  if (b.action === 'interest') {
    if (b.consent !== true)
      throw new CareerError(
        '이름과 로그인 이메일을 팀장에게 전달하는 데 동의해주세요.',
      );
    if (!user.email)
      throw new CareerError('팀 초대를 받을 로그인 이메일이 필요합니다.');
    // 관심 표시는 참여 신청과 같다. 동료평가 미제출 금지 중에는 막는다.
    await assertNotRestricted(user.id, new Date(), '참여 신청할');
    const result = await db
      .prepare(
        `INSERT INTO hub_interests(project_id,user_id,display_name,email) SELECT h.project_id,?,?,? FROM hub_projects h JOIN project_policy p ON p.project_id=h.project_id WHERE h.project_id=? AND p.listed=true AND h.mode='team' AND p.lifecycle IN ('draft','active') AND (p.deadline_at IS NULL OR p.deadline_at>now()) AND (SELECT count(*) FROM project_members m WHERE m.project_id=h.project_id AND m.left_at IS NULL)<4 AND NOT EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=h.project_id AND m.user_id=? AND m.left_at IS NULL) ON CONFLICT(project_id,user_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email`,
      )
      .bind(user.id, user.name, user.email, String(b.projectId), user.id)
      .run();
    if (!result.meta.changes)
      throw new CareerError('모집이 종료되었거나 이미 참여한 팀입니다.', 409);
    return { saved: true };
  }
  if (b.action === 'inviteInterested') {
    const id = String(b.projectId);
    const me = await member(id, user);
    if (me.role !== 'owner' || me.left_at)
      throw new CareerError('팀장만 초대할 수 있습니다.', 403);
    const interest = await db
      .prepare(
        'SELECT email FROM hub_interests WHERE project_id=? AND user_id=?',
      )
      .bind(id, String(b.userId))
      .first<{ email: string }>();
    if (!interest?.email)
      throw new CareerError(
        '연락처 공유에 동의한 참여 요청을 찾을 수 없습니다.',
        404,
      );
    const current = await db
      .prepare(
        `SELECT i.id FROM hub_interests h JOIN project_invites i ON i.id=h.invitation->>'id' AND i.token_hash=h.invitation->>'hash' WHERE h.project_id=? AND h.user_id=? AND i.status='pending' AND i.expires_at>now()`,
      )
      .bind(id, String(b.userId))
      .first();
    if (current) return { invited: true };
    await createInvite(
      id,
      user,
      Number(b.revision),
      interest.email,
      origin,
      (token, inviteId, hash, mutation) => [
        db
          .prepare(
            `UPDATE hub_interests SET invitation=? WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)`,
          )
          .bind(
            { token, id: inviteId, hash },
            id,
            String(b.userId),
            id,
            mutation,
          ),
      ],
    );
    return { invited: true };
  }
  if (b.action === 'listing') {
    const id = String(b.projectId);
    const [me, policy, sprint] = await Promise.all([
      member(id, user),
      readPolicy(id),
      readSprint(id),
    ]);
    assertProjectMutationAllowed({
      policy,
      actor: actorOf(me),
      action: 'invite',
      now: new Date(),
    });
    if (typeof b.listed !== 'boolean')
      throw new CareerError('공개 여부를 선택해주세요.');
    if (!sprint || sprint.revision !== b.revision)
      throw new CareerError('프로젝트가 바뀌었습니다. 새로고침해주세요.', 409);
    const setting = await db
      .prepare('SELECT mode FROM hub_projects WHERE project_id=?')
      .bind(id)
      .first<{ mode: string }>();
    if (setting?.mode !== 'team')
      throw new CareerError('팀 프로젝트만 공개할 수 있습니다.', 409);
    await setListed(id, user, Number(b.revision), b.listed);
    return { saved: true };
  }
  throw new CareerError('지원하지 않는 요청입니다.');
}
