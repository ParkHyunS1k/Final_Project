// 도래한 예약을 확보하고, 전송 직전 최신 상태를 다시 읽고, 묶어서 전송한다.
// 전송 결과는 업무 상태나 완주 판정을 바꾸지 않는다.
import { database, readPolicy, readDeliverables } from './sprint-store';
import { effectiveLifecycle } from './sprint-policy';
import {
  claimDue,
  openBatch,
  recordBatch,
  resolveItems,
  type ClaimedRow,
} from './reminder-store';
import {
  groupBatches,
  idempotencyKey,
  remainingText,
  selectDue,
} from './reminders';
import { seoulTime } from './sprint';
import type { Sender } from './email';

const STATUS_LABEL: Record<string, string> = {
  todo: '시작 전',
  in_progress: '진행 중',
};

async function taskRow(projectId: string, taskId: number) {
  return database()
    .prepare('SELECT * FROM sprint_tasks WHERE owner=? AND id=?')
    .bind(projectId, taskId)
    .first<Record<string, unknown>>();
}

async function memberRow(projectId: string, userId: string) {
  return database()
    .prepare(
      'SELECT user_id,display_name,person,email,left_at FROM project_members WHERE project_id=? AND user_id=?',
    )
    .bind(projectId, userId)
    .first<Record<string, unknown>>();
}

type Check =
  | { ok: false; reason: string }
  | { ok: true; email: string; task: Record<string, unknown> | null };

/** 전송 직전 재확인. 무효 사유를 돌려주면 그 항목은 보내지 않는다. */
async function validate(item: ClaimedRow, now: Date): Promise<Check> {
  const policy = await readPolicy(item.projectId);
  const state = effectiveLifecycle(policy, now);
  if (state !== 'active')
    return { ok: false, reason: `프로젝트 상태 ${state}` };
  const member = await memberRow(item.projectId, item.userId);
  if (!member) return { ok: false, reason: '현재 멤버가 아님' };
  if (member.left_at) return { ok: false, reason: '참여 중단 보고' };
  const email = typeof member.email === 'string' ? member.email : '';
  // 수신 주소를 추측하지 않는다. 인증된 연락처가 없으면 발송 불가로 기록한다.
  if (!email) return { ok: false, reason: '인증된 수신 주소 없음' };
  if (item.kind === 'project') {
    if (policy!.deadlineAt !== item.dueAt)
      return { ok: false, reason: '프로젝트 기한 변경' };
    return { ok: true, email, task: null };
  }
  const task = await taskRow(item.projectId, item.taskId);
  if (!task) return { ok: false, reason: '업무 없음' };
  if (Number(task.done)) return { ok: false, reason: '업무 완료' };
  if (
    task.due_at !== item.dueAt ||
    Number(task.deadline_version) !== item.deadlineVersion
  )
    return { ok: false, reason: '승인된 마감 변경' };
  if (Number(task.person) !== Number(member.person))
    return { ok: false, reason: '담당자 변경' };
  return { ok: true, email, task };
}

async function projectTitle(projectId: string) {
  const row = await database()
    .prepare('SELECT title FROM sprints WHERE owner=?')
    .bind(projectId)
    .first<{ title: string }>();
  return row?.title ?? projectId;
}

async function projectBody(projectId: string, now: Date, deadline: string) {
  const deliverables = await readDeliverables(projectId);
  const open = await database()
    .prepare(
      'SELECT title,person FROM sprint_tasks WHERE owner=? AND done=0 ORDER BY id',
    )
    .bind(projectId)
    .all<{ title: string }>();
  const missing = deliverables.filter((d) => !d.confirmed).map((d) => d.title);
  return [
    `최종 기한: ${seoulTime(deadline)} KST (연장 없음)`,
    `${remainingText(deadline, now)}.`,
    `미확인 필수 결과물: ${missing.length ? missing.join(', ') : '없음'}`,
    `미완료 업무: ${open.results.length ? open.results.map((t) => t.title).join(', ') : '없음'}`,
  ].join('\n');
}

function taskBody(
  task: Record<string, unknown>,
  dueAt: string,
  now: Date,
  link: string,
) {
  return [
    `업무: ${String(task.title)}`,
    `승인된 마감: ${seoulTime(dueAt)} KST`,
    remainingText(dueAt, now) + '.',
    `현재 기록: ${STATUS_LABEL[String(task.status)] ?? '시작 전'} · 남은 공수 ${Number(task.remaining)}시간`,
    `업무 열기: ${link}`,
  ].join('\n');
}

/**
 * 한 번의 실행기 호출. 실제 전송은 sender가 담당하며 실패해도 사용자 데이터를
 * 바꾸지 않는다. 결과는 운영자가 확인할 수 있도록 기록만 남긴다.
 */
export async function dispatchReminders({
  now = new Date(),
  sender,
  origin,
  worker = crypto.randomUUID(),
  limit = 200,
}: {
  now?: Date;
  sender: Sender;
  origin: string;
  worker?: string;
  limit?: number;
}) {
  const claimed = await claimDue(now, worker, limit);
  const { send, skip } = selectDue(claimed, now);
  for (const s of skip)
    await resolveItems([s.item.id], 'skipped', s.reason, now);
  type Ready = ClaimedRow & {
    email: string;
    line: string;
    subjectPart: string;
  };
  const valid: Ready[] = [];
  for (const item of send) {
    const check = await validate(item, now);
    if (!check.ok) {
      await resolveItems([item.id], 'skipped', check.reason, now);
      continue;
    }
    const link =
      origin + '/?project=' + encodeURIComponent(item.projectId) + '&view=plan';
    const title = await projectTitle(item.projectId);
    valid.push({
      ...item,
      email: check.email,
      line:
        `[${title}]\n` +
        (item.kind === 'project'
          ? await projectBody(item.projectId, now, item.dueAt)
          : taskBody(check.task!, item.dueAt, now, link)),
      subjectPart:
        item.kind === 'project'
          ? '프로젝트 마감'
          : String(check.task!.title),
    });
  }
  const sent: string[] = [];
  const failed: string[] = [];
  for (const group of groupBatches(valid)) {
    let rows = group.items as Ready[];
    // 보내기 직전에 최신 시각과 업무 상태를 다시 읽는다. 목록 검사 이후
    // 완료·담당 변경·프로젝트 종료로 무효가 된 항목은 제외한다.
    const still: Ready[] = [];
    for (const row of rows) {
      const check = await validate(row, new Date());
      if (!check.ok) {
        await resolveItems([row.id], 'skipped', check.reason, now);
        continue;
      }
      still.push(row);
    }
    rows = still;
    // 남은 항목이 없으면 빈 묶음을 보내지 않는다.
    if (!rows.length) continue;
    const key = idempotencyKey(group.userId, group.scheduledAt);
    const subject = `[ProjectMate] ${rows.map((r) => r.subjectPart).join(' · ')} 마감 ${Math.min(...rows.map((r) => r.stage))}분 전`;
    const batch = await openBatch(
      rows[0].projectId,
      group.userId,
      group.scheduledAt,
      rows[0].email,
      key,
      subject,
      now,
    );
    if (!batch || batch.status === 'sent') {
      // 다른 실행기가 이미 같은 묶음을 보냈거나 보내는 중이다.
      await resolveItems(
        rows.map((r) => r.id),
        'sent',
        '같은 묶음이 이미 처리됨',
        now,
        batch?.id ?? null,
      );
      continue;
    }
    const result = await sender.send({
      to: rows[0].email,
      subject,
      // 각자의 주소로 따로 보낸다. 다른 팀원의 이메일은 본문에 넣지 않는다.
      // 여러 프로젝트가 섞이면 본문에서 프로젝트를 구분해 표시한다.
      text:
        rows.map((r) => r.line).join('\n\n') +
        '\n\n보고가 없다는 사실만으로 일을 하지 않았다고 판단하지 않습니다. ' +
        '완주 판정은 처음 합의한 결과물 기준입니다.',
      idempotencyKey: batch.idempotencyKey,
    });
    await recordBatch(
      batch.id,
      result.status,
      result.provider,
      result.status === 'sent' ? result.messageId : null,
      result.status === 'sent' ? '' : result.error,
      now,
    );
    if (result.status === 'sent') {
      // 실제로 메일에 포함한 항목만 발송 완료로 기록한다.
      await resolveItems(
        rows.map((r) => r.id),
        'sent',
        `${result.provider} 전송`,
        now,
        batch.id,
      );
      sent.push(...rows.map((r) => r.id));
    } else {
      // 전송 실패를 성공으로 기록하지 않는다. 확실한 거절만 재시도 대상으로 남긴다.
      await resolveItems(
        rows.map((r) => r.id),
        result.status === 'failed' ? 'pending' : 'failed',
        `${result.provider}: ${result.error}`,
        now,
        batch.id,
      );
      failed.push(...rows.map((r) => r.id));
    }
  }
  return {
    at: now.toISOString(),
    provider: sender.name,
    live: sender.live,
    claimed: claimed.length,
    sent: sent.length,
    failed: failed.length,
    skipped: skip.length + (send.length - valid.length),
  };
}
