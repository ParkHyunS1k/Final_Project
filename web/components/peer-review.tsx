'use client';
// 동료평가. 규칙: docs/superpowers/specs/2026-11-06-peer-review-ui-design.md
// 낼 평가가 있으면 작업 공간 전체를 막는 모달(PeerReviewGate)에서 팀원 한 명씩 카드로 낸다.
// 끝난 프로젝트 홈 카드(PeerReviewCard)는 상태 안내와 공개 뒤 '다음엔 이걸 챙기자' 결과를 보인다.
// 판단은 서버 응답(/api/score)과 서버 시각으로 한다.
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** GET이 주는 서버 시각. 모달의 남은 시간 계산에 쓴다. */
  asOf?: string;
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

/**
 * 별 다섯 개, 별마다 왼쪽 반은 .5점·오른쪽 반은 1점. 0.5~5 열 칸짜리 라디오 그룹이라 화살표 키로도 고른다.
 */
function Stars({ name, value, onPick }: { name: string; value: number; onPick: (n: number) => void }) {
  return (
    <div className="peer-stars">
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className="peer-star">
          <span aria-hidden="true">★</span>
          <span
            className="peer-star-fill"
            aria-hidden="true"
            style={{ width: `${Math.min(Math.max(value - star + 1, 0), 1) * 100}%` }}
          >
            ★
          </span>
          {[star - 0.5, star].map((n) => (
            <label key={n}>
              <input type="radio" name={name} value={n} checked={value === n} onChange={() => onPick(n)} />
              <span className="sr-only">{n}점</span>
            </label>
          ))}
        </span>
      ))}
      <b className="peer-star-value">{value ? value.toFixed(1) : '–'}</b>
    </div>
  );
}

/** 팀원 한 명씩 카드로 평가한다. 세 문항을 다 고르면 다음 사람, 마지막 카드에서 한 번에 제출. */
export function ReviewCards({
  title,
  data,
  now,
  busy,
  error,
  onSubmit,
}: {
  title: string;
  data: ScoreData;
  now: number;
  busy: boolean;
  error: string;
  onSubmit: (reviews: ReviewInput[]) => void;
}) {
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [step, setStep] = useState(0);
  const { targets, closesAt, penaltyDays } = data.review;
  const t = targets[step];
  const left = Date.parse(closesAt!) - now;
  const done = ITEMS.every(({ key }) => picked[`${t.person}:${key}`]);
  const last = step === targets.length - 1;
  return (
    <form
      className="peer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!done) return;
        if (!last) return setStep(step + 1);
        onSubmit(
          targets.map((x) => ({
            person: x.person,
            ...(Object.fromEntries(ITEMS.map(({ key }) => [key, picked[`${x.person}:${key}`]])) as Record<
              ItemKey,
              number
            >),
          })),
        );
      }}
    >
      <p className="peer-project">{title}</p>
      <h2>동료평가</h2>
      <div className={`focus-clock ${tension(left).stage}`} role="timer">
        {focusClock(left)}
      </div>
      <p className="peer-warning">
        24시간 안에 내지 않으면{' '}
        {penaltyDays ? `${penaltyDays}일 동안` : '더 이상'} 새 프로젝트를 시작할 수 없어요
      </p>
      <fieldset key={t.person} className="peer-target">
        <legend>
          {t.displayName}
          <small>
            {step + 1} / {targets.length}
          </small>
        </legend>
        {ITEMS.map(({ key, label }) => (
          <div key={key} className="peer-item" role="radiogroup" aria-label={`${t.displayName} ${label}`}>
            <span>{label}</span>
            <Stars
              name={`${t.person}:${key}`}
              value={picked[`${t.person}:${key}`] ?? 0}
              onPick={(n) => setPicked((p) => ({ ...p, [`${t.person}:${key}`]: n }))}
            />
          </div>
        ))}
      </fieldset>
      {error && <output className="hint">{error}</output>}
      <div className="peer-actions">
        {step > 0 && (
          <button type="button" className="btn" onClick={() => setStep(step - 1)}>
            이전
          </button>
        )}
        <button className="btn primary" disabled={!done || busy}>
          {!last ? '다음' : busy ? '제출 중…' : '평가 제출'}
        </button>
      </div>
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

/** 렌더만 한다. 평가 폼은 여기 없고 PeerReviewGate 모달이 띄운다. */
export function PeerReviewView({
  data,
  solo,
  restriction = null,
  error = '',
}: {
  data: ScoreData;
  solo: boolean;
  /** 동료평가 미제출 금지(작업 공간이 처음 불러온 값). 결과가 가려졌을 때 함께 알린다. */
  restriction?: RestrictionView | null;
  error?: string;
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
    body = <p className="peer-note">평가 카드를 채워야 결과를 볼 수 있어요.</p>;
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

/** 지금 낼 평가가 남았는지. 모달을 띄우거나 닫는 기준. */
export function owesReview(data: ScoreData) {
  const r = data.review;
  return r.status === 'open' && !r.submitted && r.targets.length > 0 && !r.hidden;
}

/**
 * 끝난 프로젝트 홈의 동료평가 카드. 결과가 열리기 전에는 부모 재조회(asOf)·모달 제출(owed 변화) 때 다시 불러온다.
 * 낼 평가가 보이는데 모달 목록에 없으면 onOwe로 알린다(이 화면에서 프로젝트가 끝난 경우).
 */
export function PeerReviewCard({
  projectId,
  asOf,
  solo,
  restriction,
  owed,
  onOwe,
}: {
  projectId: string;
  asOf: string;
  solo: boolean;
  restriction: RestrictionView | null;
  /** 모달 목록에 이 프로젝트가 있는지. */
  owed: boolean;
  onOwe: (projectId: string) => void;
}) {
  const [data, setData] = useState<ScoreData | null>(null);
  const [error, setError] = useState('');
  const pending = needsRefresh(data);
  useEffect(() => {
    if (!pending) return;
    fetchScore(projectId)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [projectId, asOf, pending, owed]);
  const owe = Boolean(data && !solo && owesReview(data));
  useEffect(() => {
    if (owe && !owed) onOwe(projectId);
  }, [owe, owed, onOwe, projectId]);
  if (!data) return error ? <output className="hint">{error}</output> : null;
  return <PeerReviewView data={data} solo={solo} restriction={restriction} error={error} />;
}

function GateProject({
  project,
  onDone,
}: {
  project: { id: string; title: string };
  onDone: (projectId: string) => void;
}) {
  const [data, setData] = useState<ScoreData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const live = useServerNow(data?.asOf ?? null);
  useEffect(() => {
    let current = true;
    fetchScore(project.id)
      .then((d) => {
        if (!current) return;
        if (owesReview(d)) setData(d);
        else onDone(project.id);
      })
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [project.id, attempt, onDone]);
  if (!data)
    return error ? (
      <div className="peer-form">
        <output className="hint">{error}</output>
        <button className="btn" onClick={() => (setError(''), setAttempt((n) => n + 1))}>
          다시 불러오기
        </button>
      </div>
    ) : (
      <p className="peer-note">동료평가를 불러오는 중…</p>
    );
  return (
    <ReviewCards
      title={project.title}
      data={data}
      now={live || Date.parse(data.asOf!)}
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
            body: JSON.stringify({ action: 'review', projectId: project.id, reviews }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || '제출하지 못했습니다.');
          onDone(project.id);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/**
 * 낼 평가가 남은 동안 작업 공간 전체를 막는 모달. 프로젝트를 하나씩, 팀원을 한 명씩 카드로 띄운다.
 * Esc·뒤로 닫히지 않는다(닫히면 다시 연다). 서버 강제는 미제출 제재(lib/sanction.ts)가 한다.
 */
export function PeerReviewGate({
  projects,
  onDone,
}: {
  projects: { id: string; title: string }[];
  onDone: (projectId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const reopen = useCallback(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(reopen);
  return (
    <dialog
      ref={ref}
      className="peer-dialog"
      aria-label="동료평가"
      onCancel={(e) => e.preventDefault()}
      onClose={reopen}
    >
      <GateProject key={projects[0].id} project={projects[0]} onDone={onDone} />
      {projects.length > 1 && <p className="tiny muted">이 프로젝트 다음에 {projects.length - 1}개 더 남았어요</p>}
    </dialog>
  );
}
