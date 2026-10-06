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
