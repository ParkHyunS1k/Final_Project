'use client';
import { useState } from 'react';

export type SourceSummary = {
  id: string;
  authorId: string;
  origin: string;
  capturedAt: string | null;
  hash: string;
  supersedes: string | null;
  createdAt: string;
  size: number;
};

/**
 * 문서·대화 붙여넣기. 서버는 받은 문자열을 그대로 보존하며, 원문 안의 문장은
 * 데이터로만 다룬다. 외부 메신저 자동 수집이나 파일 가져오기는 제공하지 않는다.
 */
export function SourcePaste({
  busy,
  disabled,
  supersedes,
  onSubmit,
}: {
  busy: boolean;
  disabled: boolean;
  supersedes: string | null;
  onSubmit: (input: {
    body: string;
    origin: string;
    capturedAt: string;
    supersedes: string | null;
  }) => Promise<boolean>;
}) {
  const [body, setBody] = useState('');
  const [origin, setOrigin] = useState('');
  const [capturedAt, setCapturedAt] = useState('');
  return (
    <form
      className="project-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit({ body, origin, capturedAt, supersedes }))
          setBody('');
      }}
    >
      <label className="input-label" htmlFor="source-body">
        기획서·회의록·대화 붙여넣기
      </label>
      <textarea
        id="source-body"
        rows={10}
        required
        maxLength={40000}
        placeholder="줄바꿈과 들여쓰기를 포함해 그대로 붙여넣어 주세요."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <label className="input-label" htmlFor="source-origin">
        출처 (선택)
      </label>
      <input
        id="source-origin"
        maxLength={200}
        placeholder="예: 팀 카카오톡, 9월 9일 회의록"
        value={origin}
        onChange={(e) => setOrigin(e.target.value)}
      />
      <label className="input-label" htmlFor="source-captured">
        대화 시각 (선택)
      </label>
      <input
        id="source-captured"
        type="datetime-local"
        value={capturedAt}
        onChange={(e) => setCapturedAt(e.target.value)}
      />
      <p className="tiny muted">
        {supersedes
          ? '이전 원문을 대체하는 새 버전으로 저장합니다. 예전 버전과 그 근거 위치는 그대로 남습니다.'
          : '원문은 수정 없이 저장되며, 안에 있는 지시문은 실행하지 않고 인용 자료로만 다룹니다.'}
      </p>
      <button className="btn primary" disabled={busy || disabled || !body.trim()}>
        원문 저장
      </button>
    </form>
  );
}

export function SourceList({
  sources,
  selected,
  onSelect,
}: {
  sources: SourceSummary[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (!sources.length)
    return <p className="empty-copy">아직 붙여넣은 원문이 없습니다.</p>;
  return (
    <ul className="source-list">
      {sources.map((s) => (
        <li key={s.id}>
          <button
            className={s.id === selected ? 'text-link active' : 'text-link'}
            onClick={() => onSelect(s.id)}
          >
            {new Date(s.createdAt).toLocaleString('ko-KR', {
              timeZone: 'Asia/Seoul',
            })}{' '}
            · {s.origin || '출처 미기재'} · {s.size}자
            {s.supersedes ? ' · 수정본' : ''}
          </button>
        </li>
      ))}
    </ul>
  );
}
