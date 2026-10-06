'use client';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { DeadlineCalendar } from '@/components/deadline-calendar';
import type { ProjectMeta } from '@/components/project-workspace';
import { useServerNow } from '@/hooks/use-server-now';
import { dueLabel, laneTask, sprintPulse } from '@/lib/race';
import type { Plan, Task as ServerTask } from '@/lib/sprint';
import type { Lifecycle } from '@/lib/sprint-policy';
import type { Wire } from '@/lib/wire';

type Task = Wire<ServerTask>;

// 홈 = 팀 레이스 현황. 계산은 lib/race의 순수 함수, 표시는 서버가 준 plan·asOf만 쓴다.
export function RaceHome({
  lifecycle,
  asOf,
  startedAt,
  deadline,
  tasks,
  plan,
  members,
  me,
  people,
  onTasks,
}: {
  lifecycle: Lifecycle;
  asOf: string;
  startedAt: string | null;
  deadline: string | null;
  tasks: Task[];
  plan: Plan | null;
  members: ProjectMeta['members'];
  me: ProjectMeta['me'];
  people: { name: string }[];
  onTasks: () => void;
}) {
  const live = useServerNow(lifecycle === 'active' ? asOf : null);
  const now = live || Date.parse(asOf);
  const pulse = sprintPulse(tasks, plan);
  const name = (person: number) =>
    members.find((m) => m.person === person)?.display_name ?? people[person]?.name ?? '미배정';
  const blocked = tasks.filter((t) => pulse.bottlenecks.includes(t.id));
  const waiting = tasks.filter(
    (t) => !t.done && t.dependsOn.some((d) => pulse.bottlenecks.includes(d)),
  );
  return (
    <>
      {!tasks.length ? (
        <div className="race-alert calm">
          <div>
            <b>업무가 아직 없습니다.</b> 업무와 담당자를 등록하면 남은 공수와 병목을 계산합니다.
            <button className="text-link" onClick={onTasks}>
              업무로 이동 <ArrowRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        plan && (
          <div className="race-stats">
            <div className="race-stat">
              <b>
                {pulse.done}/{pulse.total}
              </b>
              <span>완료 업무</span>
            </div>
            <div className={`race-stat${pulse.hoursOver > 0 ? ' bad' : ''}`}>
              <b>
                {pulse.hoursOver > 0 ? `+${pulse.hoursOver}h` : `${Math.abs(pulse.hoursOver)}h`}
              </b>
              <span>{pulse.hoursOver > 0 ? '공수 초과' : '공수 여유'}</span>
            </div>
            <div className={`race-stat${pulse.bottlenecks.length ? ' bad' : ' good'}`}>
              <b>{pulse.bottlenecks.length}건</b>
              <span>병목</span>
            </div>
          </div>
        )
      )}
      <DeadlineCalendar
        startedAt={startedAt}
        deadline={deadline}
        now={now}
        tasks={tasks}
        people={people}
        bottlenecks={pulse.bottlenecks}
        onPlan={onTasks}
      />
      {blocked.length > 0 && (
        <output className="race-alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <b>병목</b> · &apos;{blocked[0].title}&apos;({name(blocked[0].person)}) 마감 안에 끝나지
            않음{blocked.length > 1 ? ` 외 ${blocked.length - 1}건` : ''}
            {waiting.length > 0 && ` · '${waiting[0].title}'(${name(waiting[0].person)}) 대기`}
            <p>목표를 줄이거나 기한을 미루는 대신 담당 재배정·진행 순서·구현 방법을 바꿔주세요.</p>
            <button className="text-link" onClick={onTasks}>
              업무에서 조정 <ArrowRight size={15} />
            </button>
          </div>
        </output>
      )}
      {plan && tasks.length > 0 && (
        <section className="race-lanes" aria-label="팀 레인">
          <h2 className="race-label">팀 레인 · 지금 붙잡고 있는 업무와 남은 공수</h2>
          {members
            .filter((m) => !m.left_at)
            .map((m) => {
              const lane = laneTask(tasks, m.person);
              const p = plan.perPerson.find((x) => x.person === m.person);
              const over = !!p && p.needed > p.available;
              const pct =
                p && p.available > 0
                  ? Math.min(100, (p.needed / p.available) * 100)
                  : p?.needed
                    ? 100
                    : 0;
              return (
                <div key={m.person} className={`race-lane${m.person === me.person ? ' me' : ''}`}>
                  <b>
                    {m.display_name}
                    {m.person === me.person && <small> 나</small>}
                  </b>
                  <span className="race-lane-task">
                    {lane ? lane.title : '진행 중인 업무 없음'}
                    {lane && <small className="race-due">{dueLabel(lane.dueAt)}</small>}
                    {lane && pulse.bottlenecks.includes(lane.id) && (
                      <span className="race-tag">병목</span>
                    )}
                  </span>
                  <div>
                    <div className={`race-meter${over ? ' over' : ''}`}>
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    <span className="race-hours">
                      {p?.needed ?? 0}h / {Math.round((p?.available ?? 0) * 10) / 10}h
                    </span>
                  </div>
                </div>
              );
            })}
          <p className="tiny muted">
            전원 하루 {plan.dailyHours}시간은 남은 기간과 공수를 비교하기 위한 계산 가정이며, 근무시간
            기록이 아닙니다.
          </p>
        </section>
      )}
    </>
  );
}
