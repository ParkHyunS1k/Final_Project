// 회의 제안 계산기 — 순수 함수. 일정 계산(web/lib/sprint.ts의 plan())이 이미 만든
// Plan 결과를 입력으로 받아 "언제, 무슨 주제로 회의하면 좋을지"를 결정적으로 도출한다.
// Date.now() / Math.random() / I/O / 전역 상태를 쓰지 않는다. now는 반드시 인자로 받는다.
import type { Plan, PlanTask } from './sprint';

export type MeetingSuggestion = {
  id: string; // 안정적 식별자. 같은 입력이면 같은 값 (kind + 대상 조합)
  kind: 'handoff' | 'rebalance' | 'scope' | 'integration' | 'assign';
  title: string; // 회의 주제 한 줄
  agenda: string[]; // 다룰 항목. 2~4개
  reason: string; // 왜 지금인지. 숫자 근거 포함
  suggestedAt: string | null; // ISO. 계산 근거가 없으면 null
  taskIds: number[]; // 관련 업무
  people: number[]; // 관련 담당자 person 인덱스
};

type MemberInfo = { person: number; displayName: string };

function nameOf(members: MemberInfo[], person: number): string {
  return members.find((m) => m.person === person)?.displayName ?? '담당자 미정';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function meetingSuggestions(
  tasks: PlanTask[],
  currentPlan: Plan,
  members: MemberInfo[],
  now: Date,
): MeetingSuggestion[] {
  const active = tasks.filter((t) => !t.done);
  const activeById = new Map(tasks.map((t) => [t.id, t]));
  const memberPersons = new Set(members.map((m) => m.person));
  const nowIso = now.toISOString();

  const suggestions: MeetingSuggestion[] = [];

  // rebalance: 남은 공수가 가용량을 초과한 담당자가 있으면 하나로 묶어 제안한다.
  const overloaded = currentPlan.perPerson.filter((p) => p.needed > p.available);
  if (overloaded.length > 0) {
    const overloadedPersons = new Set(overloaded.map((p) => p.person));
    const reasonParts = overloaded.map(
      (p) => `${nameOf(members, p.person)} ${round1(p.needed - p.available)}시간 초과`,
    );
    suggestions.push({
      id: 'rebalance:global',
      kind: 'rebalance',
      title: '업무 재분배 회의',
      agenda: ['초과 인원 현황 공유', '업무 재배치 후보 논의', '재배치 후 남은 공수 확인'],
      reason: `공수 초과: ${reasonParts.join(', ')}`,
      suggestedAt: nowIso,
      taskIds: active
        .filter((t) => overloadedPersons.has(t.person))
        .map((t) => t.id),
      people: overloaded.map((p) => p.person),
    });
  }

  // scope: 마감 내 배치 불가능한 업무가 있으면 하나로 묶어 제안한다.
  if (currentPlan.unscheduled.length > 0) {
    const unscheduledTasks = active.filter((t) =>
      currentPlan.unscheduled.includes(t.id),
    );
    const people = [...new Set(unscheduledTasks.map((t) => t.person))];
    suggestions.push({
      id: 'scope:global',
      kind: 'scope',
      title: '일정 조정 회의',
      agenda: ['배치 불가능한 업무 목록 확인', '순서 조정 또는 담당자 재배치 논의'],
      reason: `마감 내 배치 불가능한 업무 ${currentPlan.unscheduled.length}건`,
      suggestedAt: nowIso,
      taskIds: unscheduledTasks.map((t) => t.id),
      people,
    });
  }

  // handoff: 미완료 업무 B가 다른 담당자의 미완료 업무 A에 의존하면, 담당자 쌍 단위로 묶는다.
  const handoffGroups = new Map<
    string,
    { aPerson: number; bPerson: number; taskIds: Set<number>; finishTimes: number[] }
  >();
  for (const b of active) {
    for (const depId of b.dependsOn) {
      const a = activeById.get(depId);
      if (!a || a.done) continue;
      if (a.person === b.person) continue;
      const key = `${a.person}-${b.person}`;
      let group = handoffGroups.get(key);
      if (!group) {
        group = { aPerson: a.person, bPerson: b.person, taskIds: new Set(), finishTimes: [] };
        handoffGroups.set(key, group);
      }
      group.taskIds.add(a.id);
      group.taskIds.add(b.id);
      const finish = currentPlan.finishes[a.id];
      if (finish) group.finishTimes.push(Date.parse(finish));
    }
  }
  for (const key of [...handoffGroups.keys()].sort()) {
    const group = handoffGroups.get(key)!;
    const earliest = group.finishTimes.length
      ? Math.min(...group.finishTimes)
      : null;
    suggestions.push({
      id: `handoff:${key}`,
      kind: 'handoff',
      title: '업무 인계 회의',
      agenda: [
        `${nameOf(members, group.aPerson)} → ${nameOf(members, group.bPerson)} 인계 항목 확인`,
        '인계 시점과 시작 조건 맞추기',
      ],
      reason: `${nameOf(members, group.aPerson)}의 업무 종료 예정과 ${nameOf(members, group.bPerson)}의 업무 시작이 맞물립니다`,
      suggestedAt: earliest === null ? null : new Date(earliest).toISOString(),
      taskIds: [...group.taskIds].sort((x, y) => x - y),
      people: [group.aPerson, group.bPerson],
    });
  }

  // integration: 선행 업무가 2개 이상 모이는 미완료 업무마다 하나씩 제안한다.
  const integrationTasks = active
    .filter((t) => t.dependsOn.length >= 2)
    .sort((x, y) => x.id - y.id);
  for (const t of integrationTasks) {
    const people = [
      ...new Set([t.person, ...t.dependsOn.map((d) => activeById.get(d)?.person).filter((p): p is number => p !== undefined)]),
    ];
    suggestions.push({
      id: `integration:${t.id}`,
      kind: 'integration',
      title: '통합 지점 점검 회의',
      agenda: [`선행 업무 ${t.dependsOn.length}건 진행 상황 확인`, '통합 시점과 순서 합의'],
      reason: `업무 ${t.id}에 선행 업무 ${t.dependsOn.length}건이 모입니다`,
      suggestedAt: currentPlan.starts[t.id] ?? null,
      taskIds: [t.id, ...t.dependsOn].sort((x, y) => x - y),
      people,
    });
  }

  // assign: 팀에 없는 담당자에게 배정된 미완료 업무를 하나로 묶어 제안한다.
  const unassignedTasks = active.filter((t) => !memberPersons.has(t.person));
  if (unassignedTasks.length > 0) {
    suggestions.push({
      id: 'assign:global',
      kind: 'assign',
      title: '담당자 배정 회의',
      agenda: ['담당 미정 업무 목록 확인', '담당자 배정'],
      reason: `담당자 미배정 업무 ${unassignedTasks.length}건`,
      suggestedAt: nowIso,
      taskIds: unassignedTasks.map((t) => t.id),
      people: [...new Set(unassignedTasks.map((t) => t.person))],
    });
  }

  suggestions.sort((x, y) => {
    if (x.suggestedAt === null && y.suggestedAt === null) return 0;
    if (x.suggestedAt === null) return 1;
    if (y.suggestedAt === null) return -1;
    return Date.parse(x.suggestedAt) - Date.parse(y.suggestedAt);
  });

  return suggestions.slice(0, 5);
}
