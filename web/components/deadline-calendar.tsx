import { ArrowRight, CalendarDays, Check, Flag } from 'lucide-react';
import { deadlineDays, seoulTime, type Task } from '@/lib/sprint';

const DAY_MS = 86400000;
const weekday = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  weekday: 'short',
});
function dayLabel(iso: string) {
  const [, month, day] = seoulTime(iso).slice(0, 10).split('-');
  return `${Number(month)}/${Number(day)}(${weekday.format(new Date(iso))})`;
}

// 스프린트 일차별로 승인된 업무 마감만 보여준다. 계산기의 예상 완료는 싣지 않는다.
export function DeadlineCalendar({
  startedAt,
  deadline,
  asOf,
  tasks,
  people,
  onPlan,
}: {
  startedAt: string | null;
  deadline: string | null;
  /** 서버가 알려준 현재 시각. 렌더 중 Date.now()를 쓰지 않는다. */
  asOf: string;
  tasks: Task[];
  people: { name: string }[];
  onPlan: () => void;
}) {
  const calendar =
    startedAt && deadline ? deadlineDays(startedAt, deadline, tasks) : null;
  const now = Date.parse(asOf);
  return (
    <section className="deadline-calendar">
      <div className="section-heading">
        <h2>
          <CalendarDays size={19} /> 일차별 마감
        </h2>
        <span className="tiny muted">승인된 업무 마감 · KST</span>
      </div>
      {!calendar || !deadline ? (
        <p className="tiny muted">
          스프린트를 시작하면 그 시각부터 Day 1이 정해지고 일차별 마감이
          표시됩니다.
        </p>
      ) : (
        <>
          <ol className="calendar-grid">
            {calendar.days.map((d) => {
              const start = Date.parse(d.start);
              const when =
                now >= start + DAY_MS ? ' past' : now >= start ? ' today' : '';
              return (
                <li key={d.day} className={'calendar-day' + when}>
                  <div className="calendar-head">
                    <b>Day {d.day}</b>
                    <span>{dayLabel(d.start)}</span>
                  </div>
                  {d.tasks.map((t) => {
                    const late = !t.done && Date.parse(t.dueAt!) < now;
                    return (
                      <div
                        key={t.id}
                        className={
                          'deadline-card' +
                          (t.done ? ' done' : late ? ' late' : '')
                        }
                      >
                        <span className="deadline-title">
                          {t.done && <Check size={13} />}
                          {t.title}
                        </span>
                        <span className="deadline-meta">
                          {seoulTime(t.dueAt!).slice(11)} ·{' '}
                          {people[t.person]?.name ?? '미배정'}
                          {late ? ' · 마감 지남' : ''}
                        </span>
                      </div>
                    );
                  })}
                  {d.day === calendar.days.length && (
                    <div className="deadline-card final">
                      <span className="deadline-title">
                        <Flag size={13} /> 최종 기한
                      </span>
                      <span className="deadline-meta">
                        {seoulTime(deadline).slice(11)}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {calendar.undated.length > 0 && (
            <button className="text-link calendar-undated" onClick={onPlan}>
              마감 미정 {calendar.undated.length}개 · 프로젝트 업무에서 정하기{' '}
              <ArrowRight size={15} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
