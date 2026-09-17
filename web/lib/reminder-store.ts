// 예약 항목의 고유성, 취소, 원자적 확보, 발송 시도 기록.
// 예약 갱신은 업무 저장과 같은 트랜잭션(save의 extras)에서 실행한다.
import { database } from './sprint-store';
import {
  futureStages,
  PROJECT_TASK_ID,
  type DueItem,
  type Kind,
} from './reminders';

const gate = ' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)';

/**
 * 미래 단계만 예약한다. 같은 논리적 항목이 이미 있으면 새로 만들지 않고,
 * 취소된 항목만 다시 살린다. 이미 보낸 단계는 담당자가 돌아와도 재발송되지 않는다.
 */
export function scheduleStatements(
  projectId: string,
  mutation: string,
  entries: {
    kind: Kind;
    taskId?: number;
    userId: string;
    deadlineVersion: number;
    dueAt: string;
  }[],
  now: Date,
) {
  const db = database();
  const statements = [];
  for (const e of entries) {
    const taskId = e.kind === 'task' ? e.taskId! : PROJECT_TASK_ID;
    for (const s of futureStages(e.kind, e.dueAt, now))
      statements.push(
        db
          .prepare(
            'INSERT INTO reminder_items(id,project_id,kind,task_id,user_id,deadline_version,stage_minutes,due_at,scheduled_at,created_at)' +
              ' SELECT ?,owner,?,?,?,?,?,?,?,? FROM sprints WHERE owner=? AND mutation=?' +
              " ON CONFLICT DO UPDATE SET status='pending',batch_id=NULL,claim_owner=NULL,claimed_at=NULL,resolved_at=NULL,detail=''" +
              " WHERE reminder_items.status='cancelled'",
          )
          .bind(
            crypto.randomUUID(),
            e.kind,
            taskId,
            e.userId,
            e.deadlineVersion,
            s.stage,
            e.dueAt,
            s.scheduledAt,
            now.toISOString(),
            projectId,
            mutation,
          ),
      );
  }
  return statements;
}

/** 미발송 예약만 취소한다. 과거 발송 기록은 지우지 않는다. */
export function cancelStatements(
  projectId: string,
  mutation: string,
  where: { kind?: Kind; taskId?: number; userId?: string; reason: string },
) {
  const clauses = ['project_id=?', "status='pending'"];
  const args: unknown[] = [where.reason, projectId];
  if (where.kind) {
    clauses.push('kind=?');
    args.push(where.kind);
  }
  if (where.taskId !== undefined) {
    clauses.push('task_id=?');
    args.push(where.taskId);
  }
  if (where.userId) {
    clauses.push('user_id=?');
    args.push(where.userId);
  }
  return [
    database()
      .prepare(
        "UPDATE reminder_items SET status='cancelled',detail=? WHERE " +
          clauses.join(' AND ') +
          gate,
      )
      .bind(...args, projectId, mutation),
  ];
}

export type ClaimedRow = DueItem;

/**
 * 도래한 항목을 수신자 단위로 원자적으로 확보한다.
 * 한 통에 들어갈 항목이 나뉘지 않도록 한 수신자의 도래 항목을 전부 함께 가져간다.
 * `limit`은 개별 예약 수가 아니라 한 번에 처리할 수신자 수다.
 * 확보 후 프로세스가 중단되면 `staleAfterMs` 뒤 다른 실행기가 다시 가져간다.
 */
export async function claimDue(
  now: Date,
  worker: string,
  limit = 50,
  staleAfterMs = 5 * 60000,
) {
  const db = database();
  const at = now.toISOString();
  const stale = new Date(now.getTime() - staleAfterMs).toISOString();
  const claimable =
    " AND (status='pending' OR (status='claimed' AND claimed_at<?))";
  const users = await db
    .prepare(
      'SELECT user_id,min(scheduled_at) AS first_at FROM reminder_items WHERE scheduled_at<=?' +
        claimable +
        ' GROUP BY user_id ORDER BY first_at LIMIT ?',
    )
    .bind(at, stale, limit)
    .all<{ user_id: string }>();
  for (const row of users.results)
    await db
      .prepare(
        "UPDATE reminder_items SET status='claimed',claim_owner=?,claimed_at=?" +
          ' WHERE user_id=? AND scheduled_at<=?' +
          claimable,
      )
      .bind(worker, at, row.user_id, at, stale)
      .run();
  const rows = await db
    .prepare(
      "SELECT * FROM reminder_items WHERE claim_owner=? AND status='claimed' ORDER BY scheduled_at",
    )
    .bind(worker)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    kind: String(r.kind) as Kind,
    taskId: Number(r.task_id),
    userId: String(r.user_id),
    deadlineVersion: Number(r.deadline_version),
    stage: Number(r.stage_minutes),
    dueAt: String(r.due_at),
    scheduledAt: String(r.scheduled_at),
  })) satisfies ClaimedRow[];
}

export async function resolveItems(
  ids: string[],
  status: 'sent' | 'skipped' | 'cancelled' | 'failed' | 'pending',
  detail: string,
  now: Date,
  batchId: string | null = null,
) {
  if (!ids.length) return;
  const db = database();
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          'UPDATE reminder_items SET status=?,detail=?,resolved_at=?,batch_id=?,claim_owner=NULL WHERE id=?',
        )
        .bind(status, detail, now.toISOString(), batchId, id),
    ),
  );
}

/**
 * 수신자와 예정 시각당 하나의 발송 묶음만 만든다. 병렬 실행기가 같은 시점의
 * 항목을 나눠 별도 메일을 만들지 못하도록 DB 고유성으로 막는다.
 * 이미 있으면 기존 묶음을 돌려주며, 재시도는 같은 전송 식별자를 쓴다.
 */
export async function openBatch(
  projectId: string,
  userId: string,
  scheduledAt: string,
  email: string,
  key: string,
  subject: string,
  now: Date,
) {
  const db = database();
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO reminder_batches(id,project_id,user_id,scheduled_at,email,subject,status,attempts,idempotency_key,first_attempt_at,last_attempt_at) VALUES(?,?,?,?,?,?,'sending',1,?,?,?)" +
        ' ON CONFLICT(user_id,scheduled_at) DO UPDATE SET attempts=reminder_batches.attempts+1,last_attempt_at=?,email=?,subject=?' +
        " WHERE reminder_batches.status IN ('failed','unknown')",
    )
    .bind(
      id,
      projectId,
      userId,
      scheduledAt,
      email,
      subject,
      key,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      email,
      subject,
    )
    .run();
  const row = await db
    .prepare(
      'SELECT * FROM reminder_batches WHERE user_id=? AND scheduled_at=?',
    )
    .bind(userId, scheduledAt)
    .first<Record<string, unknown>>();
  return row
    ? {
        id: String(row.id),
        status: String(row.status),
        attempts: Number(row.attempts),
        idempotencyKey: String(row.idempotency_key),
      }
    : null;
}

export async function recordBatch(
  batchId: string,
  status: 'sent' | 'failed' | 'unknown',
  provider: string,
  messageId: string | null,
  error: string,
  now: Date,
) {
  await database()
    .prepare(
      'UPDATE reminder_batches SET status=?,provider=?,provider_message_id=?,error=?,last_attempt_at=? WHERE id=?',
    )
    .bind(status, provider, messageId, error, now.toISOString(), batchId)
    .run();
}
