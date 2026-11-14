import {
  database,
  readSprint,
  readMembers,
  readPolicy,
  readDeliverables,
  save,
  Conflict,
} from '../sprint-store';
import { createProject, member, actorOf } from '../projects';
import {
  assertProjectMutationAllowed,
  effectiveLifecycle,
} from '../sprint-policy';
import type { Identity } from '../auth';
import {
  templateById,
  skillName,
  roleName,
  type SkillId,
  type RoleId,
  type ProjectTemplate,
} from './catalog';
import {
  CareerError,
  skillIds,
  textInput,
  type Analysis,
  type Profile,
  type ProfileInput,
  type SkillEvidence,
} from './profile';
import { recommendRoles, type SharedMember, type RolePlan } from './roles';
import type { ProfileWrite } from './profile-write';

const db = () => database();
type ExperienceDependency = { id: string; version: number };
type StoredSkill = SharedMember['skills'][number] & {
  experience?: ExperienceDependency;
};
type StoredPlan = RolePlan & { evidenceDependencies?: ExperienceDependency[] };
function experienceGuard(dependencies: ExperienceDependency[]) {
  return {
    sql:
      dependencies
        .map(
          () => `EXISTS(
      SELECT 1 FROM career_experiences e
      JOIN sprint_tasks t ON t.owner=e.project_id AND t.id=e.task_id
      JOIN project_members m ON m.project_id=e.project_id AND m.user_id=e.user_id
      WHERE e.id=? AND e.task_version=? AND t.change_version=e.task_version
        AND t.done=true AND t.evidence=e.evidence AND t.person=m.person AND m.left_at IS NULL
    )`,
        )
        .join(' AND ') || 'true',
    args: dependencies.flatMap((d) => [d.id, d.version]),
  };
}
export async function readProfile(userId: string): Promise<Profile | null> {
  const row = await db()
    .prepare(
      'SELECT v.* FROM career_profiles p JOIN career_profile_versions v ON v.id=p.snapshot_id AND v.user_id=p.user_id WHERE p.user_id=?',
    )
    .bind(userId)
    .first<{
      id: string;
      version: number;
      input: ProfileInput;
      analysis: Analysis;
      created_at: Date;
    }>();
  return row
    ? {
        ...row.input,
        id: row.id,
        version: row.version,
        analysis: row.analysis,
        createdAt: row.created_at.toISOString(),
      }
    : null;
}
export async function saveProfile(
  claim: ProfileWrite,
  input: ProfileInput,
  analysis: Analysis,
) {
  const { userId, version } = claim;
  if (!Number.isInteger(version) || version < 0)
    throw new CareerError('프로필 버전을 확인해주세요.');
  const id = 'cv_' + crypto.randomUUID();
  const result = await db().batch([
    db()
      .prepare(
        'SELECT user_id FROM career_profile_writes WHERE user_id=? FOR UPDATE',
      )
      .bind(userId),
    db()
      .prepare(
        `INSERT INTO career_profiles(user_id,version,snapshot_id)
        SELECT ?,1,? FROM career_profile_writes WHERE user_id=? AND claim_id=?
        AND expires_at>clock_timestamp()
        AND (?=0 OR EXISTS(SELECT 1 FROM career_profiles WHERE user_id=? AND version=?))
        ON CONFLICT(user_id) DO UPDATE SET version=career_profiles.version+1,snapshot_id=excluded.snapshot_id
        WHERE career_profiles.version=? AND ?>0`,
      )
      .bind(
        userId,
        id,
        userId,
        claim.id,
        version,
        userId,
        version,
        version,
        version,
      ),
    db()
      .prepare(
        'INSERT INTO career_profile_versions(id,user_id,version,input,analysis) SELECT snapshot_id,user_id,version,?,? FROM career_profiles WHERE user_id=? AND snapshot_id=?',
      )
      .bind(input, analysis, userId, id),
    db()
      .prepare(
        'SELECT created_at FROM career_profile_versions WHERE user_id=? AND id=?',
      )
      .bind(userId, id),
    db()
      .prepare(
        'UPDATE career_profile_writes SET claim_id=NULL,expires_at=NULL WHERE user_id=? AND claim_id=?',
      )
      .bind(userId, claim.id),
  ]);
  if (result[1].meta.changes !== 1)
    throw new CareerError(
      '다른 화면에서 프로필이 바뀌었습니다. 새로고침 후 다시 저장해주세요.',
      409,
    );
  return {
    ...input,
    id,
    version: version + 1,
    analysis,
    createdAt: (result[3].results[0].created_at as Date).toISOString(),
  } satisfies Profile;
}
export type Experience = {
  id: string;
  project_id: string;
  task_id: number;
  task_version: number;
  task_title: string;
  skill_ids: SkillId[];
  evidence: string;
  contribution: string;
  resume_bullet: string;
  confirmed_at: Date;
  valid: boolean;
};
export async function readExperiences(userId: string) {
  const result = await db()
    .prepare(`SELECT e.*,
    (t.done=true AND t.evidence=e.evidence AND t.change_version=e.task_version AND t.person=m.person AND m.left_at IS NULL) AS valid
    FROM career_experiences e LEFT JOIN sprint_tasks t ON t.owner=e.project_id AND t.id=e.task_id
    LEFT JOIN project_members m ON m.project_id=e.project_id AND m.user_id=e.user_id
    WHERE e.user_id=? ORDER BY e.confirmed_at DESC`)
    .bind(userId)
    .all<Experience>();
  return result.results;
}
export function experienceSkills(experiences: Experience[]): SkillEvidence[] {
  return experiences
    .filter((e) => e.valid)
    .flatMap((e) =>
      e.skill_ids.map((skillId) => ({
        skillId,
        level: 'applied' as const,
        quote: e.resume_bullet,
        source: 'project' as const,
        sourceId: e.id,
      })),
    );
}
export async function createRecommendedProject(
  user: Identity,
  b: Record<string, unknown>,
) {
  const template = templateById(String(b.templateId));
  if (!template)
    throw new CareerError('프로젝트 템플릿을 찾을 수 없습니다.', 404);
  const requestId = textInput(b.requestId, '요청 ID', 10, 100);
  const existing = await db()
    .prepare(
      'SELECT project_id FROM career_project_links WHERE created_by=? AND request_id=?',
    )
    .bind(user.id, requestId)
    .first<{ project_id: string }>();
  if (existing) return existing.project_id;
  const profile = await readProfile(user.id);
  if (!profile || profile.id !== b.profileId)
    throw new CareerError('최신 프로필로 추천을 다시 확인해주세요.', 409);
  if (b.agreed !== true)
    throw new CareerError(
      '프로젝트 목표·범위·결과물·완료 기준을 확인해주세요.',
    );
  try {
    return await createProject(
      user,
      {
        title: template.title,
        goal: template.goal,
        scope: template.scope,
        deliverables: template.deliverables.join('\n'),
        completionCriteria: template.criteria,
        duration: 7,
        agreed: true,
      },
      (projectId) => [
        db()
          .prepare(
            'INSERT INTO career_project_links(project_id,template_id,template_version,goal_version,created_by,profile_id,request_id) VALUES(?,?,?,1,?,?,?)',
          )
          .bind(
            projectId,
            template.id,
            template.version,
            user.id,
            profile.id,
            requestId,
          ),
      ],
    );
  } catch (e) {
    // Concurrent retry: uniqueness rolls back the duplicate project and its membership as well.
    const retry = await db()
      .prepare(
        'SELECT project_id FROM career_project_links WHERE created_by=? AND request_id=?',
      )
      .bind(user.id, requestId)
      .first<{ project_id: string }>();
    if (retry) return retry.project_id;
    throw e;
  }
}
async function context(projectId: string, user: Identity) {
  const me = await member(projectId, user);
  const [sprint, policy, members] = await Promise.all([
    readSprint(projectId),
    readPolicy(projectId),
    readMembers(projectId),
  ]);
  if (!sprint || !policy)
    throw new CareerError('현재 규칙의 프로젝트에서 사용할 수 있습니다.');
  if (me.left_at)
    throw new CareerError('현재 참여 중인 팀원만 사용할 수 있습니다.', 403);
  return { me, sprint, policy, members };
}
function membershipGuard(projectId: string, userId: string, owner = false) {
  return {
    sql: `EXISTS(SELECT 1 FROM project_members m JOIN project_policy p ON p.project_id=m.project_id WHERE m.project_id=? AND m.user_id=? AND m.left_at IS NULL AND m.agreed_goal_version=p.goal_version${owner ? " AND m.role='owner'" : ''})`,
    args: [projectId, userId] as unknown[],
  };
}
export async function shareProfile(
  projectId: string,
  user: Identity,
  b: Record<string, unknown>,
) {
  const { me, sprint, policy } = await context(projectId, user);
  assertProjectMutationAllowed({
    policy,
    actor: actorOf(me),
    action: 'createProposal',
    now: new Date(),
  });
  if (sprint.revision !== b.revision) throw new Conflict();
  const revoke = b.action === 'unshare';
  const profile = await readProfile(user.id);
  if (!revoke && (!profile || profile.id !== b.profileId))
    throw new CareerError('최신 프로필을 확인한 뒤 공유해주세요.', 409);
  const selected = revoke ? [] : skillIds(b.skillIds);
  const records = revoke ? [] : await readExperiences(user.id);
  const experiences = experienceSkills(records);
  const skills = selected.map((id) => {
    const evidence =
      experiences.find((s) => s.skillId === id) ??
      profile?.analysis.skills.find(
        (s) => s.skillId === id && !profile.noExperience.includes(id),
      );
    if (!evidence)
      throw new CareerError('근거가 확인된 역량만 공유할 수 있습니다.');
    // Never copy private resume quotes, filenames, goals' job postings, or contact data to team tables.
    const record = records.find((r) => r.id === evidence.sourceId);
    return {
      skillId: id,
      level: evidence.level,
      ...(record
        ? { experience: { id: record.id, version: record.task_version } }
        : {}),
    };
  });
  const guard = membershipGuard(projectId, user.id);
  const sources = experienceGuard(
    skills.flatMap((s) => (s.experience ? [s.experience] : [])),
  );
  guard.sql += ` AND ${sources.sql}`;
  guard.args.push(...sources.args);
  if (!revoke) {
    guard.sql +=
      ' AND EXISTS(SELECT 1 FROM career_profiles WHERE user_id=? AND snapshot_id=?)';
    guard.args.push(user.id, profile!.id);
  }
  await save(
    projectId,
    sprint,
    'career_sharing',
    revoke ? '역량 공유 철회' : '본인이 선택한 역량·성장 목표·희망 역할 공유',
    (mutation) => [
      revoke
        ? db()
            .prepare(
              'DELETE FROM career_project_profiles WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
            )
            .bind(projectId, user.id, projectId, mutation)
        : db()
            .prepare(`INSERT INTO career_project_profiles(project_id,user_id,profile_id,skills,learning_goals,preferred_roles)
          SELECT owner,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=? ON CONFLICT(project_id,user_id)
          DO UPDATE SET profile_id=excluded.profile_id,skills=excluded.skills,learning_goals=excluded.learning_goals,preferred_roles=excluded.preferred_roles,shared_at=now()`)
            .bind(
              user.id,
              profile!.id,
              skills,
              profile!.learningGoals,
              profile!.preferredRoles,
              projectId,
              mutation,
            ),
    ],
    ['draft', 'active'],
    guard,
  );
}
export async function teamState(projectId: string, user: Identity) {
  const { me, sprint, policy, members } = await context(projectId, user);
  const [links, shares, proposals, taskLinks, deliverables] = await Promise.all(
    [
      db()
        .prepare(
          'SELECT template_id,template_version,goal_version FROM career_project_links WHERE project_id=?',
        )
        .bind(projectId)
        .first<{
          template_id: string;
          template_version: number;
          goal_version: number;
        }>(),
      db()
        .prepare(
          'SELECT s.user_id,s.profile_id,s.skills,s.learning_goals,s.preferred_roles,(p.snapshot_id<>s.profile_id) AS outdated FROM career_project_profiles s JOIN career_profiles p ON p.user_id=s.user_id WHERE s.project_id=?',
        )
        .bind(projectId)
        .all<{
          user_id: string;
          profile_id: string;
          skills: StoredSkill[];
          learning_goals: SkillId[];
          preferred_roles: RoleId[];
          outdated: boolean;
        }>(),
      db()
        .prepare(
          "SELECT id,base_revision,goal_version,payload,status FROM career_role_proposals WHERE project_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(projectId)
        .first<{
          id: string;
          base_revision: number;
          goal_version: number;
          payload: StoredPlan;
          status: string;
        }>(),
      db()
        .prepare(
          'SELECT task_id,template_key,work_role,skill_ids FROM career_task_links WHERE project_id=?',
        )
        .bind(projectId)
        .all<{
          task_id: number;
          template_key: string;
          work_role: RoleId;
          skill_ids: SkillId[];
        }>(),
      readDeliverables(projectId),
    ],
  );
  const sharedExperiences = new Map(
    await Promise.all(
      shares.results.map(
        async (s) => [s.user_id, await readExperiences(s.user_id)] as const,
      ),
    ),
  );
  const savedTemplate = await db()
    .prepare('SELECT template FROM hub_projects WHERE project_id=?')
    .bind(projectId)
    .first<{ template: ProjectTemplate }>();
  const team = members
    .filter((m) => !m.leftAt)
    .map((m) => {
      const share = shares.results.find((s) => s.user_id === m.userId);
      const validSkills = (share?.skills ?? []).filter(
        (s) =>
          !s.experience ||
          sharedExperiences
            .get(m.userId)
            ?.some(
              (e) =>
                e.valid &&
                e.id === s.experience!.id &&
                e.task_version === s.experience!.version,
            ),
      );
      return {
        userId: m.userId,
        person: m.person,
        name: m.displayName,
        profileId: share?.profile_id ?? null,
        skills: validSkills.map(({ experience: _experience, ...s }) => s),
        evidenceDependencies: validSkills.flatMap((s) =>
          s.experience ? [s.experience] : [],
        ),
        learningGoals: share?.learning_goals ?? [],
        preferredRoles: share?.preferred_roles ?? [],
        currentHours: sprint.tasks
          .filter(
            (t) =>
              t.person === m.person &&
              !t.done &&
              !taskLinks.results.some((l) => l.task_id === t.id),
          )
          .reduce((n, t) => n + t.remaining, 0),
      };
    });
  const tasks = sprint.tasks.map((t) => {
    const link = taskLinks.results.find((l) => l.task_id === t.id);
    return {
      id: t.id,
      title: t.title,
      person: t.person,
      done: t.done,
      evidence: t.evidence,
      changeVersion: t.changeVersion ?? 0,
      workRole: link?.work_role ?? null,
      skills: link?.skill_ids ?? [],
    };
  });
  const stale = proposals
    ? proposals.base_revision !== sprint.revision ||
      proposals.goal_version !== policy.goalVersion ||
      (proposals.payload.evidenceDependencies ?? []).some(
        (d) =>
          !team.some((m) =>
            m.evidenceDependencies.some(
              (v) => v.id === d.id && v.version === d.version,
            ),
          ),
      )
    : false;
  const visibleProposal = proposals
    ? {
        ...proposals,
        payload: {
          templateId: proposals.payload.templateId,
          assignments: proposals.payload.assignments,
          warnings: proposals.payload.warnings,
        },
      }
    : null;
  return {
    projectId,
    revision: sprint.revision,
    lifecycle: effectiveLifecycle(policy, new Date()),
    goalVersion: policy.goalVersion,
    me: {
      person: me.person,
      isOwner: me.role === 'owner',
      agreed: me.agreed_goal_version === policy.goalVersion,
    },
    template:
      savedTemplate?.template ??
      (links ? (templateById(links.template_id) ?? null) : null),
    templateMatchesGoal: Boolean(
      links &&
      links.goal_version === policy.goalVersion &&
      links.template_version === templateById(links.template_id)?.version,
    ),
    members: team.map(
      ({ userId: _userId, evidenceDependencies: _sources, ...m }) => ({
        ...m,
        outdated: Boolean(
          shares.results.find((s) => s.profile_id === m.profileId)?.outdated,
        ),
      }),
    ),
    // A withdrawn share must not remain visible through a stale recommendation payload.
    proposal: !stale ? visibleProposal : null,
    staleProposal: stale,
    tasks,
    myCompletedTasks: tasks.filter(
      (t) => t.person === me.person && t.done && t.evidence.trim().length >= 5,
    ),
    deliverables: deliverables.map((d) => ({
      title: d.title,
      confirmed: d.confirmed,
    })),
    _team: team,
  };
}
export async function proposeRoles(
  projectId: string,
  user: Identity,
  revision: unknown,
) {
  const c = await context(projectId, user);
  assertProjectMutationAllowed({
    policy: c.policy,
    actor: actorOf(c.me),
    action: 'createProposal',
    now: new Date(),
  });
  const state = await teamState(projectId, user);
  if (state.revision !== revision) throw new Conflict();
  if (!state.template || !state.templateMatchesGoal)
    throw new CareerError(
      '추천 템플릿으로 만든 프로젝트에서, 처음 합의한 목표를 유지할 때 사용할 수 있습니다.',
    );
  const plan: StoredPlan = {
    ...recommendRoles(state.template, state._team),
    evidenceDependencies: state._team.flatMap((m) => m.evidenceDependencies),
  };
  const sources = experienceGuard(plan.evidenceDependencies!);
  const id = 'cr_' + crypto.randomUUID();
  const result = await db()
    .prepare(`INSERT INTO career_role_proposals(id,project_id,base_revision,goal_version,payload,created_by)
    SELECT ?,s.owner,s.revision,p.goal_version,?,? FROM sprints s JOIN project_policy p ON p.project_id=s.owner
    JOIN project_members m ON m.project_id=s.owner AND m.user_id=?
    WHERE s.owner=? AND s.revision=? AND p.lifecycle IN ('draft','active') AND (p.deadline_at IS NULL OR p.deadline_at>now())
    AND m.left_at IS NULL AND m.agreed_goal_version=p.goal_version AND ${sources.sql}`)
    .bind(id, plan, user.id, user.id, projectId, revision, ...sources.args)
    .run();
  if (result.meta.changes !== 1) throw new Conflict();
  return id;
}
export async function applyRoles(
  projectId: string,
  user: Identity,
  b: Record<string, unknown>,
) {
  const { me, sprint, policy, members } = await context(projectId, user);
  assertProjectMutationAllowed({
    policy,
    actor: actorOf(me),
    action: 'createTask',
    now: new Date(),
  });
  if (sprint.revision !== b.revision) throw new Conflict();
  const proposal = await db()
    .prepare('SELECT * FROM career_role_proposals WHERE id=? AND project_id=?')
    .bind(b.proposalId, projectId)
    .first<{
      id: string;
      status: string;
      base_revision: number;
      goal_version: number;
      payload: StoredPlan;
    }>();
  if (
    !proposal ||
    proposal.status !== 'pending' ||
    proposal.base_revision !== sprint.revision ||
    proposal.goal_version !== policy.goalVersion
  )
    throw new CareerError(
      '이 역할안은 이미 적용됐거나 오래되었습니다. 다시 추천해주세요.',
      409,
    );
  const savedTemplate = await db()
    .prepare('SELECT template FROM hub_projects WHERE project_id=?')
    .bind(projectId)
    .first<{ template: ProjectTemplate }>();
  const template =
    savedTemplate?.template ?? templateById(proposal.payload.templateId);
  if (!template) throw new CareerError('프로젝트 템플릿을 찾을 수 없습니다.');
  const raw = b.assignments;
  if (!Array.isArray(raw) || raw.length !== template.roles.length)
    throw new CareerError('역할별 담당자를 모두 선택해주세요.');
  const assignments = raw as { role: string; person: number }[];
  if (
    new Set(assignments.map((a) => a?.role)).size !== template.roles.length ||
    assignments.some(
      (a) =>
        !a ||
        !template.roles.some((r) => r.id === a.role) ||
        !members.some((m) => !m.leftAt && m.person === a.person),
    )
  )
    throw new CareerError(
      '현재 참여 중인 팀원으로 역할별 담당자를 선택해주세요.',
    );
  if (b.approved !== true)
    throw new CareerError('담당 업무와 예상 공수를 검토한 뒤 적용해주세요.');
  const existing = (
    await db()
      .prepare(
        'SELECT task_id,template_key FROM career_task_links WHERE project_id=?',
      )
      .bind(projectId)
      .all<{ task_id: number; template_key: string }>()
  ).results;
  let next = Math.max(0, ...sprint.tasks.map((t) => t.id));
  const ids = new Map(
    template.tasks.map((t) => [
      t.key,
      existing.find((l) => l.template_key === t.key)?.task_id ?? ++next,
    ]),
  );
  if (
    sprint.tasks.length +
      template.tasks.filter(
        (t) => !existing.some((l) => l.template_key === t.key),
      ).length >
    100
  )
    throw new CareerError('업무는 최대 100개까지 등록할 수 있습니다.');
  const guard = membershipGuard(projectId, user.id, true);
  guard.sql +=
    " AND EXISTS(SELECT 1 FROM career_role_proposals WHERE id=? AND project_id=? AND status='pending' AND base_revision=sprints.revision)";
  guard.args.push(proposal.id, projectId);
  const sources = experienceGuard(proposal.payload.evidenceDependencies ?? []);
  guard.sql += ` AND ${sources.sql}`;
  guard.args.push(...sources.args);
  await save(
    projectId,
    sprint,
    'career_roles',
    '검토한 수행 역할과 성장 과제를 업무에 반영',
    (mutation) => {
      const statements = [];
      for (const task of template.tasks) {
        const id = ids.get(task.key)!;
        const current = sprint.tasks.find((t) => t.id === id);
        const person = assignments.find((a) => a.role === task.role)!.person;
        if (current) {
          if (!current.done && current.person !== person)
            statements.push(
              db()
                .prepare(
                  'UPDATE sprint_tasks SET person=?,change_version=change_version+1,touched_at=now() WHERE owner=? AND id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
                )
                .bind(person, projectId, id, projectId, mutation),
            );
        } else {
          statements.push(
            db()
              .prepare(
                `INSERT INTO sprint_tasks(owner,id,title,person,remaining,description) SELECT owner,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=?`,
              )
              .bind(
                id,
                task.title,
                person,
                task.hours,
                `수행 역할: ${roleName(task.role)}\n경험을 남길 역량: ${task.skills.map(skillName).join(', ')}\n완료 근거: ${task.evidence}\n예상 공수는 초안이며 실제 진행에 맞춰 수정하세요.`,
                projectId,
                mutation,
              ),
          );
          statements.push(
            db()
              .prepare(
                'INSERT INTO career_task_links(project_id,task_id,template_key,work_role,skill_ids) SELECT owner,?,?,?,? FROM sprints WHERE owner=? AND mutation=?',
              )
              .bind(id, task.key, task.role, task.skills, projectId, mutation),
          );
        }
      }
      for (const task of template.tasks.filter(
        (t) => !existing.some((l) => l.template_key === t.key),
      )) {
        for (const dep of task.dependsOn)
          statements.push(
            db()
              .prepare(
                'INSERT INTO sprint_dependencies(owner,task_id,depends_on) SELECT owner,?,? FROM sprints WHERE owner=? AND mutation=?',
              )
              .bind(ids.get(task.key), ids.get(dep), projectId, mutation),
          );
      }
      statements.push(
        db()
          .prepare(
            "UPDATE career_role_proposals SET status='applied' WHERE id=? AND project_id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
          )
          .bind(proposal.id, projectId, projectId, mutation),
      );
      return statements;
    },
    ['draft', 'active'],
    guard,
  );
}
export async function recordExperience(
  projectId: string,
  user: Identity,
  b: Record<string, unknown>,
) {
  const { me, sprint } = await context(projectId, user);
  const task = sprint.tasks.find((t) => t.id === b.taskId);
  if (
    !task ||
    task.person !== me.person ||
    !task.done ||
    task.evidence.trim().length < 5
  )
    throw new CareerError(
      '완료 근거가 있는 본인 담당 업무만 가져올 수 있습니다.',
      403,
    );
  if ((task.changeVersion ?? 0) !== b.taskVersion)
    throw new CareerError(
      '업무가 바뀌었습니다. 최신 완료 근거를 확인해주세요.',
      409,
    );
  if (b.confirmed !== true)
    throw new CareerError('실제로 수행한 역량과 본인 기여를 확인해주세요.');
  const selected = skillIds(b.skillIds);
  if (!selected.length)
    throw new CareerError('직접 수행한 역량을 하나 이상 선택해주세요.');
  const link = await db()
    .prepare(
      'SELECT skill_ids FROM career_task_links WHERE project_id=? AND task_id=?',
    )
    .bind(projectId, task.id)
    .first<{ skill_ids: SkillId[] }>();
  if (!link || selected.some((s) => !link.skill_ids.includes(s)))
    throw new CareerError(
      '해당 성장 과제에 연결된 역량 중 직접 수행한 항목을 선택해주세요.',
    );
  const contribution = textInput(b.contribution, '본인 기여', 10, 1000);
  const bullet = `${sprint.title} 프로젝트에서 ${task.title} 업무를 수행했습니다. ${contribution}`;
  const result = await db()
    .prepare(`INSERT INTO career_experiences(id,user_id,project_id,task_id,task_version,task_title,skill_ids,evidence,contribution,resume_bullet)
    SELECT ?,m.user_id,t.owner,t.id,t.change_version,t.title,?,t.evidence,?,? FROM sprint_tasks t
    JOIN project_members m ON m.project_id=t.owner AND m.person=t.person
    WHERE t.owner=? AND t.id=? AND m.user_id=? AND m.left_at IS NULL AND t.done=true AND t.change_version=? AND t.evidence=?
    ON CONFLICT(user_id,project_id,task_id) DO UPDATE SET task_version=excluded.task_version,task_title=excluded.task_title,skill_ids=excluded.skill_ids,evidence=excluded.evidence,contribution=excluded.contribution,resume_bullet=excluded.resume_bullet,confirmed_at=now()`)
    .bind(
      'ce_' + crypto.randomUUID(),
      selected,
      contribution,
      bullet,
      projectId,
      task.id,
      user.id,
      b.taskVersion,
      task.evidence,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new CareerError(
      '업무 상태나 담당자가 바뀌었습니다. 다시 확인해주세요.',
      409,
    );
}
