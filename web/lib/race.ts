// 작업 화면 레이스 표시용 순수 계산. 서버가 준 값(asOf·plan)만 읽고 저장하지 않는다.
import type { Plan } from './sprint.ts';

const DAY_MS = 86400000;
const HOUR_S = 3600;

export type RaceTask = {
  id: number;
  person: number;
  done: boolean;
  deferred: boolean;
  status?: 'todo' | 'in_progress';
  dependsOn: number[];
};

/** 홈 큰 숫자 3개. 보류 업무는 세지 않는다. 병목 = 마감 안에 배치되지 않은 미완료 업무(plan.unscheduled). */
export function sprintPulse(
  tasks: RaceTask[],
  plan: Pick<Plan, 'needed' | 'available' | 'unscheduled'> | null,
) {
  const counted = tasks.filter((t) => !t.deferred);
  return {
    done: counted.filter((t) => t.done).length,
    total: counted.length,
    hoursOver: plan ? Math.round((plan.needed - plan.available) * 10) / 10 : 0,
    bottlenecks: plan
      ? counted.filter((t) => !t.done && plan.unscheduled.includes(t.id)).map((t) => t.id)
      : [],
  };
}

export type ClockLevel = 'calm' | 'heat' | 'critical';
const pad = (n: number) => String(n).padStart(2, '0');
/** 남은 밀리초 → 'HH:MM:SS'(총 시간). 0 아래로 내려가지 않는다. */
export function countdown(msLeft: number): { text: string; level: ClockLevel; over: boolean } {
  const s = Number.isFinite(msLeft) ? Math.max(0, Math.floor(msLeft / 1000)) : 0;
  return {
    text: `${pad(Math.floor(s / HOUR_S))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`,
    level: s <= 24 * HOUR_S ? 'critical' : s <= 72 * HOUR_S ? 'heat' : 'calm',
    over: s === 0,
  };
}

/** 서버 시각과 기기 시계의 차이. 기기 시계가 틀려도 카운트다운은 서버 기준으로 흐른다. */
export function clockOffset(asOf: string, deviceNow: number) {
  const server = Date.parse(asOf);
  return Number.isFinite(server) ? server - deviceNow : 0;
}

/** 시작 시각부터 24시간 단위 일차(1..durationDays). */
export function sprintDay(startedAt: string, nowMs: number, durationDays: number) {
  const day = Math.floor((nowMs - Date.parse(startedAt)) / DAY_MS) + 1;
  return Math.min(durationDays, Math.max(1, day));
}

/** Day 칸 안에서 지금 위치(0~1). */
export function dayProgress(dayStart: string, nowMs: number) {
  return Math.min(1, Math.max(0, (nowMs - Date.parse(dayStart)) / DAY_MS));
}

export type View = 'home' | 'tasks' | 'project';
const VIEWS: Record<string, { view: View; mine: boolean }> = {
  home: { view: 'home', mine: false },
  tasks: { view: 'tasks', mine: false },
  project: { view: 'project', mine: false },
  // 2026-10-05 이전 메뉴 7개. 북마크·공유 링크를 새 메뉴로 연다.
  today: { view: 'home', mine: false },
  team: { view: 'home', mine: false },
  plan: { view: 'tasks', mine: false },
  ai: { view: 'tasks', mine: false },
  mine: { view: 'tasks', mine: true },
  docs: { view: 'project', mine: false },
  result: { view: 'project', mine: false },
};
/** ?view= 값을 새 메뉴로. 모르는 값은 홈. */
export function viewFrom(param: string | null) {
  return param && Object.hasOwn(VIEWS, param) ? VIEWS[param] : VIEWS.home;
}

/** 팀 레인: 그 사람이 지금 붙잡고 있는 업무. 진행 중 상태 우선, 없으면 완료·보류가 아닌 첫 업무. */
export function laneTask<T extends RaceTask>(tasks: T[], person: number): T | null {
  const open = tasks.filter((t) => t.person === person && !t.done && !t.deferred);
  return open.find((t) => t.status === 'in_progress') ?? open[0] ?? null;
}

/** 진행 보고에서 고를 수 있는 업무와 처음 고를 업무. 팀원은 자기 업무만, 팀장은 전체(자기 것 먼저). */
export function reportChoices<T extends RaceTask>(
  tasks: T[],
  me: { person: number },
  owner: boolean,
) {
  const open = tasks.filter((t) => !t.done && (owner || t.person === me.person));
  return { open, first: laneTask(open, me.person) ?? open[0] ?? null };
}
