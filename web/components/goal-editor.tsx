'use client';
// 준비 중 팀장의 목표 고치기. 권한·상태는 서버(editGoal: owner, draft)가 판단하고 화면은 거절을 그대로 보여준다.
import { useState } from 'react';
import { SCOPE_LEVELS, levelOf, scopeText } from '@/lib/idea-dice';
import { ScopeSlider } from '@/components/project-create';

export type GoalFields = {
  title: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  duration: number;
};

type Agreement = {
  title: string;
  goal: string;
  scope: string;
  completion_criteria: string;
};

export function GoalEditor({
  agreement,
  durationDays,
  busy,
  onSave,
}: {
  agreement: Agreement;
  durationDays: number;
  busy: boolean;
  onSave: (fields: GoalFields) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const [criteria, setCriteria] = useState('');
  const [level, setLevel] = useState(2);
  function start() {
    setTitle(agreement.title);
    setGoal(agreement.goal);
    setScope(agreement.scope);
    setCriteria(agreement.completion_criteria);
    setLevel(levelOf(agreement.scope));
    setOpen(true);
  }
  if (!open)
    return (
      <section className="project-block goal-editor">
        <button type="button" className="btn" onClick={start}>
          목표 고치기
        </button>
        <p className="tiny muted">
          저장하면 목표 버전이 올라가고 팀원은 다시 동의해야 합니다.
        </p>
      </section>
    );
  return (
    <section className="project-block goal-editor">
      <form
        className="project-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await onSave({
            title,
            goal,
            scope,
            completionCriteria: criteria,
            duration: durationDays,
          });
          if (ok) setOpen(false);
        }}
      >
        <label>
          프로젝트 이름
          <input required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          목표
          <textarea required maxLength={1000} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="scope-field">
          <b>기능 범위 단계</b>
          <ScopeSlider
            value={level}
            onChange={(l) => {
              setLevel(l);
              setScope(scopeText(l));
              setCriteria(SCOPE_LEVELS[l - 1].criteria);
            }}
          />
          <p className="tiny muted">단계를 바꾸면 아래 두 칸이 그 단계 문장으로 바뀝니다.</p>
        </div>
        <label>
          기능 범위
          <textarea required maxLength={2000} value={scope} onChange={(e) => setScope(e.target.value)} />
        </label>
        <label>
          완료 기준
          <textarea
            required
            maxLength={2000}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
        </label>
        <p className="tiny muted">
          저장하면 목표 버전이 올라가고 팀원은 다시 동의해야 합니다.
        </p>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? '저장 중…' : '저장'}
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            취소
          </button>
        </div>
      </form>
    </section>
  );
}
