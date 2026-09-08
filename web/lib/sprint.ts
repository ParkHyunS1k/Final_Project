export type Task = {
  id: number;
  title: string;
  person: number;
  remaining: number;
  optional: boolean;
  deferred: boolean;
  done: boolean;
  evidence: string;
  dependsOn: number[];
  status?: 'todo' | 'in_progress';
  description?: string;
};
export type Capacity = { person: number; date: string; hours: number };
export type Sprint = {
  title: string;
  startDate: string;
  deadline: string;
  revision: number;
  joined: boolean;
  finished: boolean;
  tasks: Task[];
  capacity: Capacity[];
  people?: typeof people;
};
export const people = [
  { name: '현식', role: '기획 · 프론트엔드', initial: '현', color: '#dedaff' },
  { name: '지민', role: '백엔드 · API', initial: '지', color: '#d8efd6' },
  { name: '수빈', role: '디자인 · QA', initial: '수', color: '#ffe4bd' },
];
export function dateInSeoul(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function dates(start: string, end: string) {
  const result: string[] = [];
  for (
    const d = new Date(start + 'T00:00:00Z');
    d.toISOString().slice(0, 10) <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    result.push(d.toISOString().slice(0, 10));
    if (result.length > 31) throw new Error('스프린트는 최대 31일입니다.');
  }
  return result;
}
export function seed(now = new Date()): Sprint {
  const start = dateInSeoul(now);
  const end = new Date(start + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 9);
  const last = end.toISOString().slice(0, 10);
  const rows: [string, number, number, boolean, number[]][] = [
    ['핵심 사용자 흐름 & 화면 설계', 0, 2, false, []],
    ['공고 텍스트 → 마감일 추출', 1, 6, false, [1]],
    ['추출 결과 화면 연결', 0, 4, false, [2]],
    ['PDF 업로드 지원', 1, 8, true, [2]],
    ['핵심 흐름 테스트 & 배포 검증', 2, 5, false, [3]],
    ['3분 데모 & 결과물 정리', 0, 2, false, [5]],
  ];
  return {
    title: '공고문을 실행 계획으로 바꾸는 서비스',
    startDate: start,
    deadline: last + 'T18:00:00+09:00',
    revision: 0,
    joined: false,
    finished: false,
    tasks: rows.map(([title, person, remaining, optional, dependsOn], i) => ({
      id: i + 1,
      title,
      person,
      remaining,
      optional,
      deferred: false,
      done: false,
      evidence: '',
      dependsOn,
    })),
    capacity: people.flatMap((_, person) =>
      dates(start, last).map((date) => ({ person, date, hours: 2 })),
    ),
  };
}
export type Schedule = {
  feasible: boolean;
  needed: number;
  available: number;
  unscheduled: number[];
  finishes: Record<number, string>;
  starts: Record<number, string>;
  perPerson: { person: number; needed: number; available: number }[];
};
// Half-hour working slots, explicit date budgets, and the real deadline (Asia/Seoul).
export function schedule(s: Sprint, now = new Date()): Schedule {
  const active = s.tasks.filter((t) => !t.deferred && !t.done);
  const last = s.deadline.slice(0, 10);
  const slots = new Map<number, number[]>();
  const members = s.people ?? people;
  for (let person = 0; person < members.length; person++) {
    const available: number[] = [];
    for (const date of dates(s.startDate, last)) {
      const hours =
        s.capacity.find((c) => c.person === person && c.date === date)?.hours ??
        0;
      for (let i = 0; i < Math.floor(hours * 2); i++) {
        const time = Date.parse(date + 'T09:00:00+09:00') + i * 30 * 60 * 1000;
        if (
          time >= now.getTime() &&
          time + 30 * 60 * 1000 <= Date.parse(s.deadline)
        )
          available.push(time);
      }
    }
    slots.set(person, available);
  }
  const perPerson = members.map((_, person) => ({
    person,
    needed: active
      .filter((t) => t.person === person)
      .reduce((a, t) => a + t.remaining, 0),
    available: (slots.get(person)?.length ?? 0) / 2,
  }));
  const ends = new Map<number, number>();
  s.tasks.filter((t) => t.done).forEach((t) => ends.set(t.id, now.getTime()));
  const finishes: Record<number, string> = {};
  const starts: Record<number, string> = {};
  const pending = [...active];
  const unscheduled: number[] = [];
  while (pending.length) {
    const i = pending.findIndex((t) =>
      t.dependsOn.every((d) => ends.has(d) || unscheduled.includes(d)),
    );
    if (i < 0) {
      unscheduled.push(...pending.map((t) => t.id));
      break;
    }
    const task = pending.splice(i, 1)[0];
    if (task.dependsOn.some((d) => unscheduled.includes(d))) {
      unscheduled.push(task.id);
      continue;
    }
    const earliest = Math.max(
      now.getTime(),
      ...task.dependsOn.map((d) => ends.get(d) ?? now.getTime()),
    );
    const pool = slots.get(task.person) ?? [];
    const required = Math.ceil(task.remaining * 2);
    const chosen = pool.filter((t) => t >= earliest).slice(0, required);
    if (chosen.length < required) {
      unscheduled.push(task.id);
      continue;
    }
    const start = chosen[0] ?? earliest;
    const end = chosen.length
      ? chosen[chosen.length - 1] + 30 * 60 * 1000
      : earliest;
    ends.set(task.id, end);
    starts[task.id] = new Date(start + 9 * 3600000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
    finishes[task.id] = new Date(end + 9 * 3600000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
    const used = new Set(chosen);
    slots.set(
      task.person,
      pool.filter((t) => !used.has(t)),
    );
  }
  return {
    feasible: !unscheduled.length,
    needed: perPerson.reduce((a, p) => a + p.needed, 0),
    available: perPerson.reduce((a, p) => a + p.available, 0),
    unscheduled,
    starts,
    finishes,
    perPerson,
  };
}
export function recovery(s: Sprint, now = new Date()) {
  const before = schedule(s, now);
  if (before.feasible) return null;
  const ids: number[] = [];
  const candidates = s.tasks
    .filter((t) => t.optional && !t.done && !t.deferred)
    .sort((a, b) => b.remaining - a.remaining);
  for (const task of candidates) {
    if (
      s.tasks.some(
        (t) =>
          !t.done &&
          !t.deferred &&
          !ids.includes(t.id) &&
          t.dependsOn.includes(task.id),
      )
    )
      continue;
    ids.push(task.id);
    const after = schedule(
      {
        ...s,
        tasks: s.tasks.map((t) =>
          ids.includes(t.id) ? { ...t, deferred: true } : t,
        ),
      },
      now,
    );
    if (after.feasible) return { deferIds: [...ids], before, after };
  }
  return null;
}
export function validateHours(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 200 ||
    value * 2 !== Math.floor(value * 2)
  )
    throw new Error('시간은 0~200 사이의 0.5시간 단위로 입력해주세요.');
  return value;
}

export function taskInput(
  b: Record<string, unknown>,
  tasks: Task[],
  id: number,
) {
  if (
    typeof b.title !== 'string' ||
    !b.title.trim() ||
    b.title.trim().length > 200
  )
    throw new Error('업무 이름은 1~200자로 입력해주세요.');
  if (
    typeof b.person !== 'number' ||
    !Number.isInteger(b.person) ||
    b.person < 0
  )
    throw new Error('참여 중인 담당자를 선택해주세요.');
  const remaining = validateHours(b.remaining);
  if (!remaining) throw new Error('남은 시간은 0.5시간 이상이어야 합니다.');
  if (typeof b.optional !== 'boolean')
    throw new Error('필수 여부를 선택해주세요.');
  if (
    !Array.isArray(b.dependsOn) ||
    b.dependsOn.length > tasks.length ||
    new Set(b.dependsOn).size !== b.dependsOn.length ||
    b.dependsOn.some(
      (d) =>
        !Number.isInteger(d) ||
        d === id ||
        !tasks.some((t) => t.id === d && !t.deferred),
    )
  )
    throw new Error(
      '선행 작업은 중복 없이 현재 프로젝트의 다른 업무를 선택해주세요.',
    );
  const dependsOn = b.dependsOn as number[];
  const graph = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  graph.set(id, dependsOn);
  const visited = new Set<number>();
  const visiting = new Set<number>();
  function visit(taskId: number) {
    if (visiting.has(taskId))
      throw new Error('서로를 기다리는 순환 의존관계는 저장할 수 없습니다.');
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const d of graph.get(taskId) ?? []) visit(d);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  visit(id);
  return {
    title: b.title.trim(),
    person: b.person,
    remaining,
    optional: b.optional,
    dependsOn,
  };
}
