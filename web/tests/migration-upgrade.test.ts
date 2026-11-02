import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPglite } from '../lib/db.ts';
import { migrate } from '../scripts/migrate.ts';

const renamed = {
  '0006_career_growth.sql': '0005_career_growth.sql',
  '0007_unified_hub.sql': '0006_unified_hub.sql',
  '0008_team_interest_invitations.sql': '0007_team_interest_invitations.sql',
};

for (const previous of ['main', 'career'] as const) {
  void test(`migration upgrades ${previous} without replaying SQL or losing data`, async () => {
    const db = openPglite();
    const dir = mkdtempSync(join(tmpdir(), 'pm-upgrade-'));
    try {
      const baseline = readdirSync('db/migrations').filter((n) =>
        /^000[0-4]_.*\.sql$/.test(n),
      );
      for (const file of baseline)
        copyFileSync(join('db/migrations', file), join(dir, file));
      if (previous === 'main') {
        copyFileSync(
          'db/migrations/0005_team_join.sql',
          join(dir, '0005_team_join.sql'),
        );
      } else {
        for (const [current, old] of Object.entries(renamed)) {
          copyFileSync(join('db/migrations', current), join(dir, old));
        }
      }
      await migrate(db, dir);
      await db.exec(
        "INSERT INTO sprints(owner,title,updated_at) VALUES('preserved','Existing project',now()); INSERT INTO project_policy(project_id,duration_days,created_at) VALUES('preserved',7,now());",
      );
      if (previous === 'main') {
        await db.exec(
          "UPDATE project_policy SET listed=true WHERE project_id='preserved'; INSERT INTO project_join_requests(id,project_id,user_id,display_name,goal_version,created_at) VALUES('request','preserved','applicant','Test applicant',1,now());",
        );
      } else {
        await db.exec(
          "INSERT INTO hub_records(user_id,id,kind,payload) VALUES('owner','portfolio','portfolio','{\"text\":\"Keep this evidence\"}'); INSERT INTO hub_projects(project_id,template,scope_level,mode,listed) VALUES('preserved','{}',1,'team',true);",
        );
      }
      const applied = await migrate(db);
      if (previous === 'career')
        assert.deepEqual(applied, [
          '0005_team_join.sql',
          '0009_merge_project_policy.sql',
        ]);
      assert.deepEqual(await migrate(db), []);
      assert.equal(
        (
          await db
            .prepare("SELECT title FROM sprints WHERE owner='preserved'")
            .first<{ title: string }>()
        )?.title,
        'Existing project',
      );
      const policy = await db
        .prepare(
          "SELECT listed,min_members FROM project_policy WHERE project_id='preserved'",
        )
        .first<{ listed: boolean; min_members: number }>();
      assert.equal(policy?.listed, true);
      assert.equal(policy?.min_members, 1);
      if (previous === 'main') {
        assert.equal(
          (
            await db
              .prepare(
                "SELECT status FROM project_join_requests WHERE id='request'",
              )
              .first<{ status: string }>()
          )?.status,
          'pending',
        );
      } else {
        assert.equal(
          (
            await db
              .prepare(
                "SELECT payload->>'text' AS text FROM hub_records WHERE id='portfolio'",
              )
              .first<{ text: string }>()
          )?.text,
          'Keep this evidence',
        );
        for (const [current, old] of Object.entries(renamed)) {
          const history = await db
            .prepare(
              'SELECT name,applied_at FROM _migrations WHERE name IN (?,?)',
            )
            .bind(current, old)
            .all<{ name: string; applied_at: Date }>();
          assert.equal(history.results.length, 2);
          assert.equal(
            history.results[0].applied_at.getTime(),
            history.results[1].applied_at.getTime(),
          );
        }
      }
      const withoutRls = await db
        .prepare(
          "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity",
        )
        .all();
      assert.deepEqual(withoutRls.results, []);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true });
    }
  });
}
