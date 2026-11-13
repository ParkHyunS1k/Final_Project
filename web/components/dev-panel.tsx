'use client';
// 업무 상세의 개발 현황(2026-11-14). 벤치마킹: Jira 개발 패널의 숫자 요약 줄, Linear의 PR 한 줄 신호(상태·CI·리뷰),
// GitHub 머지 박스의 판단 상자와 커밋 타임라인. 상태는 바꾸지 않고 제안만 한다.
import { useState } from 'react';
import {
  CircleCheck,
  CircleX,
  CircleDashed,
  CircleMinus,
  Copy,
  Check,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  PauseCircle,
  TriangleAlert,
  ArrowRight,
  ChevronRight,
  UserCheck,
  MessageSquareWarning,
  UserRound,
} from 'lucide-react';
import {
  branchName,
  DETAIL_MAX_PULLS,
  prSuggestion,
  taskRef,
  type Checks,
  type Pull,
  type PullDetail,
  type Review,
} from '@/lib/github-prs';
import { seoulTime } from '@/lib/sprint';

export const PR_LABEL = { open: '열림', merged: '머지됨', closed: '닫힘' } as const;
export const CHECK_LABEL = {
  success: 'CI 통과',
  failure: 'CI 실패',
  pending: 'CI 진행 중',
  none: 'CI 없음',
} as const;
const REVIEW_LABEL = { approved: '승인', changes_requested: '수정 요청', none: '리뷰 없음' } as const;

export function CheckIcon({ checks, size = 12 }: { checks: Checks; size?: number }) {
  const Icon =
    checks === 'success'
      ? CircleCheck
      : checks === 'failure'
        ? CircleX
        : checks === 'pending'
          ? CircleDashed
          : CircleMinus;
  return <Icon size={size} aria-hidden="true" />;
}
function ReviewIcon({ review, size = 12 }: { review: Review; size?: number }) {
  const Icon =
    review === 'approved' ? UserCheck : review === 'changes_requested' ? MessageSquareWarning : UserRound;
  return <Icon size={size} aria-hidden="true" />;
}
function PullIcon({ state, size = 16 }: { state: Pull['state']; size?: number }) {
  const Icon = state === 'merged' ? GitMerge : state === 'closed' ? GitPullRequestClosed : GitPullRequest;
  return <Icon size={size} aria-hidden="true" />;
}

/** 멈춘 시간. 하루 미만은 시간, 이상은 일. */
export function stallText(hours: number) {
  return hours < 24 ? `${hours}시간` : `${Math.floor(hours / 24)}일`;
}
/** 'n분 전' 같은 상대 시각. 기준 시각이 없으면 KST 날짜. */
function ago(iso: string, now?: string) {
  if (!iso) return '';
  if (!now) return seoulTime(iso).slice(5);
  const minutes = Math.floor((Date.parse(now) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}
/** 여러 PR의 CI를 하나로: 실패 > 진행 중 > 통과 > 없음. 아직 모르면 null. */
function overallChecks(list: Checks[]): Checks | null {
  if (!list.length) return null;
  for (const c of ['failure', 'pending', 'success'] as const) if (list.includes(c)) return c;
  return 'none';
}
function overallReview(list: Review[]): Review | null {
  if (!list.length) return null;
  if (list.includes('changes_requested')) return 'changes_requested';
  return list.includes('approved') ? 'approved' : 'none';
}
function Avatar({ login }: { login: string }) {
  // 로그인 글자로 색을 고정한다(외부 이미지는 불러오지 않는다).
  let hue = 7;
  for (let i = 0; i < login.length; i++) hue = (hue * 31 + login.charCodeAt(i)) % 360;
  return (
    <span className="dev-avatar" style={{ ['--hue' as string]: hue }} aria-hidden="true">
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Callout({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: 'idle' | 'go' | 'done' | 'warn';
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={`dev-callout is-${tone}`} role={tone === 'warn' ? 'alert' : undefined}>
      <span className="dev-callout-icon">{icon}</span>
      <div className="dev-callout-text">
        <strong>{title}</strong>
        {body && <span>{body}</span>}
      </div>
      {action}
    </div>
  );
}

/** 업무 상세의 개발 현황. 요약 줄 → 판단 상자(멈춤·제안) → PR 목록(펼치면 커밋 타임라인). */
export function PrPanel({
  task,
  pulls,
  details = {},
  detailError = '',
  stalled = null,
  asOf,
  canEdit,
  onStart,
  onUseEvidence,
}: {
  task: { id: number; title: string; done: boolean; status?: string | null; touchedAt?: string | Date | null };
  pulls: Pull[];
  /** PR 번호별 CI·리뷰·최근 커밋. 상세를 열 때 읽는다. */
  details?: Record<number, PullDetail>;
  detailError?: string;
  /** 진행 중인데 활동이 없는 시간(시). 12시간 미만이면 null. */
  stalled?: number | null;
  /** 상대 시각 기준(서버 시각). 없으면 날짜로 보인다. */
  asOf?: string;
  canEdit: boolean;
  onStart: () => void;
  onUseEvidence: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const branch = branchName(task.id, task.title);
  const known = pulls.map((p) => details[p.number]).filter((d): d is PullDetail => !!d);
  const checks = Object.fromEntries(known.map((d) => [d.number, d.checks]));
  const suggestion = canEdit ? prSuggestion(task, pulls, checks) : null;
  const open = pulls.find((p) => p.state === 'open');
  const merged = pulls.filter((p) => p.state === 'merged');
  const ci = overallChecks(known.map((d) => d.checks));
  const review = overallReview(known.filter((d) => pulls.find((p) => p.number === d.number)?.state === 'open').map((d) => d.review));
  const commitCount = known.reduce((n, d) => n + d.commits.length, 0);
  // 멈춤 판정과 같은 기준: 업무 변경·PR 수정·커밋 중 가장 최근.
  const last = [
    task.touchedAt ? new Date(task.touchedAt).toISOString() : '',
    ...pulls.map((p) => p.updatedAt),
    ...known.flatMap((d) => d.commits.map((c) => c.date)),
  ]
    .filter(Boolean)
    .map((v) => new Date(v).toISOString())
    .sort()
    .at(-1);
  const loading = (n: number, i: number) => !details[n] && !detailError && i < DETAIL_MAX_PULLS;
  return (
    <section className="detail-section dev-panel" aria-label="개발 현황">
      <header className="dev-head">
        <h3>
          개발 현황 <span className="pr-ref">{taskRef(task.id)}</span>
        </h3>
        <button
          type="button"
          className="dev-branch"
          title="이 이름으로 브랜치를 만들면 PR이 이 업무에 연결돼요"
          onClick={() => void navigator.clipboard?.writeText(branch).then(() => setCopied(true))}
        >
          <GitBranch size={13} aria-hidden="true" />
          <code>{branch}</code>
          <span className="dev-branch-action">
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? '복사했어요' : '브랜치 이름 복사'}
          </span>
        </button>
      </header>
      <p className="detail-caption dev-hint">
        PR 제목이나 브랜치 이름에 이 번호({taskRef(task.id)})를 넣으면 이 업무에 연결돼요.
      </p>

      {!!pulls.length && (
        <dl className="dev-summary">
          <div>
            <dt>PR</dt>
            <dd>
              <b>{pulls.length}</b>
              <small>
                {[
                  open && `열림 ${pulls.filter((p) => p.state === 'open').length}`,
                  merged.length && `머지 ${merged.length}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </dd>
          </div>
          <div className={ci ? `is-${ci}` : undefined}>
            <dt>CI</dt>
            <dd>
              {ci ? <CheckIcon checks={ci} size={14} /> : null}
              <b>{ci ? CHECK_LABEL[ci].replace('CI ', '') : '…'}</b>
            </dd>
          </div>
          <div className={review ? `is-review-${review}` : undefined}>
            <dt>리뷰</dt>
            <dd>
              {review ? <ReviewIcon review={review} size={14} /> : null}
              <b>{review ? REVIEW_LABEL[review] : open ? '…' : '—'}</b>
            </dd>
          </div>
          <div>
            <dt>마지막 활동</dt>
            <dd>
              <b>{last ? ago(last, asOf) : '—'}</b>
              {!!commitCount && <small>커밋 {commitCount}</small>}
            </dd>
          </div>
        </dl>
      )}

      {stalled !== null && (
        <Callout
          tone="idle"
          icon={<PauseCircle size={16} />}
          title={`${stallText(stalled)}째 활동이 없어요`}
          body="막힌 곳이 있으면 체크인으로 남겨주세요."
        />
      )}
      {suggestion === 'start' && open && (
        <Callout
          tone="go"
          icon={<GitPullRequest size={16} />}
          title={`열린 PR #${open.number}이 있어요. 진행 중으로 바꿀까요?`}
          action={
            <button type="button" className="btn" onClick={onStart}>
              진행 중으로 바꾸기 <ArrowRight size={14} aria-hidden="true" />
            </button>
          }
        />
      )}
      {suggestion === 'ci_failed' && (
        <Callout
          tone="warn"
          icon={<TriangleAlert size={16} />}
          title="PR이 머지됐지만 CI가 실패했어요. 확인이 필요해요."
          body="CI를 고친 뒤 다시 열면 완료 근거를 채울 수 있어요."
        />
      )}
      {suggestion === 'complete' && (
        <Callout
          tone="done"
          icon={<GitMerge size={16} />}
          title={`PR ${merged.map((p) => `#${p.number}`).join(', ')}이(가) 머지됐어요. 이걸 근거로 완료할까요?`}
          action={
            <button
              type="button"
              className="btn primary"
              onClick={() => onUseEvidence(merged.map((p) => `PR #${p.number} ${p.title} ${p.url}`).join('\n'))}
            >
              완료 근거로 채우기
            </button>
          }
        />
      )}

      {pulls.length ? (
        <ul className="dev-prs">
          {pulls.map((p, i) => {
            const d = details[p.number];
            return (
              <li key={p.number} className={`dev-pr is-${p.state}`}>
                <details open={i === 0}>
                  <summary>
                    <span className={`dev-pr-icon pr-${p.state}`} title={PR_LABEL[p.state]}>
                      <PullIcon state={p.state} />
                    </span>
                    <span className="dev-pr-main">
                      <span className="dev-pr-title">
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title}
                        </a>
                        <span className="dev-pr-num">#{p.number}</span>
                      </span>
                      <span className="dev-pr-meta">
                        <span className={`pr-state pr-${p.state}`}>{PR_LABEL[p.state]}</span>
                        {p.branch && <code>{p.branch}</code>}
                        {p.author && (
                          <span className="dev-who">
                            <Avatar login={p.author} />@{p.author}
                          </span>
                        )}
                        {p.updatedAt && <span>{ago(p.updatedAt, asOf)}</span>}
                      </span>
                    </span>
                    <span className="dev-pr-signals">
                      {d ? (
                        <>
                          <span className={`dev-signal pr-check-${d.checks}`}>
                            <CheckIcon checks={d.checks} />
                            {CHECK_LABEL[d.checks]}
                          </span>
                          <span className={`dev-signal pr-review-${d.review}`}>
                            <ReviewIcon review={d.review} />
                            {REVIEW_LABEL[d.review]}
                          </span>
                        </>
                      ) : loading(p.number, i) ? (
                        <span className="dev-signal is-loading">불러오는 중</span>
                      ) : null}
                    </span>
                    {!!d?.commits.length && <ChevronRight className="dev-chevron" size={14} aria-hidden="true" />}
                  </summary>
                  {!!d?.commits.length && (
                    <ol className="dev-commits" aria-label={`PR #${p.number} 최근 커밋`}>
                      {d.commits.map((c) => (
                        <li key={c.sha || c.date}>
                          <span className="dev-commit-msg">{c.message}</span>
                          <span className="dev-commit-meta">
                            <code>{c.sha.slice(0, 7)}</code>
                            {c.author && ` @${c.author}`}
                            {c.date && ` · ${ago(c.date, asOf)}`}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="dev-empty">
          <GitPullRequest size={18} aria-hidden="true" />
          <div>
            <strong>연결된 PR이 없어요.</strong>
            <span>위 브랜치 이름으로 작업을 시작하면 PR과 CI·리뷰·커밋이 여기에 모여요.</span>
          </div>
        </div>
      )}
      {detailError && <p className="dev-error">{detailError}</p>}
    </section>
  );
}
