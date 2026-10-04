// 서버 값이 Response.json을 거친 뒤 화면에 도착하는 모양. Date는 ISO 문자열이 된다.
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
