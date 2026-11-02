'use client';
// 새 프로젝트 만들기: 주사위 단어 3개(잠금), 한 줄 아이디어(선택), 기능 범위 5단계.
// 설계: docs/superpowers/specs/2026-10-29-idea-dice-create-design.md
import { useState } from 'react';
import { Dices, Lock, LockOpen } from 'lucide-react';
import {
  DEFAULT_LEVEL,
  SCOPE_LEVELS,
  createBody,
  roll,
  type CreateBody,
} from '@/lib/idea-dice';

export function ScopeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (level: number) => void;
}) {
  return (
    <div className="scope-slider">
      <input
        type="range"
        min={1}
        max={SCOPE_LEVELS.length}
        step={1}
        value={value}
        aria-label="기능 범위 단계"
        aria-valuetext={SCOPE_LEVELS[value - 1].name}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="scope-steps">
        {SCOPE_LEVELS.map((l, i) => (
          <button
            key={l.name}
            type="button"
            className="scope-step"
            aria-pressed={value === i + 1}
            onClick={() => onChange(i + 1)}
          >
            {l.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProjectCreate({
  onSubmit,
}: {
  // true면 이동 중이므로 버튼을 계속 잠가 둔다(연타로 중복 생성 방지).
  onSubmit: (body: CreateBody) => Promise<boolean>;
}) {
  // 만들기 패널은 클라이언트에서 목록을 불러온 뒤에만 열리므로 첫 굴림이 SSR과 어긋나지 않는다.
  const [words, setWords] = useState(() => roll(['', '', ''], [false, false, false]));
  const [locked, setLocked] = useState([false, false, false]);
  const [idea, setIdea] = useState('');
  const [level, setLevel] = useState(DEFAULT_LEVEL);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = SCOPE_LEVELS[level - 1];
  return (
    <section className="project-panel">
      <h1>7일 안에 완성할 프로젝트</h1>
      <p>
        주사위를 굴려 떠오르는 게 있을 때까지 단어를 섞어 보세요. 마음에 드는
        단어는 자물쇠로 고정할 수 있어요.
      </p>
      <p className="tiny muted">
        만들면 준비 상태로 저장되고, 팀장이 시작한 시각부터 7일이 흐릅니다.
        혼자서도 시작할 수 있어요.
      </p>
      <form
        className="project-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          void onSubmit(createBody({ words, idea, level, agreed })).then((ok) => {
            if (!ok) setBusy(false);
          });
        }}
      >
        <div className="dice-board">
          {words.map((w, i) => (
            <div className="dice-slot" key={i}>
              <span className="dice-word" key={`${i}-${w}`}>
                {w}
              </span>
              <button
                type="button"
                className="dice-lock"
                aria-pressed={locked[i]}
                aria-label={`${w} 고정`}
                onClick={() => setLocked(locked.map((v, j) => (j === i ? !v : v)))}
              >
                {locked[i] ? <Lock size={16} /> : <LockOpen size={16} />}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn dice-roll"
            disabled={locked.every(Boolean)}
            onClick={() => setWords(roll(words, locked))}
          >
            <Dices size={18} /> 다시 굴리기
          </button>
        </div>
        <label>
          떠오른 아이디어
          <input
            maxLength={100}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="떠오른 아이디어 한 줄 (비워도 돼요)"
          />
        </label>
        <div className="scope-field">
          <b>기능 범위</b>
          <ScopeSlider value={level} onChange={setLevel} />
          <p>{current.scope}</p>
          <p>
            <b>완료 기준</b> {current.criteria}
          </p>
        </div>
        <label className="agreement">
          <input
            type="checkbox"
            required
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />{' '}
          목표·기능 범위·완료 기준을 확인했습니다. 시작 후에는 바꿀 수 없으며
          실제 결제는 발생하지 않습니다.
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? '저장 중…' : '프로젝트 만들기'}
        </button>
      </form>
    </section>
  );
}
