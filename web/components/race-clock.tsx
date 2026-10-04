'use client';
import { useEffect, useRef } from 'react';
import { useServerNow } from '@/hooks/use-server-now';
import { countdown } from '@/lib/race';
import type { Lifecycle } from '@/lib/sprint-policy';

// 남은 시간. 0이 돼도 화면이 스스로 종료를 판정하지 않고 onZero(재조회)를 한 번만 부른다.
export function RaceClock({
  lifecycle,
  deadline,
  asOf,
  durationDays,
  onZero,
}: {
  lifecycle: Lifecycle;
  deadline: string | null;
  asOf: string;
  durationDays: number;
  onZero: () => void;
}) {
  const running = lifecycle === 'active' && !!deadline;
  const now = useServerNow(running ? asOf : null);
  const left = running && now ? Date.parse(deadline!) - now : Number.NaN;
  const fired = useRef(false);
  useEffect(() => {
    if (running && left <= 0 && !fired.current) {
      fired.current = true;
      onZero();
    }
  }, [running, left, onZero]);
  if (lifecycle === 'draft')
    return <span className="race-clock idle">{durationDays}일 · 시작 전</span>;
  if (lifecycle === 'completed') return <span className="race-clock done">완주</span>;
  if (lifecycle === 'expired')
    return <span className="race-clock critical">00:00:00 · 기한 종료</span>;
  if (!running || !now) return null;
  const c = countdown(left);
  return (
    <span role="timer" aria-label={`남은 시간 ${c.text}`} className={`race-clock ${c.level}`}>
      {c.text}
    </span>
  );
}
