import { useEffect, useState } from 'react';
import { clockOffset } from '@/lib/race';

/** 서버가 준 asOf를 기준으로 1초마다 흐르는 현재 시각(ms). asOf가 바뀌면(재조회) 다시 맞춘다. null이면 0. */
export function useServerNow(asOf: string | null) {
  const [now, setNow] = useState(() => (asOf ? Date.parse(asOf) : 0));
  useEffect(() => {
    if (!asOf) return;
    const offset = clockOffset(asOf, Date.now());
    const id = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(id);
  }, [asOf]);
  return asOf ? now : 0;
}

/**
 * 화면 새로고침마다 흐르는 서버 기준 현재 시각(ms). 0.01초까지 보이는 큰 카운트다운용이다.
 * 동작 줄이기를 켰으면 1초마다만 바뀐다. asOf가 null이면 fallback을 그대로 돌려준다.
 */
export function useFineServerNow(asOf: string | null, fallback: number) {
  const [now, setNow] = useState(() => (asOf ? Date.parse(asOf) : fallback));
  useEffect(() => {
    if (!asOf) return;
    const offset = clockOffset(asOf, Date.now());
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const id = setInterval(() => setNow(Date.now() + offset), 1000);
      return () => clearInterval(id);
    }
    let frame = 0;
    const tick = () => {
      setNow(Date.now() + offset);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [asOf]);
  return asOf ? now : fallback;
}
