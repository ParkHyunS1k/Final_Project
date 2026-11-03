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
const reviewRenamed = {
  '0010_peer_reviews.sql': '0006_peer_reviews.sql',
  '0011_learning_review.sql': '0007_learning_review.sql',
};

for (const previous of [
  'main',
  'career',
  'merged-career',
  'review-main',
] as const) {
  void test(`migration upgrades ${previous} without replaying SQL or losing data`, async () => {
    const db = openPglite();
    const dir = mkdtempSync(join(tmpdir(), 'pm-upgrade-'));
    try {
      const baseline = readdirSync('db/migrations').filter((n) =>
        /^000[0-4]_.*\.sql$/.test(n),
      );
      for (const file of baseline)
        copyFileSync(join('db/migrations', file), join(dir, file));
      if (previous !== 'career') {
        copyFileSync(
          'db/migrations/0005_team_join.sql',
          join(dir, '0005_team_join.sql'),
        );
      }
      if (previous === 'career') {
        for (const [current, old] of Object.entries(renamed)) {
          copyFileSync(join('db/migrations', current), join(dir, old));
        }
      }
      if (previous === 'merged-career') {
        for (const name of [
          ...Object.keys(renamed),
          '0009_merge_project_policy.sql',
        ])
          copyFileSync(join('db/migrations', name), join(dir, name));
      }
      if (previous === 'review-main') {
        for (const [current, old] of Object.entries(reviewRenamed))
          copyFileSync(join('db/migrations', current), join(dir, old));
      }
      await migrate(db, dir);
      await db.exec(
        "INSERT INTO sprints(owner,title,updated_at) VALUES('preserved','Existing project',now()); INSERT INTO project_policy(project_id,duration_days,created_at) VALUES('preserved',7,now());",
      );
      if (previous === 'main' || previous === 'review-main') {
        await db.exec(
          "UPDATE project_policy SET listed=true WHERE project_id='preserved'; INSERT INTO project_join_requests(id,project_id,user_id,display_name,goal_version,created_at) VALUES('request','preserved','applicant','Test applicant',1,now());",
        );
      } else {
        await db.exec(
          "INSERT INTO hub_records(user_id,id,kind,payload) VALUES('owner','portfolio','portfolio','{\"text\":\"Keep this evidence\"}'); INSERT INTO hub_projects(project_id,template,scope_level,mode,listed) VALUES('preserved','{}',1,'team',true);",
        );
      }
      if (previous === 'merged-career')
        await db.exec(
          "UPDATE project_policy SET listed=true WHERE project_id='preserved';",
        );
      if (previous === 'review-main') {
        await db.exec(`
          INSERT INTO peer_review_submissions(id,project_id,reviewer_id,created_at)
            VALUES('submission','preserved','owner',now());
          INSERT INTO peer_reviews(project_id,reviewer_id,reviewee_id,contribution,communication,commitment,submission_id)
            VALUES('preserved','owner','mate',4,5,3,'submission');
          INSERT INTO review_links(project_id,user_id,repo_owner,repo_name,github_login,updated_at)
            VALUES('preserved','owner','synthetic','example','learner',now());
          INSERT INTO learning_reviews(id,project_id,user_id,kind,day,status,repo,github_login,commit_count,commits,digest,questions,answers,feedback,gaps,model,created_at,answered_at)
            VALUES('review','preserved','owner','daily','2026-11-03','answered','synthetic/example','learner',1,'[]','Keep digest','[]','[]','[]','[]','fake',now(),now());
        `);
      }
      const applied = await migrate(db);
      if (previous === 'career')
        assert.deepEqual(applied, [
          '0005_team_join.sql',
          '0009_merge_project_policy.sql',
          '0010_peer_reviews.sql',
          '0011_learning_review.sql',
          '0012_career_profile_writes.sql',
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
      if (previous === 'main' || previous === 'review-main') {
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
      }
      const aliases =
        previous === 'career'
          ? renamed
          : previous === 'review-main'
            ? reviewRenamed
            : {};
      for (const [current, old] of Object.entries(aliases)) {
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
      if (previous === 'review-main') {
        assert.equal(
          (
            await db
              .prepare(
                "SELECT communication FROM peer_reviews WHERE project_id='preserved'",
              )
              .first<{ communication: number }>()
          )?.communication,
          5,
        );
        assert.equal(
          (
            await db
              .prepare("SELECT digest FROM learning_reviews WHERE id='review'")
              .first<{ digest: string }>()
          )?.digest,
          'Keep digest',
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT github_login FROM review_links WHERE project_id='preserved'",
              )
              .first<{ github_login: string }>()
          )?.github_login,
          'learner',
        );
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
