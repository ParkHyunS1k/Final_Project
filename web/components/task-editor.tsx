'use client';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import type { Task } from '@/lib/sprint';
import type { ProjectMeta } from './project-workspace';

export function TaskEditor({
  task,
  tasks,
  members,
  projectDeadline,
  busy,
  error,
  onSave,
  onClose,
}: {
  task: Task | null;
  tasks: Task[];
  members: ProjectMeta['members'];
  /** 프로젝트 최종 기한(UTC ISO). 준비 중이면 null이며 마감을 지정할 수 없다. */
  projectDeadline: string | null;
  busy: boolean;
  error: string;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [person, setPerson] = useState(task?.person ?? members[0]?.person ?? 0);
  const [remaining, setRemaining] = useState(task?.remaining ?? 1);
  const [dependsOn, setDependsOn] = useState(task?.dependsOn ?? []);
  // datetime-local은 로컬 시간대 문자열을 다룬다. 저장은 UTC 절대 시각으로 보낸다.
  const toLocal = (iso: string | null | undefined) =>
    iso
      ? new Date(Date.parse(iso) - new Date().getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : '';
  const [dueLocal, setDueLocal] = useState(toLocal(task?.dueAt));
  const candidates = tasks.filter((t) => t.id !== task?.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="demo-dialog">
        <DialogTitle>{task ? '업무 편집' : '업무 추가'}</DialogTitle>
        <DialogDescription>
          담당자와 남은 시간을 정하면 전원 하루 8시간 가정으로 실행 순서를
          계산합니다. 승인된 마감은 이 예상 종료와 별개이며, 지정하면 마감
          2시간·1시간·30분 전에 담당자에게 이메일을 보냅니다.
        </DialogDescription>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await onSave({
                title,
                person,
                remaining,
                dependsOn,
                dueAt: dueLocal ? new Date(dueLocal).toISOString() : null,
                ...(task ? { taskId: task.id } : {}),
              })
            )
              onClose();
          }}
        >
          <fieldset disabled={busy} className="task-fields">
            <label className="input-label" htmlFor="task-title">
              업무 이름
            </label>
            <input
              id="task-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label className="input-label" htmlFor="task-person">
              담당자
            </label>
            <NativeSelect
              id="task-person"
              value={person}
              onChange={(e) => setPerson(Number(e.target.value))}
            >
              {!members.some((m) => m.person === person) && (
                <NativeSelectOption value={person} disabled>
                  참여 중인 팀원을 선택해주세요
                </NativeSelectOption>
              )}
              {members.map((m) => (
                <NativeSelectOption key={m.person} value={m.person}>
                  {m.display_name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="input-label" htmlFor="task-hours">
              남은 시간
            </label>
            <input
              id="task-hours"
              type="number"
              min="0.5"
              max="200"
              step="0.5"
              required
              value={remaining}
              onChange={(e) => setRemaining(Number(e.target.value))}
            />
            <label className="input-label" htmlFor="task-due">
              승인된 마감 (선택)
            </label>
            <input
              id="task-due"
              type="datetime-local"
              value={dueLocal}
              disabled={!projectDeadline}
              max={toLocal(projectDeadline)}
              onChange={(e) => setDueLocal(e.target.value)}
            />
            <p className="tiny muted">
              {projectDeadline
                ? '비워두면 마감 미정으로 저장되고 독촉 이메일이 예약되지 않습니다. 프로젝트 최종 기한을 넘길 수 없습니다.'
                : '스프린트를 시작한 뒤에 업무 마감을 지정할 수 있습니다.'}
            </p>
            <p className="tiny muted">
              합의한 결과물은 부가 업무로 미룰 수 없습니다. 업무를 나누거나
              합쳐도 약속한 기능은 유지합니다.
            </p>
            <fieldset className="task-dependencies">
              <legend>먼저 끝나야 하는 업무</legend>
              {candidates.length ? (
                candidates.map((t) => (
                  <label
                    className="agree"
                    key={t.id}
                    htmlFor={`dependency-${t.id}`}
                  >
                    <Checkbox
                      id={`dependency-${t.id}`}
                      checked={dependsOn.includes(t.id)}
                      onCheckedChange={(v) =>
                        setDependsOn((ids) =>
                          v ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                        )
                      }
                    />
                    {t.title}
                    {t.done ? ' · 완료' : ''}
                  </label>
                ))
              ) : (
                <p className="muted">선택할 선행 업무가 없습니다.</p>
              )}
            </fieldset>
            <button
              className="btn primary wide"
              disabled={
                !title.trim() || !members.some((m) => m.person === person)
              }
            >
              저장하고 재계산
            </button>
          </fieldset>
        </form>
        {busy && <p className="muted">저장 중입니다…</p>}
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
