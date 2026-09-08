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
