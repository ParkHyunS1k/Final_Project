import { env } from 'cloudflare:workers';
import {
  seed,
  schedule,
  type Sprint,
  type Task,
  type Capacity,
  people,
} from './sprint';
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
export async function responseState(owner: string) {
  const s = await readSprint(owner);
  if (!s) throw new Error('프로젝트를 찾을 수 없습니다.');
  const db = database();
  const [checkins, proposals, events] = await db.batch<Record<string, unknown>>(
    [
      db
        .prepare(
          'SELECT id,task_id,note,remaining,created_at FROM sprint_checkins WHERE owner=? ORDER BY created_at DESC LIMIT 20',
        )
        .bind(owner),
      db
        .prepare(
          'SELECT id,base_revision,defer_ids,status,created_at FROM sprint_proposals WHERE owner=? ORDER BY created_at DESC LIMIT 1',
        )
        .bind(owner),
      db
        .prepare(
          'SELECT revision,action,detail,created_at FROM sprint_events WHERE owner=? ORDER BY revision DESC LIMIT 20',
        )
        .bind(owner),
    ],
  );
  return {
    asOf: new Date().toISOString(),
    sprint: s,
    schedule: schedule(s),
    checkins: checkins.results,
    proposal: proposals.results[0] ?? null,
    events: events.results,
  };
}
export class Conflict extends Error {}
// One D1 transaction. Every write after compare-and-swap is gated by its unique mutation ID.
export async function save(
  owner: string,
  s: Sprint,
  action: string,
  detail: string,
  extras: (mutation: string) => D1PreparedStatement[] = () => [],
) {
  const db = database();
  const mutation = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        'UPDATE sprints SET revision=revision+1,mutation=?,joined=?,finished=?,updated_at=? WHERE owner=? AND revision=?',
      )
      .bind(
        mutation,
        Number(s.joined),
        Number(s.finished),
        now,
        owner,
        s.revision,
      ),
  ];
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
  for (const c of s.capacity)
    statements.push(
      db
        .prepare(
          'UPDATE sprint_capacity SET hours=? WHERE owner=? AND person=? AND date=? AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)',
        )
        .bind(c.hours, owner, c.person, c.date, owner, mutation),
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
  if (result[0].meta.changes !== 1) throw new Conflict('다른 변경이 있습니다.');
}
export type { Task, Capacity };
