'use client';
import { ArrowRight } from 'lucide-react';
import { DeadlineCalendar } from '@/components/deadline-calendar';
import type { ProjectMeta } from '@/components/project-workspace';
import { useServerNow } from '@/hooks/use-server-now';
import {
  checkedInToday,
  dueLabel,
  focusClock,
  focusTask,
  laneTask,
  tension,
  waitReason,
} from '@/lib/race';
import type { Task as ServerTask } from '@/lib/sprint';
import type { Lifecycle } from '@/lib/sprint-policy';
import type { Wire } from '@/lib/wire';

export { DeadlineCalendar };

type Task = Wire<ServerTask>;

const WAIT_LABEL = {
  done: '내 업무 모두 완료 · 대기 중',
  undated: '마감이 정해진 내 업무 없음 · 대기 중',
  unassigned: '배정된 내 업무 없음 · 대기 중',
};

// 내 업무 중 마감이 가장 가까운 업무를 크게 센다. now는 서버 기준 시각이다.
export function FocusCountdown({
  tasks,
  person,
  now,
}: {
  tasks: Task[];
  person: number;
  now: number;
}) {
  const task = focusTask(tasks, person);
  if (!task)
    return (
      <section className="focus-hero" aria-label="내 업무 마감">
        <p className="focus-label">{WAIT_LABEL[waitReason(tasks, person)]}</p>
        <div className="focus-clock idle">대기 중</div>
      </section>
    );
  const left = Date.parse(task.dueAt!) - now;
  const { stage } = tension(left);
  const clock = focusClock(left);
  return (
    <section className="focus-hero" aria-label="내 업무 마감">
      <p className="focus-label">
        <em>{task.title}</em> {stage === 'over' ? '마감 초과' : '마감까지'}
      </p>
      <div className={`focus-clock ${stage}`} role="timer">
        {clock.slice(0, -2)}
        <span className="focus-sec" key={clock.slice(-2)}>
          {clock.slice(-2)}
        </span>
      </div>
    </section>
  );
}

export function TeamCheckins({
  members,
  me,
  tasks,
  checkins,
  now,
  active,
}: {
  members: ProjectMeta['members'];
  me: ProjectMeta['me'];
  tasks: Task[];
  checkins: { task_id: number; created_at: string }[];
  now: number;
  /** 진행 중일 때만 오늘 체크인 여부를 묻는다. */
  active: boolean;
}) {
  return (
    <section>
      <div className="section-heading task-heading">
        <h2>팀원 체크인 현황</h2>
        <span className="tiny muted">오늘(KST) 진행 보고 기준</span>
      </div>
      <div className="race-checkins">
        {members
          .filter((m) => !m.left_at)
          .map((m) => {
            // 카운트다운과 같은 업무를 보여주고, 마감 미정만 남았으면 그 업무를 보여준다.
            const lane = focusTask(tasks, m.person) ?? laneTask(tasks, m.person);
            const ok = checkedInToday(checkins, tasks, m.person, now);
            return (
              <div key={m.person} className="race-checkin-row">
                <b>
                  {m.display_name}
                  {m.person === me.person && <small> 나</small>}
                </b>
                <span className="race-checkin-task">
                  {lane ? lane.title : '진행 중인 업무 없음'}
                  {lane && <small>{dueLabel(lane.dueAt)}</small>}
                </span>
                {active && (
                  <span className={`race-checkin-badge${ok ? ' ok' : ''}`}>
                    {ok ? '오늘 체크인 완료' : '아직 체크인 안 함'}
                  </span>
                )}
              </div>
            );
          })}
        <p className="tiny muted">
          하루 한 번 진행 보고로 완료·남은 일·막힘을 남겨주세요. 보고가 없어도 완주 판정에는 영향을
          주지 않습니다.
        </p>
      </div>
    </section>
  );
}

// 홈 = 내 업무 마감 카운트다운 + 일차별 마감. 체크인 현황·회의 제안은 page.tsx가 아래에 둔다.
export function RaceHome({
  lifecycle,
  asOf,
  startedAt,
  deadline,
  tasks,
  me,
  people,
  onTasks,
}: {
  lifecycle: Lifecycle;
  asOf: string;
  startedAt: string | null;
  deadline: string | null;
  tasks: Task[];
  me: ProjectMeta['me'];
  people: { name: string }[];
  onTasks: () => void;
}) {
  const active = lifecycle === 'active';
  const live = useServerNow(active ? asOf : null);
  const now = live || Date.parse(asOf);
  return (
    <>
      {!tasks.length ? (
        <div className="race-alert calm">
          <div>
            <b>업무가 아직 없습니다.</b> 업무와 담당자를 등록하면 마감까지 남은 시간을 셉니다.
            <button className="text-link" onClick={onTasks}>
              업무로 이동 <ArrowRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        active && <FocusCountdown tasks={tasks} person={me.person} now={now} />
      )}
      <DeadlineCalendar
        startedAt={startedAt}
        deadline={deadline}
        now={now}
        tasks={tasks}
        people={people}
        active={active}
        onPlan={onTasks}
      />
    </>
  );
}
