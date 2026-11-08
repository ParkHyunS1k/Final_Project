'use client';
// 마이페이지 GitHub 계정 연결(2026-11-08). 연결·해제는 Supabase가 하고, 서버 sync가 DB를 맞춘다.
import { useCallback, useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { apiFetch, linkGithub, returnUrl, unlinkGithub } from '@/lib/supabase-browser';

const ALREADY_LINKED = '이미 다른 계정에 연결된 GitHub입니다.';

export function GithubLinkCard({
  account,
  busy,
  error,
  onLink,
  onUnlink,
}: {
  account: { login: string } | null;
  busy: boolean;
  error: string;
  onLink: () => void;
  onUnlink: () => void;
}) {
  return (
    <section className="hub-card hub-info">
      <GitBranch size={27} />
      <div>
        <h2>{account ? `@${account.login} 연결됨` : 'GitHub 계정 연결'}</h2>
        <p>
          {account
            ? '팀원에게 GitHub 아이디가 보이고, 학습 확인은 이 계정의 커밋으로 질문을 만들어요.'
            : '학습 확인은 GitHub를 연결해야 시작할 수 있어요. 공개 프로필만 읽고 저장소 권한은 받지 않아요.'}
        </p>
        {error && <p role="alert">{error}</p>}
      </div>
      {account ? (
        <button className="btn" disabled={busy} onClick={onUnlink}>
          연결 해제
        </button>
      ) : (
        <button className="btn primary" disabled={busy} onClick={onLink}>
          GitHub 연결
        </button>
      )}
    </section>
  );
}

// 이미 다른 계정에 붙은 GitHub로 연결하면 Supabase가 오류 파라미터를 붙여 돌려보낸다.
function alreadyLinked(href: string) {
  const u = new URL(href);
  const hash = new URLSearchParams(u.hash.slice(1));
  const code = u.searchParams.get('error_code') ?? hash.get('error_code');
  return code === 'identity_already_exists';
}

// 서버가 Supabase 신원으로 연결을 맞추고 결과를 돌려준다.
async function syncGithub(): Promise<{ login: string } | null> {
  const response = await apiFetch('/api/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'sync' }),
  });
  const body = (await response.json().catch(() => ({}))) as { github?: { login: string } | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'GitHub 연결 상태를 불러오지 못했습니다.');
  return body.github ?? null;
}

export function GithubLink() {
  const [account, setAccount] = useState<{ login: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'GitHub 연결을 처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const failed = alreadyLinked(location.href);
    // 오류로 돌아온 주소에는 code가 없으니 지워도 로그인 교환에 영향이 없다.
    if (failed) history.replaceState(null, '', returnUrl(location.href));
    // 처음 상태가 busy=true라 여기서 바로 setState하지 않는다(react-compiler EffectSetState).
    void syncGithub()
      .then((next) => {
        setAccount(next);
        if (failed) setError(ALREADY_LINKED);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error && e.message ? e.message : 'GitHub 연결 상태를 불러오지 못했습니다.'),
      )
      .finally(() => setBusy(false));
  }, []);

  return (
    <GithubLinkCard
      account={account}
      busy={busy}
      error={error}
      onLink={() => void run(linkGithub)}
      onUnlink={() =>
        void run(async () => {
          await unlinkGithub();
          setAccount(await syncGithub());
        })
      }
    />
  );
}
