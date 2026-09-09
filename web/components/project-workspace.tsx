'use client';
/* eslint-disable next/no-html-link-for-pages -- Project switching clears invitation and dashboard state via full navigation. */
import { useEffect, useState, type ReactNode } from 'react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Zap,
  Plus,
  ListTodo,
  UserRound,
  FileText,
  Users,
  ChartNoAxesCombined,
  Flag,
  Folder,
} from 'lucide-react';
export const workspaceViews = [
  { id: 'plan', label: '프로젝트 업무', icon: ListTodo },
  { id: 'mine', label: '내 할 일', icon: UserRound },
  { id: 'today', label: '스프린트 현황', icon: ChartNoAxesCombined },
  { id: 'docs', label: '프로젝트 문서', icon: FileText },
  { id: 'team', label: '팀 · 공수', icon: Users },
  { id: 'result', label: '완주 확인', icon: Flag },
];
function WorkspaceNav({
  view,
  onChange,
}: {
  view: string;
  onChange: (view: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {workspaceViews.map((item) => (
        <SidebarMenuItem key={item.id}>
          <SidebarMenuButton
            isActive={view === item.id}
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => {
              onChange(item.id);
              setOpenMobile(false);
            }}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function WorkspaceButton({
  onClick,
  children,
  ...props
}: {
  onClick: () => void;
  children: ReactNode;
  isActive?: boolean;
  title?: string;
  className?: string;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton
      {...props}
      onClick={() => {
        onClick();
        setOpenMobile(false);
      }}
    >
      {children}
    </SidebarMenuButton>
  );
}
export type ProjectMeta = {
  projectId: string;
  me: {
    role: string;
    person: number;
    agreedAt: string | null;
    agreedGoalVersion: number;
    leftAt: string | null;
    name: string;
  };
  details: {
    goal: string;
    deliverables: string;
    completion_criteria: string;
    legacy: number;
  };
  members: {
    display_name: string;
    role: string;
    person: number;
    agreed_at: string | null;
    agreed_goal_version: number;
    left_at: string | null;
    left_note: string;
  }[];
  invites: { id: string; email: string; expires_at: string; status: string }[];
};
export type InvitePreview = {
  title: string;
  goal: string;
  scope: string;
  completion_criteria: string;
  goal_version: number;
  lifecycle: string;
  deadline_at: string | null;
  duration_days: number;
  deliverables: string[];
};
async function api(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = (await res.json()) as {
    error?: string;
    projects: { id: string; title: string; role: string; lifecycle: string }[];
    projectId: string;
    token?: string;
    details: InvitePreview;
  };
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? '로그인이 필요합니다.'
        : data.error || '처리하지 못했습니다.',
    );
  return data;
}
export function ProjectWorkspace({
  children,
}: {
  children: (
    id: string,
    view: string,
    setView: (view: string) => void,
  ) => ReactNode;
}) {
  const [projects, setProjects] = useState<
    { id: string; title: string; role: string; lifecycle: string }[]
  >([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState('plan');
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState('');
  const [preview, setPreview] = useState<{ details: InvitePreview } | null>(
    null,
  );
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('invite') || '';

    api('/api/projects')
      .then(async (data) => {
        if (workspaceViews.some((v) => v.id === params.get('view')))
          setView(params.get('view')!);
        setInvite(token);
        setProjects(data.projects);
        setSelected(params.get('project') || data.projects[0]?.id || '');
        if (token)
          setPreview(
            await api('/api/projects?invite=' + encodeURIComponent(token)),
          );
      })
      .catch((e) => {
        setInvite(token);
        setError(e.message);
      })
      .finally(() => setLoaded(true));
  }, []);
  async function create(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const result = await api('/api/projects', {
        action: 'create',
        title: f.get('title'),
        goal: f.get('goal'),
        scope: f.get('scope'),
        duration: Number(f.get('duration')),
        deliverables: f.get('deliverables'),
        completionCriteria: f.get('criteria'),
        agreed: f.get('agreed') === 'on',
      });
      location.assign('/?project=' + encodeURIComponent(result.projectId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SidebarProvider className="workspace-shell">
      <Sidebar className="workspace-sidebar">
        <SidebarHeader>
          <div className="workspace-brand">
            <span>
              <Zap size={18} fill="currentColor" />
            </span>{' '}
            projectmate.
          </div>
          <WorkspaceButton
            className="workspace-new"
            onClick={() => setCreating(!creating)}
          >
            <Plus size={16} />
            {creating ? '만들기 닫기' : '새 프로젝트'}
          </WorkspaceButton>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>프로젝트</SidebarGroupLabel>
            <SidebarMenu>
              {projects.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <WorkspaceButton
                    isActive={p.id === selected}
                    title={p.title}
                    onClick={() => {
                      setSelected(p.id);
                      setCreating(false);
                      setView('plan');
                      history.replaceState(
                        null,
                        '',
                        '/?project=' + encodeURIComponent(p.id),
                      );
                    }}
                  >
                    <Folder size={16} />
                    <span>{p.title}</span>
                  </WorkspaceButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          {selected && (
            <SidebarGroup>
              <SidebarGroupLabel>작업 공간</SidebarGroupLabel>
              <WorkspaceNav
                view={view}
                onChange={(v) => {
                  setView(v);
                  setCreating(false);
                }}
              />
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <p className="sidebar-note">
            작게 시작하고, 함께 완성하기.
            <br />
            7–10일 스프린트
          </p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="workspace-body">
        <header className="workspace-bar">
          <SidebarTrigger aria-label="사이드바 열기 또는 닫기" />
          <span>프로젝트</span>
          <span>/</span>
          <b>
            {projects.find((p) => p.id === selected)?.title ?? '새 작업 공간'}
          </b>
        </header>
        {error && (
          <div className="project-panel" role="alert">
            <p>{error}</p>
            {error.includes('로그인') && (
              <a
                className="btn primary"
                href={
                  '/signin-with-chatgpt?return_to=' +
                  encodeURIComponent(
                    typeof location !== 'undefined'
                      ? location.pathname + location.search
                      : '/',
                  )
                }
                target="_top"
              >
                ChatGPT로 로그인
              </a>
            )}
          </div>
        )}
        {creating && (
          <section className="project-panel">
            <h1>7~10일 안에 완성할 프로젝트</h1>
            <p>
              팀이 함께 확인할 목표와 완료 기준부터 정합니다. 만들면 준비
              상태로 저장되고, 최소 2명이 최신 목표에 동의한 뒤 팀장이 시작할
              때 그 시각부터 선택한 일수만큼 기한이 확정됩니다. 준비 기간은
              스프린트 기간을 소모하지 않습니다.
            </p>
            <form className="project-form" onSubmit={create}>
              <label>
                프로젝트 이름
                <input name="title" required maxLength={100} />
              </label>
              <label>
                이번 스프린트 목표
                <textarea
                  name="goal"
                  required
                  maxLength={1000}
                  placeholder="누구의 어떤 문제를 해결할지"
                />
              </label>
              <label>
                기능 범위
                <textarea
                  name="scope"
                  required
                  maxLength={2000}
                  placeholder="이번에 만들 기능과 만들지 않을 것"
                />
              </label>
              <label>
                기간
                <select name="duration" defaultValue="10">
                  {[7, 8, 9, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}일
                    </option>
                  ))}
                </select>
              </label>
              <label>
                필수 결과물
                <textarea
                  name="deliverables"
                  required
                  placeholder="한 줄에 하나씩, 최대 10개"
                />
              </label>
              <label>
                완료 기준
                <textarea
                  name="criteria"
                  required
                  maxLength={2000}
                  placeholder="어떤 동작이나 결과를 확인하면 완성인가요?"
                />
              </label>
              <label className="agreement">
                <input type="checkbox" name="agreed" required />{' '}
                목표·기능 범위·결과물·완료 기준을 확인했습니다. 시작 후에는
                바꿀 수 없으며 실제 결제는 발생하지 않습니다.
              </label>
              <button className="btn primary" disabled={busy}>
                {busy ? '저장 중…' : '프로젝트 만들기'}
              </button>
            </form>
          </section>
        )}
        {invite ? (
          <section className="project-panel">
            <h1>프로젝트 초대</h1>
            {preview && (
              <>
                <h2>{preview.details.title}</h2>
                <p>{preview.details.goal}</p>
                <p>기능 범위: {preview.details.scope}</p>
                <ul>
                  {preview.details.deliverables.map((v: string) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
                <p>완료 기준: {preview.details.completion_criteria}</p>
                <p>
                  {preview.details.deadline_at
                    ? '마감: ' +
                      new Date(preview.details.deadline_at).toLocaleString(
                        'ko-KR',
                        { timeZone: 'Asia/Seoul' },
                      ) +
                      ' (진행 중 · 고정된 기한)'
                    : `아직 준비 중입니다. 시작하면 그 시각부터 ${preview.details.duration_days}일입니다.`}
                </p>
                <label className="agreement">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  목표 v{preview.details.goal_version}와 완료 기준을 확인하고
                  참여합니다.
                </label>
                <button
                  className="btn primary"
                  disabled={!agreed || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const result = await api('/api/projects', {
                        action: 'accept',
                        token: invite,
                        agreed,
                      });
                      location.replace(
                        '/?project=' + encodeURIComponent(result.projectId),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  초대 수락
                </button>
              </>
            )}
            <a className="btn" href="/">
              내 프로젝트로 돌아가기
            </a>
          </section>
        ) : selected && !creating ? (
          children(selected, view, setView)
        ) : loaded && !creating ? (
          <section className="project-panel">
            <h1>첫 스프린트를 만들어보세요.</h1>
            <p>목표를 정하고 팀원을 초대해 7~10일 동안 함께 진행합니다.</p>
          </section>
        ) : !loaded ? (
          <p className="project-panel">프로젝트를 불러오는 중입니다.</p>
        ) : null}
      </SidebarInset>
    </SidebarProvider>
  );
}
export function ProjectDetails({
  state,
  refresh,
}: {
  state: ProjectMeta & {
    asOf: string;
    sprint: { revision: number; finished: boolean; tasks: unknown[] };
  };
  refresh: () => Promise<unknown>;
}) {
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function runAction(action: string, extra: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/api/projects', {
        action,
        projectId: state.projectId,
        revision: state.sprint.revision,
        ...extra,
      });
      if (result.token)
        setLink(
          location.origin + '/?invite=' + encodeURIComponent(result.token),
        );
      await refresh();
      setMessage(
        action === 'invite'
          ? '초대 링크를 만들었습니다. 이메일은 발송하지 않았습니다.'
          : '초대를 취소했습니다.',
      );
    } catch (e) {
      setMessage((e as Error).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-panel project-agreement">
      <span className="eyebrow">
        {state.details.legacy ? '기존 샘플 프로젝트' : '팀이 합의한 목표'}
      </span>
      <h2>{state.details.goal}</h2>
      <ul>
        {JSON.parse(state.details.deliverables).map((v: string) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
      <p>
        <b>완료 기준</b> {state.details.completion_criteria}
      </p>
      {!state.sprint.tasks.length && (
        <p>
          프로젝트 생성이 완료됐습니다. 실행 계획에서 업무와 담당자를 등록하고,
          팀 · 가용시간에서 날짜별 작업 시간을 입력해주세요.
        </p>
      )}
      <details>
        <summary>
          팀원 {state.members.length}/4 ·{' '}
          {state.me.role === 'owner' ? '초대 관리' : '참여 현황'}
        </summary>
        <ul>
          {state.members.map((m) => (
            <li key={m.person}>
              {m.display_name} · {m.role === 'owner' ? '팀장' : '팀원'} ·{' '}
              {m.agreed_at ? '목표 확인 완료' : '참여 조건 확인 전'}
            </li>
          ))}
        </ul>
        <p>
          팀장은 초대와 최종 승인을 관리합니다. 팀원은 본인의 업무와 가용시간을
          변경할 수 있습니다.
        </p>
        {state.me.role === 'owner' && (
          <>
            <form
              className="project-form"
              onSubmit={(e) => {
                e.preventDefault();
                void runAction('invite', { email });
              }}
            >
              <label>
                팀원의 ChatGPT 로그인 이메일
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                />
              </label>
              <button
                className="btn primary"
                disabled={busy || state.sprint.finished}
              >
                초대 링크 만들기
              </button>
            </form>
            <p>
              초대 링크는 지정된 이메일로만 수락할 수 있으며 7일 뒤 만료됩니다.
              현재 비공개 파일럿은 사이트 접근 권한도 별도로 필요합니다.
            </p>
            {link && (
              <label className="project-form">
                새 초대 링크
                <input
                  aria-label="새 초대 링크"
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setMessage('링크를 복사했습니다.');
                    } catch {
                      setMessage('링크를 선택해서 복사해주세요.');
                    }
                  }}
                >
                  링크 복사
                </button>
              </label>
            )}
            <ul>
              {state.invites.map((i) => (
                <li key={i.id}>
                  {i.email} ·{' '}
                  {i.status === 'pending'
                    ? Date.parse(i.expires_at) > Date.parse(state.asOf)
                      ? '대기'
                      : '만료'
                    : i.status === 'accepted'
                      ? '수락 완료'
                      : '취소'}{' '}
                  · 만료{' '}
                  {new Date(i.expires_at).toLocaleString('ko-KR', {
                    timeZone: 'Asia/Seoul',
                  })}{' '}
                  {i.status === 'pending' && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        setLink('');
                        void runAction('revoke', { inviteId: i.id });
                      }}
                    >
                      취소
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {message && <output>{message}</output>}
      </details>
    </section>
  );
}
