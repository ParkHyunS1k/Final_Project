// 프로젝트 GitHub 저장소와 이슈 원문 위치 저장(2026-11-09).
// 저장소는 업무 revision과 분리해 자체 version으로 동시 변경을 감지한다(바꿔도 승인 대기 변경안이 무효가 되지 않음).
import { database } from './db';
import { hashBody, WRITABLE_PROJECT } from './source-documents';
import { PolicyError } from './sprint-policy';
import type { Repo } from './ai-review-github';
import type { IssueSpan } from './github-issues';
import type { AppliedEntry } from './change-proposals';

export type ProjectRepo = { owner: string; name: string; version: number };

const OWNER_NOW =
  "EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=? AND m.user_id=? AND m.role='owner' AND m.left_at IS NULL)";
// 준비·진행 중이고 마감 전인 프로젝트(WRITABLE_PROJECT와 같은 상태 조건).
const OPEN_NOW =
  "EXISTS(SELECT 1 FROM project_policy p WHERE p.project_id=? AND p.lifecycle IN ('draft','active') AND (p.deadline_at IS NULL OR p.deadline_at > now()))";

export async function readProjectRepo(projectId: string): Promise<ProjectRepo | null> {
  const r = await database()
    .prepare('SELECT repo_owner,repo_name,version FROM project_repos WHERE project_id=?')
    .bind(projectId)
    .first();
  return r ? { owner: String(r.repo_owner), name: String(r.repo_name), version: Number(r.version) } : null;
}

/** 팀장만. 처음은 expectedVersion 0. 읽은 version이 바뀌었으면 409. 기록은 같은 트랜잭션. */
export async function setProjectRepo(
  projectId: string,
  userId: string,
  repo: Repo,
  expectedVersion: number,
  now: Date,
): Promise<ProjectRepo> {
  const db = database();
  const version = expectedVersion + 1;
  // 쓰기와 기록을 한 문장으로: 실제로 쓴 행이 있을 때만 기록이 남는다.
  const write =
    expectedVersion === 0
      ? 'INSERT INTO project_repos(project_id,repo_owner,repo_name,version,updated_by,updated_at) SELECT ?,?,?,1,?,? WHERE ' +
        OWNER_NOW +
        ' AND ' +
        OPEN_NOW +
        ' ON CONFLICT (project_id) DO NOTHING RETURNING project_id'
      : 'UPDATE project_repos SET repo_owner=?,repo_name=?,version=version+1,updated_by=?,updated_at=? WHERE project_id=? AND version=? AND ' +
        OWNER_NOW +
        ' AND ' +
        OPEN_NOW +
        ' RETURNING project_id';
  const args =
    expectedVersion === 0
      ? [projectId, repo.owner, repo.name, userId, now, projectId, userId, projectId]
      : [repo.owner, repo.name, userId, now, projectId, expectedVersion, projectId, userId, projectId];
  const written = await db
    .prepare(
      `WITH w AS (${write}) INSERT INTO project_repo_events(id,project_id,user_id,repo_owner,repo_name,action,created_at)` +
        " SELECT ?,w.project_id,?,?,?,'set',? FROM w",
    )
    .bind(...args, 'pre_' + crypto.randomUUID(), userId, repo.owner, repo.name, now)
    .run();
  if (written.meta.changes !== 1) {
    const owner = await db.prepare('SELECT ' + OWNER_NOW + ' AS ok').bind(projectId, userId).first();
    if (!owner?.ok) throw new PolicyError('팀장만 저장소를 등록·변경할 수 있습니다.', 403);
    const open = await db.prepare('SELECT ' + OPEN_NOW + ' AS ok').bind(projectId).first();
    if (!open?.ok) throw new PolicyError('종료되었거나 마감이 지난 프로젝트는 저장소를 바꿀 수 없습니다.', 409);
    throw new PolicyError('다른 사람이 먼저 저장소를 바꿨습니다. 새로고침 후 다시 시도해주세요.', 409);
  }
  return { owner: repo.owner, name: repo.name, version };
}

/** 이슈 원문과 이슈별 위치를 한 트랜잭션으로 저장한다. 쓸 수 없는 프로젝트·비멤버면 null. */
export async function createIssueSource(
  projectId: string,
  userId: string,
  input: { body: string; origin: string; repo: string },
  spans: IssueSpan[],
  now: Date,
): Promise<string | null> {
  const db = database();
  const id = 's_' + crypto.randomUUID();
  const hash = await hashBody(input.body);
  const [source] = await db.batch([
    db
      .prepare(
        'INSERT INTO source_documents(id,project_id,author_id,body,origin,captured_at,hash,supersedes,created_at)' +
          ' SELECT ?,p.project_id,?,?,?,?,?,NULL,?' +
          WRITABLE_PROJECT +
          // 이슈 가져오기는 팀장만: 저장 시점에도 현재 팀장인지 함께 건다.
          ' AND ' +
          OWNER_NOW,
      )
      .bind(id, userId, input.body, input.origin, now.toISOString(), hash, now.toISOString(), projectId, userId, projectId, userId),
    ...spans.map((s) =>
      db
        .prepare(
          'INSERT INTO source_issue_spans(source_id,project_id,repo,issue_number,start,"end",author_login,author_is_member)' +
            ' SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM source_documents WHERE id=?)',
        )
        .bind(id, projectId, input.repo, s.issueNumber, s.start, s.end, s.authorLogin, s.authorIsMember, id),
    ),
  ]);
  return source.meta.changes === 1 ? id : null;
}

export async function readIssueSpans(sourceId: string): Promise<(IssueSpan & { repo: string })[]> {
  const r = await database()
    .prepare(
      'SELECT repo,issue_number,start,"end",author_login,author_is_member FROM source_issue_spans WHERE source_id=? ORDER BY start',
    )
    .bind(sourceId)
    .all();
  return r.results.map((s) => ({
    issueNumber: Number(s.issue_number),
    start: Number(s.start),
    end: Number(s.end),
    authorLogin: String(s.author_login),
    authorIsMember: Boolean(s.author_is_member),
    repo: String(s.repo),
  }));
}

/**
 * 같은 프로젝트·같은 저장소의 다른 원문에서, 되돌리지 않은 '업무 생성' 적용의 근거가 들어 있던 이슈 번호.
 * 다시 가져오기 중복 경고와 목록의 '이미 가져옴' 표시에 쓴다.
 */
export async function importedIssueNumbers(
  projectId: string,
  repo: string,
  exceptSourceId: string | null,
): Promise<Set<number>> {
  const db = database();
  const spans = await db
    .prepare(
      'SELECT source_id,issue_number,start,"end" FROM source_issue_spans WHERE project_id=? AND repo=? AND source_id<>?',
    )
    .bind(projectId, repo, exceptSourceId ?? '')
    .all();
  const numbers = new Set<number>();
  if (!spans.results.length) return numbers;
  const apps = await db
    .prepare('SELECT id,reverts,entries FROM ai_change_applications WHERE project_id=?')
    .bind(projectId)
    .all<{ id: string; reverts: string | null; entries: AppliedEntry[] }>();
  // 되돌린 변경만 뺀다(일부 되돌리기면 남은 업무는 그대로 센다).
  const reverted = new Set<string>();
  for (const r of apps.results) if (r.reverts) for (const e of r.entries) reverted.add(`${r.reverts}:${e.changeId}`);
  for (const a of apps.results)
    for (const e of a.reverts ? [] : a.entries) {
      if (reverted.has(`${a.id}:${e.changeId}`)) continue;
      const m = e.kind === 'createTask' ? /^(.+)#(\d+)-(\d+)$/.exec(e.candidateKey ?? '') : null;
      if (!m) continue;
      const [, sourceId, start, end] = [m[0], m[1], Number(m[2]), Number(m[3])] as const;
      for (const s of spans.results)
        if (s.source_id === sourceId && start < Number(s.end) && end > Number(s.start))
          numbers.add(Number(s.issue_number));
    }
  return numbers;
}
