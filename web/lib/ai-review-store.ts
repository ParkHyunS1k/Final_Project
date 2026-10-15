// 학습 확인 저장·조회. 본인 기록만 읽고 쓴다(다른 팀원의 질문·답은 돌려주지 않는다).
import { database } from './db';
import type { Answer, Feedback, Question, ReviewKind } from './ai-review';

// 한국 시간(UTC+9, 일광절약 없음) 기준 날짜와 그날 0시.
const KST_MS = 9 * 60 * 60 * 1000;
export function kstDay(at: Date): string {
  return new Date(at.getTime() + KST_MS).toISOString().slice(0, 10);
}
export function kstDayStart(at: Date): Date {
  return new Date(Date.parse(kstDay(at) + 'T00:00:00Z') - KST_MS);
}

export type ReviewLink = { repoOwner: string; repoName: string; githubLogin: string };

export type ReviewRow = {
  reviewId: string;
  kind: ReviewKind;
  day: string;
  status: 'asked' | 'answered';
  repo: string;
  githubLogin: string;
  commitCount: number;
  questions: Question[];
  answers: Answer[] | null;
  feedback: Feedback[] | null;
  gaps: string[] | null;
  model: string;
  createdAt: Date;
  answeredAt: Date | null;
};

function toRow(r: Record<string, unknown>): ReviewRow {
  return {
    reviewId: String(r.id),
    kind: r.kind as ReviewKind,
    day: String(r.day),
    status: r.status as ReviewRow['status'],
    repo: String(r.repo),
    githubLogin: String(r.github_login),
    commitCount: Number(r.commit_count),
    questions: r.questions as Question[],
    answers: (r.answers as Answer[] | null) ?? null,
    feedback: (r.feedback as Feedback[] | null) ?? null,
    gaps: (r.gaps as string[] | null) ?? null,
    model: String(r.model),
    createdAt: r.created_at as Date,
    answeredAt: (r.answered_at as Date | null) ?? null,
  };
}

export async function readLink(projectId: string, userId: string): Promise<ReviewLink | null> {
  const r = await database()
    .prepare('SELECT repo_owner,repo_name,github_login FROM review_links WHERE project_id=? AND user_id=?')
    .bind(projectId, userId)
    .first<Record<string, unknown>>();
  return r
    ? { repoOwner: String(r.repo_owner), repoName: String(r.repo_name), githubLogin: String(r.github_login) }
    : null;
}

/** 저장 시점에도 현재 멤버(탈퇴 안 함)일 때만 쓴다. */
export async function saveLink(projectId: string, userId: string, link: ReviewLink, now: Date) {
  const r = await database()
    .prepare(
      'INSERT INTO review_links(project_id,user_id,repo_owner,repo_name,github_login,updated_at)' +
        ' SELECT ?,?,?,?,?,? FROM project_members WHERE project_id=? AND user_id=? AND left_at IS NULL' +
        ' ON CONFLICT (project_id,user_id) DO UPDATE SET repo_owner=excluded.repo_owner,repo_name=excluded.repo_name,github_login=excluded.github_login,updated_at=excluded.updated_at',
    )
    .bind(projectId, userId, link.repoOwner, link.repoName, link.githubLogin, now.toISOString(), projectId, userId)
    .run();
  return r.meta.changes === 1;
}

export async function findReview(projectId: string, userId: string, kind: ReviewKind, day: string) {
  const r = await database()
    .prepare('SELECT * FROM learning_reviews WHERE project_id=? AND user_id=? AND kind=? AND day=?')
    .bind(projectId, userId, kind, day)
    .first<Record<string, unknown>>();
  return r ? toRow(r) : null;
}

/** 본인 기록만. 다른 사용자의 id를 넣으면 없는 것과 같다. */
export async function readOwnReview(reviewId: string, userId: string) {
  const r = await database()
    .prepare('SELECT * FROM learning_reviews WHERE id=? AND user_id=?')
    .bind(reviewId, userId)
    .first<Record<string, unknown>>();
  return r ? { projectId: String(r.project_id), digest: String(r.digest), row: toRow(r) } : null;
}

export async function listOwnReviews(projectId: string, userId: string) {
  const rows = await database()
    .prepare('SELECT * FROM learning_reviews WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 30')
    .bind(projectId, userId)
    .all<Record<string, unknown>>();
  return rows.results.map(toRow);
}

/** 하루 한도 한 칸을 잡는다. 한 문장의 upsert라 동시 요청에도 한도를 넘지 않는다. 못 잡으면 false. */
export async function takeQuota(userId: string, day: string, limit: number) {
  const r = await database()
    .prepare(
      'INSERT INTO review_quota(user_id,day,n) VALUES(?,?,1) ON CONFLICT (user_id,day) DO UPDATE SET n=review_quota.n+1 WHERE review_quota.n < ? RETURNING n',
    )
    .bind(userId, day, limit)
    .first();
  return !!r;
}
export async function refundQuota(userId: string, day: string) {
  await database()
    .prepare('UPDATE review_quota SET n=n-1 WHERE user_id=? AND day=? AND n>0')
    .bind(userId, day)
    .run();
}
export async function usedQuota(userId: string, day: string) {
  const r = await database()
    .prepare('SELECT n FROM review_quota WHERE user_id=? AND day=?')
    .bind(userId, day)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** 질문을 만든 확인을 저장한다. 같은 날·종류가 이미 있으면(동시 요청) 쓰지 않고 false.
 * 저장 시점에도 현재 멤버여야 한다. */
export async function insertReview(v: {
  id: string;
  projectId: string;
  userId: string;
  kind: ReviewKind;
  day: string;
  repo: string;
  githubLogin: string;
  commits: { sha: string; message: string; date: string }[];
  digest: string;
  questions: Question[];
  model: string;
  now: Date;
}) {
  const r = await database()
    .prepare(
      'INSERT INTO learning_reviews(id,project_id,user_id,kind,day,status,repo,github_login,commit_count,commits,digest,questions,model,created_at)' +
        " SELECT ?,?,?,?,?,'asked',?,?,?,?,?,?,?,? FROM project_members WHERE project_id=? AND user_id=? AND left_at IS NULL" +
        ' ON CONFLICT (project_id,user_id,kind,day) DO NOTHING',
    )
    .bind(
      v.id,
      v.projectId,
      v.userId,
      v.kind,
      v.day,
      v.repo,
      v.githubLogin,
      v.commits.length,
      v.commits,
      v.digest,
      v.questions,
      v.model,
      v.now.toISOString(),
      v.projectId,
      v.userId,
    )
    .run();
  return r.meta.changes === 1;
}

/** 답과 채점을 한 번만 저장한다. 이미 답한 확인(중복 요청)은 바꾸지 않고 false. */
export async function saveAnswer(
  reviewId: string,
  userId: string,
  v: { answers: Answer[]; feedback: Feedback[]; gaps: string[]; now: Date },
) {
  const r = await database()
    .prepare(
      "UPDATE learning_reviews SET status='answered',answers=?,feedback=?,gaps=?,answered_at=? WHERE id=? AND user_id=? AND status='asked'",
    )
    .bind(v.answers, v.feedback, v.gaps, v.now.toISOString(), reviewId, userId)
    .run();
  return r.meta.changes === 1;
}
