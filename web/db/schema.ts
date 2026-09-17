import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
export const sprints = sqliteTable('sprints', {
  owner: text('owner').primaryKey(),
  title: text('title').notNull(),
  startDate: text('start_date').notNull(),
  deadline: text('deadline').notNull(),
  revision: integer('revision').notNull().default(0),
  mutation: text('mutation').notNull().default(''),
  joined: integer('joined').notNull().default(0),
  finished: integer('finished').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});
export const tasks = sqliteTable(
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
    remaining: real('remaining').notNull(),
    dueAt: text('due_at'),
    deadlineVersion: integer('deadline_version').notNull().default(0),
    // 업무 단위 변경 버전. 생성 이후 수정 여부를 업무별로 판단한다.
    changeVersion: integer('change_version').notNull().default(0),
    optional: integer('optional').notNull().default(0),
    deferred: integer('deferred').notNull().default(0),
    done: integer('done').notNull().default(0),
    evidence: text('evidence').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.owner, t.id] })],
);
export const dependencies = sqliteTable(
  'sprint_dependencies',
  {
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    taskId: integer('task_id').notNull(),
    dependsOn: integer('depends_on').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.taskId, t.dependsOn] })],
);
export const capacity = sqliteTable(
  'sprint_capacity',
  {
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    person: integer('person').notNull(),
    date: text('date').notNull(),
    hours: real('hours').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.person, t.date] })],
);
export const checkins = sqliteTable(
  'sprint_checkins',
  {
    id: text('id').primaryKey(),
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    taskId: integer('task_id').notNull(),
    note: text('note').notNull(),
    remaining: real('remaining').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_checkins_owner_createdAt').on(t.owner, t.createdAt)],
);
export const proposals = sqliteTable(
  'sprint_proposals',
  {
    id: text('id').primaryKey(),
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    baseRevision: integer('base_revision').notNull(),
    deferIds: text('defer_ids').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_proposals_owner_createdAt').on(t.owner, t.createdAt)],
);
export const events = sqliteTable(
  'sprint_events',
  {
    id: text('id').primaryKey(),
    owner: text('owner')
      .notNull()
      .references(() => sprints.owner),
    revision: integer('revision').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_events_owner_revision').on(t.owner, t.revision)],
);

// sprints.owner remains the physical project key to preserve deployed v2 data.
export const projectDetails = sqliteTable('project_details', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  createdBy: text('created_by').notNull(),
  goal: text('goal').notNull(),
  deliverables: text('deliverables').notNull(),
  completionCriteria: text('completion_criteria').notNull(),
  legacy: integer('legacy').notNull().default(0),
  createdAt: text('created_at').notNull(),
});
export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    person: integer('person').notNull(),
    agreedAt: text('agreed_at'),
    joinedAt: text('joined_at').notNull(),
    agreedGoalVersion: integer('agreed_goal_version').notNull().default(0),
    email: text('email'),
    leftAt: text('left_at'),
    leftNote: text('left_note').notNull().default(''),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('idx_members_user').on(t.userId),
    uniqueIndex('idx_members_project_person').on(t.projectId, t.person),
  ],
);
export const projectInvites = sqliteTable(
  'project_invites',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    tokenHash: text('token_hash').notNull().unique(),
    email: text('email').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    status: text('status').notNull().default('pending'),
    acceptedBy: text('accepted_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_invites_project').on(t.projectId)],
);

// --- 2026-09-09 집중 스프린트 규칙 (마이그레이션 0005) ---
export const projectPolicy = sqliteTable('project_policy', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  lifecycle: text('lifecycle').notNull().default('draft'),
  goalVersion: integer('goal_version').notNull().default(1),
  durationDays: integer('duration_days').notNull(),
  dailyHours: real('daily_hours').notNull().default(8),
  startedAt: text('started_at'),
  deadlineAt: text('deadline_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
});
export const projectAgreement = sqliteTable('project_agreement', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => sprints.owner),
  goalVersion: integer('goal_version').notNull(),
  title: text('title').notNull(),
  goal: text('goal').notNull(),
  scope: text('scope').notNull(),
  completionCriteria: text('completion_criteria').notNull(),
  fixedAt: text('fixed_at').notNull(),
});
export const projectDeliverables = sqliteTable(
  'project_deliverables',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    deliverableId: text('deliverable_id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    fixedAt: text('fixed_at'),
    evidence: text('evidence').notNull().default(''),
    evidenceBy: text('evidence_by'),
    evidenceAt: text('evidence_at'),
    confirmed: integer('confirmed').notNull().default(0),
    confirmedBy: text('confirmed_by'),
    confirmedAt: text('confirmed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.deliverableId] }),
    index('idx_deliverables_project_position').on(t.projectId, t.position),
  ],
);

// --- 마감 독촉 (마이그레이션 0006) ---
export const reminderItems = sqliteTable(
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
    dueAt: text('due_at').notNull(),
    scheduledAt: text('scheduled_at').notNull(),
    status: text('status').notNull().default('pending'),
    batchId: text('batch_id'),
    claimOwner: text('claim_owner'),
    claimedAt: text('claimed_at'),
    resolvedAt: text('resolved_at'),
    detail: text('detail').notNull().default(''),
    createdAt: text('created_at').notNull(),
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
);
export const reminderBatches = sqliteTable(
  'reminder_batches',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    userId: text('user_id').notNull(),
    scheduledAt: text('scheduled_at').notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull().default(''),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
    provider: text('provider').notNull().default(''),
    providerMessageId: text('provider_message_id'),
    error: text('error').notNull().default(''),
    firstAttemptAt: text('first_attempt_at').notNull(),
    lastAttemptAt: text('last_attempt_at').notNull(),
  },
  (t) => [
    // 메일은 같은 수신자·같은 예정 시각이면 프로젝트가 달라도 한 통으로 묶는다.
    uniqueIndex('idx_batch_slot').on(t.userId, t.scheduledAt),
    uniqueIndex('idx_batch_idempotency').on(t.idempotencyKey),
  ],
);

// --- 원문과 AI 변경안 (마이그레이션 0007) ---
export const sourceDocuments = sqliteTable(
  'source_documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => sprints.owner),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    origin: text('origin').notNull().default(''),
    capturedAt: text('captured_at'),
    hash: text('hash').notNull(),
    supersedes: text('supersedes'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_sources_project').on(t.projectId, t.createdAt)],
);
export const aiChangeProposals = sqliteTable(
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
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_ai_proposals_project').on(t.projectId, t.createdAt)],
);
export const aiProposalChanges = sqliteTable(
  'ai_proposal_changes',
  {
    proposalId: text('proposal_id').notNull(),
    changeId: text('change_id').notNull(),
    kind: text('kind').notNull(),
    taskId: integer('task_id'),
    newKey: text('new_key'),
    before: text('before').notNull(),
    after: text('after').notNull(),
    evidenceStart: integer('evidence_start'),
    evidenceEnd: integer('evidence_end'),
    evidenceQuote: text('evidence_quote').notNull().default(''),
    basis: text('basis').notNull(),
    needsReview: text('needs_review').notNull().default(''),
    requires: text('requires').notNull(),
    blocked: text('blocked').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.changeId] })],
);
export const aiChangeApplications = sqliteTable(
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
    approvedAt: text('approved_at').notNull(),
    revision: integer('revision').notNull(),
    entries: text('entries').notNull(),
  },
  (t) => [index('idx_ai_applications_project').on(t.projectId, t.approvedAt)],
);
