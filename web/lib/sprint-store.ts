import { env } from 'cloudflare:workers';
import {
  seed,
  schedule,
  plan,
  type Sprint,
  type Task,
  type Capacity,
  people,
} from './sprint';
import {
  effectiveLifecycle,
  policyRow,
  startReadiness,
  type Lifecycle,
  type Policy,
} from './sprint-policy';
import { completionCheck, deliverableRow } from './deliverables';
export function database() {
  return (env as unknown as { DB: D1Database }).DB;
}
export async function readSprint(owner: string): Promise<Sprint | null> {
  const db = database();
  const results = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM sprints WHERE owner=?').bind(owner),
    db
      .prepare('SELECT * FROM sprint_tasks WHERE owner=? ORDER BY id')
      .bind(owner),
    db.prepare('SELECT * FROM sprint_dependencies WHERE owner=?').bind(owner),
    db
      .prepare(
        'SELECT * FROM sprint_capacity WHERE owner=? ORDER BY person,date',
      )
      .bind(owner),
  ]);
  const memberRows = await db
    .prepare(
      'SELECT person,display_name,role FROM project_members WHERE project_id=? ORDER BY person',
    )
    .bind(owner)
    .all<{ person: number; display_name: string; role: string }>();
  const actualPeople = memberRows.results;
  const row = results[0].results[0];
  if (!row) return null;
  return {
    people: actualPeople.length
      ? Array.from(
          {
            length:
              Math.max(
                ...actualPeople.map((m) => m.person),
                ...results[3].results.map((c) => Number(c.person)),
              ) + 1,
          },
          (_, person) => {
            const m = actualPeople.find((m) => m.person === person);
            return {
              name: m?.display_name ?? '미배정 샘플',
              role:
                m?.role === 'owner' ? '팀장' : m ? '팀원' : '가입 전 샘플 역할',
              initial: m?.display_name.slice(0, 1) ?? '?',
              color: ['#dedaff', '#d8efd6', '#ffe4bd', '#d5e9ff'][person % 4],
            };
          },
        )
      : people,
    title: String(row.title),
    startDate: String(row.start_date),
    deadline: String(row.deadline),
    revision: Number(row.revision),
    joined: Boolean(row.joined),
    finished: Boolean(row.finished),
    tasks: results[1].results.map((t) => ({
      id: Number(t.id),
      title: String(t.title),
      status: t.status === 'in_progress' ? 'in_progress' : 'todo',
      description: typeof t.description === 'string' ? t.description : '',
      person: Number(t.person),
      remaining: Number(t.remaining),
      optional: Boolean(t.optional),
      deferred: Boolean(t.deferred),
      done: Boolean(t.done),
      evidence: String(t.evidence),
      dueAt: (t.due_at as string | null) ?? null,
      deadlineVersion: Number(t.deadline_version ?? 0),
      dependsOn: results[2].results
        .filter((d) => d.task_id === t.id)
        .map((d) => Number(d.depends_on)),
    })),
    capacity: results[3].results.map((c) => ({
      person: Number(c.person),
      date: String(c.date),
      hours: Number(c.hours),
    })),
  };
}
export async function initialize(owner: string) {
  const existing = await readSprint(owner);
  if (existing) return existing;
  const s = seed();
  const db = database();
  const statements = [
    db
      .prepare(
        'INSERT OR IGNORE INTO sprints(owner,title,start_date,deadline,updated_at) VALUES(?,?,?,?,?)',
      )
      .bind(owner, s.title, s.startDate, s.deadline, new Date().toISOString()),
  ];
  for (const t of s.tasks) {
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO sprint_tasks(owner,id,title,person,remaining,optional) VALUES(?,?,?,?,?,?)',
        )
        .bind(owner, t.id, t.title, t.person, t.remaining, Number(t.optional)),
    );
    for (const d of t.dependsOn)
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO sprint_dependencies(owner,task_id,depends_on) VALUES(?,?,?)',
          )
          .bind(owner, t.id, d),
      );
  }
  for (const c of s.capacity)
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO sprint_capacity(owner,person,date,hours) VALUES(?,?,?,?)',
        )
        .bind(owner, c.person, c.date, c.hours),
    );
  await db.batch(statements);
  return (await readSprint(owner))!;
}
export type Member = {
  userId: string;
  displayName: string;
  role: string;
  person: number;
  agreedGoalVersion: number;
  joinedAt: string;
  leftAt: string | null;
  leftNote: string;
};

export async function readPolicy(owner: string): Promise<Policy | null> {
  return policyRow(
    await database()
      .prepare('SELECT * FROM project_policy WHERE project_id=?')
      .bind(owner)
      .first<Record<string, unknown>>(),
  );
}

export async function readMembers(owner: string): Promise<Member[]> {
  const rows = await database()
    .prepare(
      'SELECT user_id,display_name,role,person,agreed_goal_version,joined_at,left_at,left_note FROM project_members WHERE project_id=? ORDER BY person',
    )
    .bind(owner)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    userId: String(r.user_id),
    displayName: String(r.display_name),
    role: String(r.role),
    person: Number(r.person),
    agreedGoalVersion: Number(r.agreed_goal_version),
    joinedAt: String(r.joined_at),
    leftAt: (r.left_at as string | null) ?? null,
    leftNote: typeof r.left_note === 'string' ? r.left_note : '',
  }));
}

export async function readDeliverables(owner: string) {
  const rows = await database()
    .prepare(
      'SELECT * FROM project_deliverables WHERE project_id=? ORDER BY position',
    )
    .bind(owner)
    .all<Record<string, unknown>>();
  return rows.results.map(deliverableRow);
}

/**
 * 현재 계획. 시작한 프로젝트는 확정 기한까지, 준비 중인 프로젝트는
 * "지금 시작하면"을 가정한 예상치(provisional)로 계산한다.
 */
export function currentPlan(
  s: Sprint,
  policy: Policy,
  members: Member[],
  now = new Date(),
) {
  const active = members.filter((m) => !m.leftAt).map((m) => m.person);
  const started = policy.startedAt ? new Date(policy.startedAt) : now;
  const until = policy.deadlineAt
    ? new Date(policy.deadlineAt)
    : new Date(now.getTime() + policy.durationDays * 86400000);
  return plan(s.tasks, active, {
    now,
    from: started,
    until,
    dailyHours: policy.dailyHours,
    provisional: !policy.deadlineAt,
  });
}

export async function responseState(owner: string, now = new Date()) {
  const s = await readSprint(owner);
  if (!s) throw new Error('프로젝트를 찾을 수 없습니다.');
  const db = database();
  const policy = await readPolicy(owner);
  const [checkins, events, agreement] = await db.batch<Record<string, unknown>>(
    [
      db
        .prepare(
          'SELECT id,task_id,note,remaining,created_at FROM sprint_checkins WHERE owner=? ORDER BY created_at DESC LIMIT 20',
        )
        .bind(owner),
      db
        .prepare(
          'SELECT revision,action,detail,created_at FROM sprint_events WHERE owner=? ORDER BY revision DESC LIMIT 20',
        )
        .bind(owner),
      db
        .prepare('SELECT * FROM project_agreement WHERE project_id=?')
        .bind(owner),
    ],
  );
  const base = {
    asOf: now.toISOString(),
    sprint: s,
    checkins: checkins.results,
    events: events.results,
  };
  if (!policy)
    // 이전 규칙으로 만든 기록. 옛 계산 결과를 그대로 보여주되 변경은 막는다.
    return {
      ...base,
      lifecycle: 'legacy' as Lifecycle,
      policy: null,
      agreement: null,
      deliverables: [],
      completion: completionCheck([]),
      readiness: null,
      plan: null,
      legacySchedule: schedule(s, now),
    };
  const [members, deliverables] = await Promise.all([
    readMembers(owner),
    readDeliverables(owner),
  ]);
  return {
    ...base,
    lifecycle: effectiveLifecycle(policy, now),
    policy,
    agreement: agreement.results[0] ?? null,
    deliverables,
    completion: completionCheck(deliverables),
    readiness: startReadiness(members, policy.goalVersion, deliverables.length),
    plan: currentPlan(s, policy, members, now),
    legacySchedule: null,
  };
}
export class Conflict extends Error {}
// 정책 상태를 실제 쓰기 조건에 넣는다. 요청 시작 시각의 검사만 통과하고
// 마감이 지난 뒤 도착한 쓰기는 DB의 현재 시각 비교에서 거절된다.
const LIFECYCLES: Lifecycle[] = [
  'legacy',
  'draft',
  'active',
  'completed',
  'expired',
];
function policyGuard(states: Lifecycle[]) {
  // 내부 열거값만 사용한다. 요청 본문 문자열은 이 목록에 들어오지 않는다.
  const list = states.filter((s) => LIFECYCLES.includes(s));
  if (!list.length) throw new Error('허용 상태가 없습니다.');
  return (
    " AND EXISTS(SELECT 1 FROM project_policy p WHERE p.project_id=sprints.owner" +
    ` AND p.lifecycle IN (${list.map((s) => `'${s}'`).join(',')})` +
    " AND (p.deadline_at IS NULL OR p.deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  );
}

// One D1 transaction. Every write after compare-and-swap is gated by its unique mutation ID.
export async function save(
  owner: string,
  s: Sprint,
  action: string,
  detail: string,
  extras: (mutation: string) => D1PreparedStatement[] = () => [],
  states: Lifecycle[] | null = null,
) {
  const db = database();
  const mutation = crypto.randomUUID();
  const now = new Date().toISOString();
  const head = db
    .prepare(
      'UPDATE sprints SET revision=revision+1,mutation=?,joined=?,finished=?,updated_at=? WHERE owner=? AND revision=?' +
        (states ? policyGuard(states) : ''),
    );
  const headArgs: unknown[] = [
    mutation,
    Number(s.joined),
    Number(s.finished),
    now,
    owner,
    s.revision,
  ];
  const statements = [head.bind(...headArgs)];
  for (const t of s.tasks)
    statements.push(
      db
        .prepare(
          'UPDATE sprint_tasks SET remaining=?,deferred=?,done=?,evidence=?,status=?,description=? WHERE owner=? AND id=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
        )
        .bind(
          t.remaining,
          Number(t.deferred),
          Number(t.done),
          t.evidence,
          t.status ?? 'todo',
          t.description ?? '',
          owner,
          t.id,
          owner,
          mutation,
        ),
    );
  statements.push(...extras(mutation));
  statements.push(
    db
      .prepare(
        'INSERT INTO sprint_events(id,owner,revision,action,detail,created_at) SELECT ?,owner,revision,?,?,? FROM sprints WHERE owner=? AND mutation=?',
      )
      .bind(crypto.randomUUID(), action, detail, now, owner, mutation),
  );
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1)
    throw new Conflict(
      '다른 변경이 있거나 저장 시점에 허용되지 않는 상태입니다.',
    );
  return mutation;
}
export type { Task, Capacity };
