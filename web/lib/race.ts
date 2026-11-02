// 작업 화면 레이스 표시용 순수 계산. 서버가 준 값(asOf·plan)만 읽고 저장하지 않는다.
import { seoulTime } from './sprint.ts';

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

/** 팀 레인에 붙이는 승인된 업무 마감(KST). 예상 완료가 아니라 팀장이 정한 마감이다. */
export function dueLabel(dueAt: string | null | undefined) {
  if (!dueAt) return '마감 미정';
  const [, month, day] = seoulTime(dueAt).slice(0, 10).split('-');
  return `${Number(month)}/${Number(day)} ${seoulTime(dueAt).slice(11)} 마감`;
}

export type FocusTask = RaceTask & { dueAt?: string | null };

const isMine = (t: RaceTask, person: number) => t.person === person && !t.deferred;

/** 큰 카운트다운이 셀 내 업무: 미완료·마감 있음 중 가장 이른 마감. 지난 마감도 포함한다. */
export function focusTask<T extends FocusTask>(tasks: T[], person: number): T | null {
  const open = tasks.filter((t) => isMine(t, person) && !t.done && t.dueAt);
  return open.reduce<T | null>(
    (first, t) => (!first || Date.parse(t.dueAt!) < Date.parse(first.dueAt!) ? t : first),
    null,
  );
}

/** focusTask가 없을 때 대기 중인 이유. */
export function waitReason(tasks: FocusTask[], person: number) {
  const mine = tasks.filter((t) => isMine(t, person));
  if (!mine.length) return 'unassigned' as const;
  return mine.some((t) => !t.done) ? ('undated' as const) : ('done' as const);
}

export type TensionStage = 'idle' | 'calm' | 'heat' | 'critical' | 'final' | 'over';
const HOUR_MS = HOUR_S * 1000;

/** 남은 시간 → 긴장 단계와 배경 붉은 기(0~1). null이면 세는 업무가 없다. 다음 업무로 넘어가면 그 마감 기준으로 다시 옅어진다. */
export function tension(msLeft: number | null): { stage: TensionStage; tint: number } {
  if (msLeft === null || Number.isNaN(msLeft)) return { stage: 'idle', tint: 0 };
  if (msLeft <= 0) return { stage: 'over', tint: 1 };
  if (msLeft > 72 * HOUR_MS) return { stage: 'calm', tint: 0 };
  const stage = msLeft <= HOUR_MS ? 'final' : msLeft <= 24 * HOUR_MS ? 'critical' : 'heat';
  return { stage, tint: Math.pow(1 - msLeft / (72 * HOUR_MS), 1.4) };
}

/** 캘린더 칩 단계. 자기 업무 마감 기준이며 큰 카운트다운보다 늦게 달아오른다. */
export function chipStage(msLeft: number) {
  if (msLeft <= 0) return 'over' as const;
  if (msLeft <= HOUR_MS) return 'final' as const;
  if (msLeft <= 6 * HOUR_MS) return 'critical' as const;
  return msLeft <= 24 * HOUR_MS ? ('heat' as const) : ('calm' as const);
}

/** 큰 카운트다운 숫자. 24시간을 넘어도 시간 단위, 마감이 지나면 + 와 지난 시간. */
export function focusClock(msLeft: number) {
  return msLeft > 0 ? countdown(msLeft).text : `+${countdown(-msLeft).text}`;
}

// ponytail: 서버 상태의 checkins는 프로젝트 전체 최근 20건. 하루 20건을 넘으면 이른 보고가 빠진다. 필요하면 서버에서 멤버별 마지막 보고 시각을 내려준다.
/** 오늘(KST) 이 사람이 담당한 업무에 진행 보고가 있는가. 팀장이 대신 보고한 경우도 담당자 기준으로 센다. */
export function checkedInToday(
  checkins: { task_id: number; created_at: string }[],
  tasks: { id: number; person: number }[],
  person: number,
  nowMs: number,
) {
  const day = (iso: string) => seoulTime(iso).slice(0, 10);
  const today = day(new Date(nowMs).toISOString());
  return checkins.some(
    (c) =>
      tasks.find((t) => t.id === c.task_id)?.person === person && day(c.created_at) === today,
  );
}
