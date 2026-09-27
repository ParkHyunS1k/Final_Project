// 랜딩 스크롤 연출용 순수 계산. 화면 속 시간은 예시 팀의 가상 레이스다.
export const SPRINT_SECONDS = 168 * 3600;
// 예시 팀이 결승선을 통과할 때 남은 시간(31:04:12).
export const FINISH_LEFT = 31 * 3600 + 4 * 60 + 12;

const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

// 고정(sticky) 구간이면 구간 안 스크롤 비율, 고정이 아니면 화면에 들어오는 정도.
export function sceneProgress(top, trackHeight, stageHeight, viewHeight) {
  const range = trackHeight - stageHeight;
  if (range > 0) return clamp(-top / range);
  return clamp((viewHeight * 0.85 - top) / (viewHeight * 0.6));
}

// 0이면 아무것도 켜지지 않고, steps면 마지막 장면까지 켜진다.
export function stepAt(progress, steps) {
  return Math.min(steps, Math.floor(clamp(progress) * (steps + 1)));
}

export function frameAt(progress, duration) {
  if (!Number.isFinite(duration)) return 0;
  return clamp(progress) * Math.max(0, duration - 0.06);
}

export function raceClock(progress) {
  const left = Math.round(
    SPRINT_SECONDS - clamp(progress) * (SPRINT_SECONDS - FINISH_LEFT),
  );
  const day = Math.min(7, Math.floor((SPRINT_SECONDS - left) / 86400) + 1);
  const text = [Math.floor(left / 3600), Math.floor(left / 60) % 60, left % 60]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
  return { day, text };
}

// 기기 고정 + 세로 기능 목록 섹션: 전체 진행률을 (몇 번째 항목, 항목 안 진행률)로 나눈다.
export function featureAt(progress, count) {
  const scaled = clamp(progress) * count;
  const item = Math.min(count - 1, Math.floor(scaled));
  return { item, t: Math.min(1, scaled - item) };
}

// 커서 경로. keys = [{ t, x, y, press? }] (t 오름차순, x·y는 화면 기준 %).
// 두 지점 사이는 부드럽게 이동하고, press가 있는 지점에서 잠깐 누른 상태가 된다.
export function cursorAt(t, keys) {
  if (!keys.length) return { x: 0, y: 0, press: false };
  let prev = keys[0];
  for (const key of keys) {
    if (t < key.t) {
      const span = key.t - prev.t;
      const k = span > 0 ? (t - prev.t) / span : 1;
      const e = k * k * (3 - 2 * k);
      return {
        x: prev.x + (key.x - prev.x) * e,
        y: prev.y + (key.y - prev.y) * e,
        press: Boolean(prev.press) && t - prev.t < 0.04,
      };
    }
    prev = key;
  }
  return { x: prev.x, y: prev.y, press: Boolean(prev.press) && t - prev.t < 0.04 };
}

export function countUp(target, progress) {
  return Math.round(target * clamp(progress));
}

// 구간별로 굴러가는 숫자. segs = [[from, to, p0, p1], ...] (p0 오름차순).
// 아직 첫 구간이 시작되지 않았으면 첫 from, 이후에는 지나온 마지막 구간의 값.
export function rollAt(progress, segs) {
  let value = segs.length ? segs[0][0] : 0;
  for (const [from, to, p0, p1] of segs) {
    if (progress < p0) break;
    const k = p1 > p0 ? clamp((progress - p0) / (p1 - p0)) : 1;
    value = Math.round(from + (to - from) * k);
  }
  return value;
}
