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
  busy,
  error,
  onSave,
  onClose,
}: {
  task: Task | null;
  tasks: Task[];
  members: ProjectMeta['members'];
  busy: boolean;
  error: string;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [person, setPerson] = useState(task?.person ?? members[0]?.person ?? 0);
  const [remaining, setRemaining] = useState(task?.remaining ?? 1);
  const [optional, setOptional] = useState(task?.optional ?? false);
  const [dependsOn, setDependsOn] = useState(task?.dependsOn ?? []);
  const candidates = tasks.filter((t) => t.id !== task?.id && !t.deferred);
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
          담당자와 남은 시간을 정하면 가용시간에 맞춰 실행 순서를 계산합니다.
        </DialogDescription>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await onSave({
                title,
                person,
                remaining,
                optional,
                dependsOn,
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
            <label className="agree" htmlFor="task-optional">
              <Checkbox
                id="task-optional"
                checked={optional}
                onCheckedChange={(v) => setOptional(Boolean(v))}
              />
              부가 업무 · 복구안에서 다음 스프린트로 미룰 수 있음
            </label>
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
