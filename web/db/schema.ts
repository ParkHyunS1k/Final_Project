import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  date,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;
// Supabase는 public 테이블을 anon 키(화면 번들에 공개)로 REST에 노출한다. 모든 테이블에 RLS를 켜고
// 정책을 두지 않아 막는다. 서버는 테이블 소유자 역할로 접속하므로 영향을 받지 않는다.
export const sprints = pgTable('sprints', {
  owner: text('owner').primaryKey(),
  title: text('title').notNull(),
  // 준비 중 프로젝트는 시작 전이라 NULL.
  startDate: date('start_date', { mode: 'string' }),
  deadline: timestamp('deadline', tz),
  revision: integer('revision').notNull().default(0),
  mutation: text('mutation').notNull().default(''),
  joined: boolean('joined').notNull().default(false),
  finished: boolean('finished').notNull().default(false),
  updatedAt: timestamp('updated_at', tz).notNull(),
}).enableRLS();
export const tasks = pgTable(
  'sprint_tasks',
  {
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    id: integer('id').notNull(),
    title: text('title').notNull(),
    person: integer('person').notNull(),
    status: text('status').notNull().default('todo'),
    description: text('description').notNull().default(''),
    remaining: doublePrecision('remaining').notNull(),
    dueAt: timestamp('due_at', tz),
    deadlineVersion: integer('deadline_version').notNull().default(0),
    // 업무 단위 변경 버전. 생성 이후 수정 여부를 업무별로 판단한다.
    changeVersion: integer('change_version').notNull().default(0),
    optional: boolean('optional').notNull().default(false),
    deferred: boolean('deferred').notNull().default(false),
    done: boolean('done').notNull().default(false),
    evidence: text('evidence').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.owner, t.id] })],
).enableRLS();
export const dependencies = pgTable(
  'sprint_dependencies',
  {
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    taskId: integer('task_id').notNull(),
    dependsOn: integer('depends_on').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.taskId, t.dependsOn] })],
).enableRLS();
export const capacity = pgTable(
  'sprint_capacity',
  {
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    person: integer('person').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    hours: doublePrecision('hours').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.person, t.date] })],
).enableRLS();
export const checkins = pgTable(
  'sprint_checkins',
  {
    id: text('id').primaryKey(),
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    taskId: integer('task_id').notNull(),
    note: text('note').notNull(),
    remaining: doublePrecision('remaining').notNull(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [index('idx_checkins_owner_createdAt').on(t.owner, t.createdAt)],
).enableRLS();
export const events = pgTable(
  'sprint_events',
  {
    id: text('id').primaryKey(),
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    revision: integer('revision').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [index('idx_events_owner_revision').on(t.owner, t.revision)],
).enableRLS();

// sprints.owner remains the physical project key to preserve deployed v2 data.
export const projectDetails = pgTable('project_details', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  createdBy: text('created_by').notNull(),
  goal: text('goal').notNull(),
  deliverables: jsonb('deliverables').notNull(),
  completionCriteria: text('completion_criteria').notNull(),
  legacy: boolean('legacy').notNull().default(false),
  createdAt: timestamp('created_at', tz).notNull(),
}).enableRLS();
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    person: integer('person').notNull(),
    agreedAt: timestamp('agreed_at', tz),
    joinedAt: timestamp('joined_at', tz).notNull(),
    agreedGoalVersion: integer('agreed_goal_version').notNull().default(0),
    email: text('email'),
    leftAt: timestamp('left_at', tz),
    leftNote: text('left_note').notNull().default(''),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('idx_members_user').on(t.userId),
    uniqueIndex('idx_members_project_person').on(t.projectId, t.person),
  ],
).enableRLS();
export const projectInvites = pgTable(
  'project_invites',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    tokenHash: text('token_hash').notNull().unique(),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    createdBy: text('created_by').notNull(),
    status: text('status').notNull().default('pending'),
    acceptedBy: text('accepted_by'),
    createdAt: timestamp('created_at', tz).notNull(),
    // 초대 메일 발송 결과('sent'|'failed'|'off'), 마지막 시도 시각, 시도 횟수(다시 보내기 한도).
    emailStatus: text('email_status'),
    emailSentAt: timestamp('email_sent_at', tz),
    emailSends: integer('email_sends').notNull().default(0),
  },
  (t) => [index('idx_invites_project').on(t.projectId)],
).enableRLS();

// --- 2026-09-09 집중 스프린트 규칙 (마이그레이션 0005) ---
export const projectPolicy = pgTable('project_policy', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  lifecycle: text('lifecycle').notNull().default('draft'),
  goalVersion: integer('goal_version').notNull().default(1),
  durationDays: integer('duration_days').notNull(),
  dailyHours: doublePrecision('daily_hours').notNull().default(8),
  startedAt: timestamp('started_at', tz),
  deadlineAt: timestamp('deadline_at', tz),
  completedAt: timestamp('completed_at', tz),
  createdAt: timestamp('created_at', tz).notNull(),
}).enableRLS();
export const projectAgreement = pgTable('project_agreement', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  goalVersion: integer('goal_version').notNull(),
  title: text('title').notNull(),
  goal: text('goal').notNull(),
  scope: text('scope').notNull(),
  completionCriteria: text('completion_criteria').notNull(),
  // 시작 전 합의는 아직 고정되지 않아 NULL.
  fixedAt: timestamp('fixed_at', tz),
}).enableRLS();
export const projectDeliverables = pgTable(
  'project_deliverables',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    deliverableId: text('deliverable_id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    fixedAt: timestamp('fixed_at', tz),
    evidence: text('evidence').notNull().default(''),
    evidenceBy: text('evidence_by'),
    evidenceAt: timestamp('evidence_at', tz),
    confirmed: boolean('confirmed').notNull().default(false),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', tz),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.deliverableId] }),
    index('idx_deliverables_project_position').on(t.projectId, t.position),
  ],
).enableRLS();

// --- 마감 독촉 (마이그레이션 0006) ---
export const reminderItems = pgTable(
  'reminder_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    kind: text('kind').notNull(),
    // 프로젝트 알림은 -1. NULL은 UNIQUE에서 서로 다르게 취급되므로 쓰지 않는다.
    taskId: integer('task_id').notNull(),
    userId: text('user_id').notNull(),
    deadlineVersion: integer('deadline_version').notNull(),
    stageMinutes: integer('stage_minutes').notNull(),
    dueAt: timestamp('due_at', tz).notNull(),
    scheduledAt: timestamp('scheduled_at', tz).notNull(),
    status: text('status').notNull().default('pending'),
    batchId: text('batch_id'),
    claimOwner: text('claim_owner'),
    claimedAt: timestamp('claimed_at', tz),
    resolvedAt: timestamp('resolved_at', tz),
    detail: text('detail').notNull().default(''),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [
    uniqueIndex('idx_reminder_logical').on(
      t.projectId,
      t.kind,
      t.taskId,
      t.userId,
      t.deadlineVersion,
      t.stageMinutes,
    ),
    index('idx_reminder_due').on(t.status, t.scheduledAt),
  ],
).enableRLS();
export const reminderBatches = pgTable(
  'reminder_batches',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    userId: text('user_id').notNull(),
    scheduledAt: timestamp('scheduled_at', tz).notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull().default(''),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
    provider: text('provider').notNull().default(''),
    providerMessageId: text('provider_message_id'),
    error: text('error').notNull().default(''),
    firstAttemptAt: timestamp('first_attempt_at', tz).notNull(),
    lastAttemptAt: timestamp('last_attempt_at', tz).notNull(),
  },
  (t) => [
    // 메일은 같은 수신자·같은 예정 시각이면 프로젝트가 달라도 한 통으로 묶는다.
    uniqueIndex('idx_batch_slot').on(t.userId, t.scheduledAt),
    uniqueIndex('idx_batch_idempotency').on(t.idempotencyKey),
  ],
).enableRLS();

// --- 원문과 AI 변경안 (마이그레이션 0007) ---
export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    origin: text('origin').notNull().default(''),
    capturedAt: timestamp('captured_at', tz),
    hash: text('hash').notNull(),
    supersedes: text('supersedes'),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [index('idx_sources_project').on(t.projectId, t.createdAt)],
).enableRLS();
export const aiChangeProposals = pgTable(
  'ai_change_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    sourceId: text('source_id').notNull(),
    baseRevision: integer('base_revision').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status').notNull().default('pending'),
    error: text('error').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [index('idx_ai_proposals_project').on(t.projectId, t.createdAt)],
).enableRLS();
export const aiProposalChanges = pgTable(
  'ai_proposal_changes',
  {
    proposalId: text('proposal_id').notNull(),
    changeId: text('change_id').notNull(),
    kind: text('kind').notNull(),
    taskId: integer('task_id'),
    newKey: text('new_key'),
    before: jsonb('before').notNull(),
    after: jsonb('after').notNull(),
    evidenceStart: integer('evidence_start'),
    evidenceEnd: integer('evidence_end'),
    evidenceQuote: text('evidence_quote').notNull().default(''),
    basis: text('basis').notNull(),
    needsReview: text('needs_review').notNull().default(''),
    requires: text('requires').notNull(),
    blocked: text('blocked').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.changeId] })],
).enableRLS();
export const aiChangeApplications = pgTable(
  'ai_change_applications',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    proposalId: text('proposal_id'),
    sourceId: text('source_id'),
    reverts: text('reverts'),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', tz).notNull(),
    revision: integer('revision').notNull(),
    entries: jsonb('entries').notNull(),
  },
  (t) => [index('idx_ai_applications_project').on(t.projectId, t.approvedAt)],
).enableRLS();

// 사용자별·날짜(KST)별 초대 생성 수. 한 문장의 upsert로 늘려 동시 요청에도 하루 한도를 넘지 않게 한다.
export const inviteQuota = pgTable(
  'invite_quota',
  {
    userId: text('user_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
).enableRLS();

// 사용자별·날짜(KST)별 AI 변경안 만들기 수. 운영 모델 호출 비용을 묶는다. 초대 한도와 같은 upsert 방식.
export const aiQuota = pgTable(
  'ai_quota',
  {
    userId: text('user_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
).enableRLS();
