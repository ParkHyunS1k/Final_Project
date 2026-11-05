'use client';
// 끝난 프로젝트 홈의 동료평가 카드. 규칙: docs/superpowers/specs/2026-11-06-peer-review-ui-design.md
// 평가 중이면 폼, 공개 뒤에는 '다음엔 이걸 챙기자' 결과. 판단은 서버 응답(/api/score)과 서버 시각으로 한다.
import { useCallback, useEffect, useState } from 'react';
import { useServerNow } from '@/hooks/use-server-now';
import { focusClock, tension } from '@/lib/race';
import {
  ITEMS,
  nextGrade,
  restrictionMessage,
  weakestItem,
  type Grade,
  type ItemKey,
  type RestrictionView,
} from '@/lib/score';
import { apiFetch } from '@/lib/supabase-browser';

export type ScoreData = {
  score: number | null;
  grade: Grade | null;
  breakdown: { key: ItemKey; label: string; average: number }[];
  badges: { id: string; label: string; description: string; earnedAt: string | null }[];
  review: {
    status: 'not_open' | 'open' | 'closed';
    opensAt: string | null;
    closesAt: string | null;
    submitted: boolean;
    reviewers: number | null;
    minReviewers: number;
    targets: { person: number; displayName: string }[];
    hidden: boolean;
    penaltyDays: number | null;
  };
};
export type ReviewInput = { person: number } & Record<ItemKey, number>;

const seoul = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** 목적격 조사: 마지막 글자에 받침이 있으면 '을', 없으면 '를'. */
function objectParticle(word: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? '을' : '를';
}

function Badges({ badges }: { badges: ScoreData['badges'] }) {
  return (
    <ul className="peer-badges">
      {badges.map((b) => (
        <li key={b.id} className={b.earnedAt ? 'peer-badge' : 'peer-badge off'}>
          <b>{b.label}</b>
          <small>{b.description}</small>
        </li>
      ))}
    </ul>
  );
}

function ReviewForm({
  data,
  now,
  busy,
  onSubmit,
}: {
  data: ScoreData;
  now: number;
  busy: boolean;
  onSubmit: (reviews: ReviewInput[]) => void;
}) {
  const [picked, setPicked] = useState<Record<string, number>>({});
  const { targets, closesAt, penaltyDays } = data.review;
  const left = Date.parse(closesAt!) - now;
  const clock = focusClock(left);
  const complete = targets.every((t) => ITEMS.every(({ key }) => picked[`${t.person}:${key}`]));
  return (
    <form
      className="peer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete) return;
        onSubmit(
          targets.map((t) => ({
            person: t.person,
            ...(Object.fromEntries(ITEMS.map(({ key }) => [key, picked[`${t.person}:${key}`]])) as Record<
              ItemKey,
              number
            >),
          })),
        );
      }}
    >
      <p className="focus-label">동료평가 마감까지</p>
      <div className={`focus-clock ${tension(left).stage}`} role="timer">
        {clock}
      </div>
      <p className="peer-warning">
        24시간 안에 내지 않으면{' '}
        {penaltyDays ? `${penaltyDays}일 동안` : '더 이상'} 새 프로젝트를 시작할 수 없어요
      </p>
      {targets.map((t) => (
        <fieldset key={t.person} className="peer-target">
          <legend>{t.displayName}</legend>
          {ITEMS.map(({ key, label }) => (
            <div key={key} className="peer-item" role="radiogroup" aria-label={`${t.displayName} ${label}`}>
              <span>{label}</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n}>
                  <input
                    type="radio"
                    name={`${t.person}:${key}`}
                    value={n}
                    checked={picked[`${t.person}:${key}`] === n}
                    onChange={() => setPicked((p) => ({ ...p, [`${t.person}:${key}`]: n }))}
                  />
                  {n}
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      ))}
      <button className="btn primary" disabled={!complete || busy}>
        {busy ? '제출 중…' : '평가 제출'}
      </button>
    </form>
  );
}

function Result({ data }: { data: ScoreData }) {
  const weak = weakestItem(data.breakdown);
  const next = nextGrade(data.score!);
  return (
    <div className="peer-result">
      <div className="peer-grade">
        <strong>{data.grade}</strong>
        <span>
          {data.score!.toFixed(1)} / 5
        </span>
      </div>
      <ul className="peer-items">
        {data.breakdown.map((b) => (
          <li key={b.key} className={weak?.key === b.key ? 'weak' : undefined}>
            <span>{b.label}</span>
            <span className="peer-bar">
              <span style={{ width: `${(b.average / 5) * 100}%` }} />
            </span>
            <b>{b.average.toFixed(1)}</b>
          </li>
        ))}
      </ul>
      <p className="peer-next">
        {weak ? (
          <>
            다음 프로젝트에선 <b>{weak.label}</b>
            {objectParticle(weak.label)} 챙겨 보세요
          </>
        ) : (
          '세 문항 모두 4.5 이상이에요'
        )}
        {next && (
          <span className="peer-gap">
            {' '}
            · {next.grade}까지 {next.gap.toFixed(1)}
          </span>
        )}
      </p>
      <p className="tiny muted">팀원 {data.review.reviewers}명이 평가했어요</p>
    </div>
  );
}

/** 결과가 열리기 전(평가 중)에는 다시 불러온다. 다른 팀원의 제출·마감으로 결과가 열릴 수 있다. */
export function needsRefresh(data: ScoreData | null) {
  return !data || data.review.status === 'open';
}

/** 렌더만 한다. now는 서버 기준 시각(ms). */
export function PeerReviewView({
  data,
  now,
  solo,
  restriction = null,
  busy,
  error,
  onSubmit,
}: {
  data: ScoreData;
  now: number;
  solo: boolean;
  /** 동료평가 미제출 금지(작업 공간이 처음 불러온 값). 결과가 가려졌을 때 함께 알린다. */
  restriction?: RestrictionView | null;
  busy: boolean;
  error: string;
  onSubmit: (reviews: ReviewInput[]) => void;
}) {
  const r = data.review;
  if (r.status === 'not_open') return null;
  let body = null;
  if (solo) body = null;
  else if (r.hidden)
    body = (
      <>
        <p className="peer-note">평가를 내지 않아 이번 결과는 볼 수 없어요.</p>
        {restriction && (
          <p className="peer-warning">{restrictionMessage(restriction, '새 프로젝트를 만들')}</p>
        )}
      </>
    );
  else if (r.status === 'open' && !r.submitted && r.targets.length)
    body = <ReviewForm data={data} now={now} busy={busy} onSubmit={onSubmit} />;
  else if (r.status === 'open')
    body = (
      <p className="peer-note">
        평가를 냈어요. 팀원 전원이 내거나 {seoul(r.closesAt!)}이 되면 결과가 열려요.
      </p>
    );
  else if (data.score !== null) body = <Result data={data} />;
  else body = <p className="peer-note">평가한 팀원이 2명이 안 돼 이번에는 점수가 없어요.</p>;
  return (
    <section className="peer-card" aria-label="동료평가">
      <h2>동료평가</h2>
      {body}
      {error && <output className="hint">{error}</output>}
      <Badges badges={data.badges} />
    </section>
  );
}

async function fetchScore(projectId: string): Promise<ScoreData> {
  const res = await apiFetch('/api/score?project=' + encodeURIComponent(projectId), { cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '동료평가를 불러오지 못했습니다.');
  return body;
}

/** /api/score를 불러와 그린다. 제출 응답으로 다시 그리고, 실패하면 메시지를 보여주고 다시 불러온다. */
export function PeerReviewCard({
  projectId,
  asOf,
  solo,
  restriction,
}: {
  projectId: string;
  /** 부모가 재조회할 때마다 바뀐다. 결과가 열리기 전에는 이때 함께 다시 불러온다. */
  asOf: string;
  solo: boolean;
  restriction: RestrictionView | null;
}) {
  const [data, setData] = useState<ScoreData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useServerNow(asOf);
  const now = live || Date.parse(asOf);
  const load = useCallback(
    () => fetchScore(projectId).then(setData),
    [projectId],
  );
  const pending = needsRefresh(data);
  useEffect(() => {
    if (!pending) return;
    fetchScore(projectId)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [projectId, asOf, pending]);
  if (!data) return error ? <output className="hint">{error}</output> : null;
  return (
    <PeerReviewView
      data={data}
      now={now}
      solo={solo}
      restriction={restriction}
      busy={busy}
      error={error}
      onSubmit={async (reviews) => {
        if (!window.confirm('제출하면 고칠 수 없어요.')) return;
        setBusy(true);
        setError('');
        try {
          const res = await apiFetch('/api/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'review', projectId, reviews }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || '제출하지 못했습니다.');
          setData(body);
        } catch (e) {
          setError((e as Error).message);
          await load().catch(() => undefined);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
