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
