'use client';
// 내 업무 마감에 따라 작업 화면을 달구는 장식 레이어. 초마다 다시 그려지므로 page.tsx와 분리한다.
import type { CSSProperties } from 'react';
import { useServerNow } from '@/hooks/use-server-now';
import { focusTask, tension } from '@/lib/race';
import type { Task as ServerTask } from '@/lib/sprint';
import type { Lifecycle } from '@/lib/sprint-policy';
import type { Wire } from '@/lib/wire';

export function TensionLayer({
  lifecycle,
  asOf,
  tasks,
  person,
}: {
  lifecycle: Lifecycle;
  asOf: string;
  tasks: Wire<ServerTask>[];
  person: number;
}) {
  const active = lifecycle === 'active';
  const now = useServerNow(active ? asOf : null);
  if (!active) return null;
  const task = focusTask(tasks, person);
  const { stage, tint } = tension(task ? Date.parse(task.dueAt!) - now : null);
  if (stage === 'idle' || stage === 'calm') return null;
  return (
    <>
      <div
        className={`tension-tint tension-${stage}`}
        style={{ '--tint': tint.toFixed(3) } as CSSProperties}
        aria-hidden="true"
      />
      <div className={`tension-edge tension-${stage}`} aria-hidden="true" />
    </>
  );
}
