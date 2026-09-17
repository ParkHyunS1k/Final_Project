// Drizzle 스키마 정의와 실제 적용된 마이그레이션이 일치하는지 확인한다.
// 이미 적용한 마이그레이션은 지우거나 다시 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  cpSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = readdirSync('drizzle')
  .filter((n) => n.endsWith('.sql'))
  .sort();

function migrate(db, only = files) {
  for (const name of only) db.exec(readFileSync('drizzle/' + name, 'utf8'));
}

/** 기존 기록이 있는 DB를 만든다. 후속 마이그레이션이 이 값을 보존해야 한다. */
function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  db.exec(`
    INSERT INTO sprints(owner,title,start_date,deadline,revision,updated_at)
      VALUES('p1','기존 프로젝트','','',7,'2026-09-09T00:00:00Z');
    INSERT INTO project_policy(project_id,lifecycle,goal_version,duration_days,deadline_at,created_at)
      VALUES('p1','active',3,9,'2026-09-20T09:00:00.000Z','2026-09-09T00:00:00Z');
    INSERT INTO project_members(project_id,user_id,display_name,role,person,joined_at,agreed_goal_version,email)
      VALUES('p1','u1','팀장','owner',0,'2026-09-09T00:00:00Z',3,'u1@test.local');
    INSERT INTO sprint_tasks(owner,id,title,person,remaining,due_at,deadline_version,evidence,description)
      VALUES('p1',1,'마감 있는 업무',0,4,'2026-09-19T09:00:00.000Z',2,'확인 완료','설명 보존');
    INSERT INTO sprint_capacity(owner,person,date,hours) VALUES('p1',0,'2026-09-09',3);
    INSERT INTO reminder_items(id,project_id,kind,task_id,user_id,deadline_version,stage_minutes,due_at,scheduled_at,created_at)
      VALUES('r1','p1','task',1,'u1',2,60,'2026-09-19T09:00:00.000Z','2026-09-19T08:00:00.000Z','2026-09-09T00:00:00Z');
    INSERT INTO source_documents(id,project_id,author_id,body,hash,created_at)
      VALUES('s1','p1','u1','원문  그대로\n보존','h','2026-09-09T00:00:00Z');
  `);
  return db;
}

test('빈 DB와 기존 데이터가 있는 DB 모두에 전체 마이그레이션이 적용된다', () => {
  const empty = new DatabaseSync(':memory:');
  try {
    empty.exec('PRAGMA foreign_keys=ON');
    migrate(empty);
    const tables = empty
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const required of [
      'project_policy',
      'project_agreement',
      'project_deliverables',
      'reminder_items',
      'reminder_batches',
      'source_documents',
      'ai_change_proposals',
      'ai_proposal_changes',
      'ai_change_applications',
    ])
      assert.ok(tables.includes(required), `${required} 누락`);
  } finally {
    empty.close();
  }
  const db = seeded();
  try {
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM sprint_tasks').get().n,
      1,
    );
  } finally {
    db.close();
  }
});

test('스키마 정의로 후속 마이그레이션을 만들면 변경 사항이 없다', () => {
  // drizzle/은 그대로 두고 복사본에서 생성해 본다.
  const dir = mkdtempSync(join(tmpdir(), 'projectmate-drizzle-'));
  const out = '.drizzle-check';
  const config = 'drizzle-check.config.ts';
  try {
    rmSync(out, { recursive: true, force: true });
    cpSync('drizzle', out, { recursive: true });
    writeFileSync(
      config,
      `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './db/schema.ts', out: './${out}', dialect: 'sqlite' });\n`,
    );
    execFileSync('npx', ['drizzle-kit', 'generate', `--config=${config}`], {
      stdio: 'pipe',
    });
    const after = readdirSync(out)
      .filter((n) => n.endsWith('.sql'))
      .sort();
    const added = after.filter((n) => !files.includes(n));
    const extra = added.map((n) => readFileSync(join(out, n), 'utf8').trim());
    // 스키마와 적용본이 같으면 새 SQL이 없거나 비어 있어야 한다.
    assert.deepEqual(
      extra.filter(Boolean),
      [],
      `스키마와 마이그레이션이 어긋납니다:\n${extra.join('\n')}`,
    );
    // 생성된 빈 마이그레이션이 있어도 기존 데이터는 그대로 적용된다.
    const db = seeded();
    try {
      for (const name of added) db.exec(readFileSync(join(out, name), 'utf8'));
      const task = db.prepare('SELECT * FROM sprint_tasks').get();
      assert.equal(task.due_at, '2026-09-19T09:00:00.000Z');
      assert.equal(task.deadline_version, 2);
      assert.equal(task.description, '설명 보존');
      assert.equal(task.evidence, '확인 완료');
      assert.equal(
        db.prepare('SELECT goal_version FROM project_policy').get().goal_version,
        3,
      );
      assert.equal(db.prepare('SELECT revision FROM sprints').get().revision, 7);
      assert.equal(
        db.prepare('SELECT hours FROM sprint_capacity').get().hours,
        3,
      );
      assert.equal(
        db.prepare('SELECT body FROM source_documents').get().body,
        '원문  그대로\n보존',
      );
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM reminder_items').get().n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(config, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('저널의 모든 항목에 스냅샷이 있고 prevId가 이어진다', () => {
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  );
  let prev = '';
  for (const entry of journal.entries) {
    const snapshot = JSON.parse(
      readFileSync(
        `drizzle/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`,
        'utf8',
      ),
    );
    if (prev) assert.equal(snapshot.prevId, prev, `idx ${entry.idx} 체인 끊김`);
    prev = snapshot.id;
    assert.ok(
      files.some((f) => f.startsWith(String(entry.idx).padStart(4, '0'))),
      `idx ${entry.idx}의 SQL 파일 없음`,
    );
  }
  assert.equal(journal.entries.length, files.length);
});
