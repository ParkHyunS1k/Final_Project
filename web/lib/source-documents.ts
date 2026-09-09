// 붙여넣은 원문의 불변 저장. 원문은 데이터이며 프로그램 지시로 실행하지 않는다.
import { database } from './sprint-store';
import { PolicyError } from './sprint-policy';
import { text } from './utils';

export const MAX_SOURCE = 40000;

export type SourceDocument = {
  id: string;
  projectId: string;
  authorId: string;
  body: string;
  origin: string;
  capturedAt: string | null;
  hash: string;
  supersedes: string | null;
  createdAt: string;
};

export function sourceRow(row: Record<string, unknown>): SourceDocument {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    authorId: String(row.author_id),
    // 공백·줄바꿈을 포함해 받은 그대로 돌려준다.
    body: typeof row.body === 'string' ? row.body : '',
    origin: typeof row.origin === 'string' ? row.origin : '',
    capturedAt: (row.captured_at as string | null) ?? null,
    hash: String(row.hash),
    supersedes: (row.supersedes as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function hashBody(body: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** 입력 검증만 하고 윤문·정규화는 하지 않는다. */
export function sourceInput(b: Record<string, unknown>) {
  if (typeof b.body !== 'string' || !b.body.trim())
    throw new PolicyError('붙여넣을 내용을 입력해주세요.');
  if (b.body.length > MAX_SOURCE)
    throw new PolicyError(`원문은 ${MAX_SOURCE}자 이내로 붙여넣어 주세요.`);
  const origin =
    typeof b.origin === 'string' ? b.origin.trim().slice(0, 200) : '';
  let capturedAt: string | null = null;
  if (typeof b.capturedAt === 'string' && b.capturedAt.trim()) {
    const at = Date.parse(b.capturedAt);
    if (!Number.isFinite(at))
      throw new PolicyError('대화 시각 형식이 올바르지 않습니다.');
    capturedAt = new Date(at).toISOString();
  }
  const supersedes =
    typeof b.supersedes === 'string' && b.supersedes ? b.supersedes : null;
  return { body: b.body, origin, capturedAt, supersedes };
}

// 실제 INSERT에 프로젝트 상태·마감·현재 멤버십 조건을 함께 건다.
// 모델 호출이나 해시 계산이 끝난 뒤 상태가 바뀌었다면 아무것도 남지 않는다.
export const WRITABLE_PROJECT =
  " FROM project_policy p WHERE p.project_id=? AND p.lifecycle IN ('draft','active')" +
  " AND (p.deadline_at IS NULL OR p.deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))" +
  ' AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.project_id AND m.user_id=? AND m.left_at IS NULL)';

export async function createSource(
  projectId: string,
  authorId: string,
  input: ReturnType<typeof sourceInput>,
  now: Date,
) {
  const id = 's_' + crypto.randomUUID();
  const hash = await hashBody(input.body);
  if (input.supersedes) {
    const previous = await readSource(projectId, input.supersedes);
    if (!previous)
      throw new PolicyError('이전 원문을 찾을 수 없습니다.', 404);
  }
  const result = await database()
    .prepare(
      'INSERT INTO source_documents(id,project_id,author_id,body,origin,captured_at,hash,supersedes,created_at)' +
        ' SELECT ?,p.project_id,?,?,?,?,?,?,?' +
        WRITABLE_PROJECT,
    )
    .bind(
      id,
      authorId,
      input.body,
      input.origin,
      input.capturedAt,
      hash,
      input.supersedes,
      now.toISOString(),
      projectId,
      authorId,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new PolicyError(
      '저장하는 사이에 프로젝트가 종료되었거나 권한이 바뀌었습니다. 최신 상태를 확인해주세요.',
    );
  return id;
}

/** 프로젝트 경계를 함께 검사한다. ID만 알아도 다른 프로젝트의 원문은 읽지 못한다. */
export async function readSource(projectId: string, id: string) {
  const row = await database()
    .prepare('SELECT * FROM source_documents WHERE id=? AND project_id=?')
    .bind(id, projectId)
    .first<Record<string, unknown>>();
  return row ? sourceRow(row) : null;
}

export async function listSources(projectId: string, limit = 20) {
  const rows = await database()
    .prepare(
      'SELECT id,author_id,origin,captured_at,hash,supersedes,created_at,length(body) AS size FROM source_documents WHERE project_id=? ORDER BY created_at DESC LIMIT ?',
    )
    .bind(projectId, limit)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    id: String(r.id),
    authorId: String(r.author_id),
    origin: text(r.origin),
    capturedAt: (r.captured_at as string | null) ?? null,
    hash: String(r.hash),
    supersedes: (r.supersedes as string | null) ?? null,
    createdAt: String(r.created_at),
    size: Number(r.size),
  }));
}

/**
 * 같은 입력을 다시 처리했는지 확인할 수 있게 해시가 같은 이전 원문을 알려준다.
 * 해시가 다르다고 다른 대화라고, 같다고 같은 자료라고 단정하지 않고 사람이 본다.
 */
export async function sameHashSources(
  projectId: string,
  hash: string,
  exceptId: string,
) {
  const rows = await database()
    .prepare(
      'SELECT id,created_at FROM source_documents WHERE project_id=? AND hash=? AND id<>? ORDER BY created_at',
    )
    .bind(projectId, hash, exceptId)
    .all<{ id: string; created_at: string }>();
  return rows.results;
}
