// DB(timestamptz)는 Date, JSON(변경안 스냅샷·응답)은 ISO 문자열이다. 비교는 밀리초로 한다.
export type Instant = Date | string | null | undefined;

export function ms(x: Instant): number {
  if (x instanceof Date) return x.getTime();
  return x ? Date.parse(x) : NaN;
}

/** 둘 다 비어 있으면 같고, 하나만 비어 있으면 다르다. */
export function sameInstant(a: Instant, b: Instant): boolean {
  const x = ms(a);
  const y = ms(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
  return x === y;
}

/** 저장·비교 키(알림 중복 방지 키 등)는 이전과 같은 UTC ISO 문자열로 만든다. */
export function iso(x: Date | string): string {
  return new Date(ms(x)).toISOString();
}
