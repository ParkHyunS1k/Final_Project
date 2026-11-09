'use client';
// GitHub 이슈 가져오기(2026-11-09). 팀장이 저장소를 등록하고, 열린 이슈 중 고른 것만 원문으로 가져온다.
// 가져온 원문은 기존 '변경안 만들기'로 이어진다. 서버가 팀장 여부·공개 저장소·번호를 다시 검사한다.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase-browser';

export type PickerIssue = {
  number: number;
  title: string;
  author: string;
  authorIsMember: boolean;
  assignees: string[];
  labels: string[];
  url: string;
  imported: boolean;
};
type RepoView = { owner: string; name: string; version: number; url: string } | null;
type Excluded = { number: number; reason: 'closed' | 'pull_request' | 'missing' };

const REASON: Record<Excluded['reason'], string> = { closed: '닫힘', pull_request: 'PR', missing: '없음' };

async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await apiFetch(path, {
    cache: 'no-store',
    ...(body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? '처리하지 못했습니다.');
  return data;
}

/** 처음 체크: 이미 가져온 이슈만 해제한다(팀원 아님도 체크, 사용자 결정 2026-11-09). */
export function initialChecked(issues: PickerIssue[]): Record<number, boolean> {
  return Object.fromEntries(issues.map((i) => [i.number, !i.imported]));
}

export function GithubIssuePicker({
  issues,
  checked,
  busy,
  onToggle,
  onImport,
}: {
  issues: PickerIssue[];
  checked: Record<number, boolean>;
  busy: boolean;
  onToggle: (n: number) => void;
  onImport: () => void;
}) {
  const count = issues.filter((i) => checked[i.number]).length;
  return (
    <div className="issue-picker">
      {issues.length === 0 ? (
        <p className="tiny muted">열린 이슈가 없습니다.</p>
      ) : (
        <ul className="task-list">
          {issues.map((i) => (
            <li key={i.number}>
              <label>
                <input type="checkbox" checked={Boolean(checked[i.number])} onChange={() => onToggle(i.number)} />{' '}
                <a href={i.url} target="_blank" rel="noreferrer">
                  {`#${i.number}`}
                </a>{' '}
                {i.title}
                <span className="tiny muted">
                  {' '}
                  · @{i.author || '알 수 없음'}
                  {i.assignees.length > 0 && ` → ${i.assignees.map((a) => '@' + a).join(', ')}`}
                </span>
                {!i.authorIsMember && <span className="badge"> 팀원 아님</span>}
                {i.imported && <span className="badge"> 이미 가져옴</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className="btn primary" disabled={busy || count === 0} onClick={onImport}>
        {`${count}개 가져오기`}
      </button>
    </div>
  );
}

/** 이슈 원문에 팀원이 아닌 사람이 쓴 이슈가 있으면 경고한다(승인은 막지 않음). */
export function NonMemberBanner({ spans }: { spans: { authorLogin: string; authorIsMember: boolean }[] }) {
  const outside = spans.filter((s) => !s.authorIsMember);
  if (!outside.length) return null;
  const who = [...new Set(outside.map((s) => s.authorLogin).filter(Boolean))].map((l) => '@' + l).join(', ');
  return (
    <p className="hub-alert" role="alert">
      {`팀원이 아닌 사람이 쓴 이슈 ${outside.length}건이 포함되어 있습니다 (${who})`}
    </p>
  );
}

export function GithubIssues({
  projectId,
  writable,
  onImported,
}: {
  projectId: string;
  writable: boolean;
  onImported: (sourceId: string) => Promise<void>;
}) {
  const [repo, setRepo] = useState<RepoView>(null);
  const [canManage, setCanManage] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [issues, setIssues] = useState<PickerIssue[] | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void call<{ repo: RepoView; canManage: boolean }>(`/api/github-issues?project=${encodeURIComponent(projectId)}`)
      .then((d) => {
        setRepo(d.repo);
        setCanManage(d.canManage);
      })
      .catch((e: Error) => setMessage(e.message));
  }, [projectId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  // 팀원에게는 등록된 저장소만 보인다. 등록·가져오기는 팀장만.
  if (!canManage)
    return repo ? (
      <p className="tiny muted">
        프로젝트 저장소: <a href={repo.url}>{`${repo.owner}/${repo.name}`}</a>
      </p>
    ) : null;

  return (
    <section className="github-issues">
      <div className="section-heading">
        <h2>GitHub 이슈 가져오기</h2>
        {repo && !editing && (
          <span className="tiny muted">
            <a href={repo.url} target="_blank" rel="noreferrer">{`${repo.owner}/${repo.name}`}</a>{' '}
            <button className="btn" disabled={busy || !writable} onClick={() => setEditing(true)}>
              변경
            </button>
          </span>
        )}
      </div>
      {!repo || editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const d = await call<{ repo: RepoView }>('/api/github-issues', {
                action: 'setRepo',
                projectId,
                repoUrl: url,
                version: repo?.version ?? 0,
              });
              setRepo(d.repo);
              setEditing(false);
              setIssues(null);
            });
          }}
        >
          <label className="input-label" htmlFor="github-repo-url">
            공개 GitHub 저장소 주소
          </label>
          <input
            id="github-repo-url"
            placeholder="https://github.com/아이디/저장소"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !writable || !url.trim()}>
            저장소 등록
          </button>
        </form>
      ) : issues === null ? (
        <button
          className="btn"
          disabled={busy || !writable}
          onClick={() =>
            void run(async () => {
              const d = await call<{ issues: PickerIssue[] }>(
                `/api/github-issues?project=${encodeURIComponent(projectId)}&list=1`,
              );
              setIssues(d.issues);
              setChecked(initialChecked(d.issues));
            })
          }
        >
          이슈 목록 보기
        </button>
      ) : (
        <GithubIssuePicker
          issues={issues}
          checked={checked}
          busy={busy || !writable}
          onToggle={(n) => setChecked((prev) => ({ ...prev, [n]: !prev[n] }))}
          onImport={() =>
            void run(async () => {
              const numbers = issues.filter((i) => checked[i.number]).map((i) => i.number);
              const d = await call<{ sourceId: string | null; excluded: Excluded[]; error?: string }>(
                '/api/github-issues',
                { action: 'import', projectId, numbers },
              );
              const skipped = d.excluded.map((x) => `#${x.number}(${REASON[x.reason]})`).join(', ');
              if (!d.sourceId) {
                setMessage(d.error ?? '가져올 수 있는 이슈가 없습니다.');
                return;
              }
              setIssues(null);
              await onImported(d.sourceId);
              if (skipped) setMessage(`제외: ${skipped}`);
            })
          }
        />
      )}
      {message && <output className="tiny muted">{message}</output>}
    </section>
  );
}
