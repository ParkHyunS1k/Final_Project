'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import {
  ArrowRight,
  House,
  Layers3,
  FolderKanban,
  BriefcaseBusiness,
  UserRound,
  Flame,
  Sparkles,
  Check,
  Users,
  Trophy,
  LogOut,
  FileText,
} from 'lucide-react';
import { TeamDirectory } from './team-directory';
import { ProjectCreate } from './project-create';
import { CareerWorkspace } from './career-workspace';
import { PendingReviewGate } from './peer-review';
import ProjectDashboard from './project-dashboard';
import { ThemeToggle } from './theme-toggle';
import { apiFetch, signInWithGoogle, signOut } from '@/lib/supabase-browser';
import {
  TEMPLATES,
  TARGETS,
  SKILLS,
  skillName,
  scopedTemplate,
  SCOPE_LABELS,
  type SkillId,
} from '@/lib/career/catalog';
import type { readHub } from '@/lib/hub';
import type { Wire } from '@/lib/wire';
import type { JoobleJob, JoobleSearchResult } from '@/lib/jooble';

type Hub = Wire<Awaited<ReturnType<typeof readHub>>>;
type Tab =
  | 'home'
  | 'teams'
  | 'create'
  | 'templates'
  | 'work'
  | 'jobs'
  | 'profile'
  | 'portfolio'
  | 'experience'
  | 'team';
const TITLES: Record<Tab, string> = {
  home: '홈',
  teams: '팀 찾기',
  create: '직접 프로젝트 만들기',
  templates: '프로젝트 찾기',
  work: '내 프로젝트',
  jobs: '공고 찾기',
  profile: '이력서·역량',
  portfolio: '포트폴리오',
  experience: '경험·성장 기록',
  team: '팀 역할 추천',
};
const MAIN_NAV = [
  { id: 'home', icon: House },
  { id: 'templates', icon: Layers3 },
  { id: 'teams', icon: Users },
  { id: 'work', icon: FolderKanban },
  { id: 'jobs', icon: BriefcaseBusiness },
  { id: 'profile', icon: UserRound },
] as const;
const PERSONAL: Tab[] = ['profile', 'portfolio', 'experience'];
function tabFrom(value: string): Tab {
  return Object.hasOwn(TITLES, value) ? (value as Tab) : 'home';
}
async function request<T>(
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch('/api/hub', {
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}
function Chips({ skills }: { skills: readonly string[] }) {
  return (
    <div className="hub-chips">
      {skills.map((s) => (
        <span key={s}>{skillName(s)}</span>
      ))}
    </div>
  );
}
function ProjectTime({
  start,
  end,
}: {
  start: string | null;
  end: string | null;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  if (!start || !end)
    return (
      <p className="hub-note">준비 중 · 시작하기를 누르면 7일이 흘러가요.</p>
    );
  const remaining = Math.max(0, Date.parse(end) - (now ?? Date.parse(start)));
  const progress = Math.min(
    100,
    Math.max(0, 100 * (1 - remaining / (Date.parse(end) - Date.parse(start)))),
  );
  return (
    <div className="hub-time">
      <div>
        <span>7일의 여정</span>
        <b>
          {now === null
            ? '시간 확인 중'
            : remaining > 0
              ? `${Math.floor(remaining / 86400000)}일 ${Math.floor(remaining / 3600000) % 24}시간 남음`
              : '기간 종료'}
        </b>
      </div>
      <progress
        className="hub-track"
        aria-label="진행 기간"
        value={progress}
        max={100}
      />
    </div>
  );
}

export function UnifiedApp({
  initialTab,
  projectId,
}: {
  initialTab: string;
  projectId: string;
}) {
  const [tab, setTab] = useState<Tab>(tabFrom(initialTab));
  const [selectedProject, setSelectedProject] = useState(projectId);
  const [data, setData] = useState<Hub | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState('');
  const [evidence, setEvidence] = useState('');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState('');
  const [level, setLevel] = useState(1);
  const [mode, setMode] = useState<'solo' | 'team'>('solo');
  const [listed, setListed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [learning, setLearning] = useState<SkillId[]>([]);
  const [recordKind, setRecordKind] = useState<'portfolio' | 'job'>(
    'portfolio',
  );
  const [record, setRecord] = useState<{
    id: string;
    revision?: number;
    title: string;
    url: string;
    text: string;
  }>({
    id: '',
    title: '',
    url: '',
    text: '',
  });
  const [jobRole, setJobRole] = useState(TARGETS[0].id);
  const [jobKeywords, setJobKeywords] = useState(TARGETS[0].name);
  const [jobLocation, setJobLocation] = useState('대한민국');
  const [jobResults, setJobResults] = useState<JoobleSearchResult | null>(null);
  const [jobSearchBusy, setJobSearchBusy] = useState(false);
  const [jobSearchError, setJobSearchError] = useState('');
  const refresh = useCallback(async () => setData(await request<Hub>()), []);
  useEffect(() => {
    const controller = new AbortController();
    request<Hub>(undefined, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    const back = () => {
      const q = new URLSearchParams(location.search);
      setTab(tabFrom(q.get('tab') || 'home'));
      setSelectedProject(q.get('project') || '');
    };
    addEventListener('popstate', back);
    return () => {
      controller.abort();
      removeEventListener('popstate', back);
    };
  }, []);
  function navigate(next: Tab, id = '') {
    if (next !== 'profile') {
      setPosting('');
      setEvidence('');
    }
    if ((next === 'work' || next === 'team') && !id)
      id =
        data?.projects.find((p) => p.lifecycle === 'active')?.id ||
        data?.projects.find((p) => p.lifecycle === 'draft')?.id ||
        data?.projects[0]?.id ||
        '';
    setTab(next);
    setSelectedProject(id);
    setNotice('');
    const params = new URLSearchParams({ tab: next });
    if (id) params.set('project', id);
    history.pushState(null, '', '/app?' + params.toString());
    window.scrollTo({ top: 0, behavior: 'instant' });
    void refresh().catch((e) => setError(e.message));
  }
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveRecord(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    await act(async () => {
      await request({ action: 'saveRecord', kind: recordKind, ...record });
      await refresh();
      setRecord({ id: '', title: '', url: '', text: '' });
      setNotice('나만 볼 수 있는 자료함에 저장했습니다.');
    });
  }
  async function searchJobs(page = 1) {
    setJobSearchBusy(true);
    setJobSearchError('');
    try {
      const params = new URLSearchParams({
        keywords: jobKeywords.trim(),
        location: jobLocation.trim() || '대한민국',
        page: String(page),
        resultOnPage: '10',
      });
      const response = await apiFetch('/api/jobs?' + params.toString());
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || '공고를 불러오지 못했습니다.');
      setJobResults(result as JoobleSearchResult);
    } catch (e) {
      setJobSearchError((e as Error).message);
      setJobResults(null);
    } finally {
      setJobSearchBusy(false);
    }
  }
  function prepareJobSave(job: JoobleJob) {
    const details = [
      job.snippet,
      job.location && `근무지: ${job.location}`,
      job.type && `고용형태: ${job.type}`,
      job.salary && `급여: ${job.salary}`,
      job.source && `출처: ${job.source}`,
    ]
      .filter(Boolean)
      .join('\n');
    setRecordKind('job');
    setRecord({
      id: crypto.randomUUID(),
      title: [job.company, job.title].filter(Boolean).join(' · '),
      url: job.link,
      text: details,
    });
    setNotice(
      '공고 정보를 저장 폼에 담았습니다. 원문에서 필수 역량을 확인한 뒤 저장하세요.',
    );
  }
  const selected = TEMPLATES.find((t) => t.id === chosen);
  const scoped = selected ? scopedTemplate(selected, level) : null;
  const templates = (
    data?.recommendations.length
      ? data.recommendations.map((r) => r.template)
      : TEMPLATES
  ).filter(
    (t) =>
      !filter ||
      t.tasks.some((task) => task.skills.includes(filter as SkillId)),
  );
  const missing = data?.gaps.filter((g) => g.status !== 'matched') ?? [];
  const jobs = data?.records.filter((r) => r.kind === 'job') ?? [];
  const portfolios = data?.records.filter((r) => r.kind === 'portfolio') ?? [];
  const recordForm = (kind: 'portfolio' | 'job') => (
    <form className="hub-card hub-record-form" onSubmit={saveRecord}>
      <h2>{kind === 'job' ? '관심 공고 저장' : '포트폴리오 추가'}</h2>
      <p className="hub-note">
        {kind === 'job'
          ? '공고 원문을 저장하면 목표 역량 분석에 바로 사용할 수 있어요.'
          : '링크와 본문을 함께 보관하세요. 링크만으로 저장소를 자동 분석하지는 않습니다.'}
      </p>
      {kind === 'portfolio' && (
        <label className="hub-upload">
          PDF·텍스트 불러오기{' '}
          <input
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void act(async () => {
                  const { resumeFileText } = await import('@/lib/career/pdf');
                  const text = await resumeFileText(file);
                  if (text.length > 20000)
                    throw new Error(
                      '포트폴리오 본문은 20,000자 이하로 줄여주세요.',
                    );
                  setRecord((r) => ({
                    ...r,
                    title: r.title || file.name,
                    text,
                  }));
                });
              e.target.value = '';
            }}
          />
          <small>
            원본은 브라우저에서 추출 · 저장 시 본문만 내 자료함에 보관
          </small>
        </label>
      )}
      <label>
        제목
        <input
          required
          maxLength={100}
          value={record.title}
          onChange={(e) => setRecord((r) => ({ ...r, title: e.target.value }))}
          placeholder={kind === 'job' ? '회사명 · 지원 직무' : '프로젝트 이름'}
        />
      </label>
      <label>
        {kind === 'job' ? '공고 주소' : 'GitHub·배포·포트폴리오 주소'}{' '}
        <small>(선택)</small>
        <input
          type="url"
          pattern="https://.*"
          maxLength={2000}
          value={record.url}
          onChange={(e) => setRecord((r) => ({ ...r, url: e.target.value }))}
          placeholder="https://"
        />
      </label>
      <label>
        {kind === 'job'
          ? '공고의 업무·필수·우대 역량'
          : '나의 기여·구현 내용·검증 결과'}
        <textarea
          rows={6}
          maxLength={20000}
          value={record.text}
          onChange={(e) => setRecord((r) => ({ ...r, text: e.target.value }))}
        />
      </label>
      <div className="hub-actions">
        <button className="btn primary" disabled={busy || !data}>
          저장하기
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setRecord((r) => ({ ...r, id: '' }))}
        >
          닫기
        </button>
      </div>
    </form>
  );
  function newRecord(kind: 'portfolio' | 'job') {
    setRecordKind(kind);
    setRecord({ id: crypto.randomUUID(), title: '', url: '', text: '' });
  }
  return (
    <div className="hub-shell">
      <aside className="hub-sidebar">
        <Link href="/" className="hub-brand">
          <span>p.</span> projectmate
        </Link>
        <p className="hub-tagline">나의 다음 경험을 만드는 곳</p>
        <nav aria-label="주 메뉴">
          {MAIN_NAV.map((item) => (
            <button
              key={item.id}
              className={
                tab === item.id ||
                (item.id === 'profile' && PERSONAL.includes(tab)) ||
                (item.id === 'work' && tab === 'team')
                  ? 'active'
                  : ''
              }
              aria-current={
                tab === item.id ||
                (item.id === 'profile' && PERSONAL.includes(tab))
                  ? 'page'
                  : undefined
              }
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              {item.id === 'profile' ? '마이페이지' : TITLES[item.id]}
            </button>
          ))}
        </nav>
        <div className="hub-sidebar-note">
          <Sparkles size={20} />
          <b>혼자여도 괜찮아요.</b>
          <p>
            작게 시작한 프로젝트가
            <br />
            다음 기회의 근거가 되도록.
          </p>
          <button onClick={() => navigate('templates')}>
            템플릿 둘러보기 <ArrowRight size={14} />
          </button>
          <button onClick={() => navigate('create')}>
            직접 만들어보기 <ArrowRight size={14} />
          </button>
        </div>
        <div className="hub-sidebar-bottom">
          <ThemeToggle />
          <button
            className="btn"
            onClick={() => void act(signOut)}
            aria-label="로그아웃"
          >
            <LogOut size={16} />
          </button>
          <Link href="/">서비스 소개</Link>
        </div>
      </aside>
      <div className="hub-body">
        <header className="hub-topbar">
          <div>
            <span>나의 성장 공간</span>
            <b>{PERSONAL.includes(tab) ? '마이페이지' : TITLES[tab]}</b>
          </div>
          <button className="hub-user" onClick={() => navigate('profile')}>
            <span>{data?.name.slice(0, 1) || <UserRound size={17} />}</span>
            {data?.name || '마이페이지'}
          </button>
        </header>
        <main className={'hub-main' + (tab === 'work' ? ' hub-main-work' : '')}>
          {error && (
            <div className="hub-alert" role="alert">
              <p>{error}</p>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act(
                    error.includes('로그인') ? signInWithGoogle : refresh,
                  )
                }
              >
                {error.includes('로그인') ? 'Google로 로그인' : '다시 불러오기'}
              </button>
            </div>
          )}
          {notice && <output className="hub-notice">{notice}</output>}
          {PERSONAL.includes(tab) && (
            <>
              <div className="hub-heading">
                <div>
                  <p className="hub-eyebrow">MY GROWTH</p>
                  <h1>경험을 한 곳에, 다음 기회까지.</h1>
                </div>
                <button className="btn" onClick={() => navigate('jobs')}>
                  관심 공고 {jobs.length}개 <ArrowRight size={16} />
                </button>
              </div>
              <nav className="hub-tabs" aria-label="마이페이지 메뉴">
                {PERSONAL.map((p) => (
                  <button
                    key={p}
                    className={tab === p ? 'active' : ''}
                    aria-current={tab === p ? 'page' : undefined}
                    onClick={() => navigate(p)}
                  >
                    {TITLES[p]}
                  </button>
                ))}
              </nav>
            </>
          )}
          {tab === 'teams' && <TeamDirectory />}
          {tab === 'create' && (
            <ProjectCreate
              onSubmit={async (body) => {
                setError('');
                try {
                  const response = await apiFetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  const result = await response.json();
                  if (!response.ok)
                    throw new Error(
                      result.error || '프로젝트를 만들지 못했습니다.',
                    );
                  navigate('work', result.projectId);
                  return true;
                } catch (e) {
                  setError((e as Error).message);
                  return false;
                }
              }}
            />
          )}
          {tab === 'home' && (
            <>
              {data?.invitations.map((invite) => (
                <section className="hub-card hub-info" key={invite.project_id}>
                  <Users size={23} />
                  <div>
                    <h2>{invite.title}에서 초대가 왔어요.</h2>
                    <p>목표와 범위를 확인하고 참여 여부를 결정하세요.</p>
                  </div>
                  <Link
                    className="btn primary"
                    href={
                      '/app?tab=work&invite=' + encodeURIComponent(invite.token)
                    }
                  >
                    초대 확인하기
                  </Link>
                </section>
              ))}
              <section className="hub-hero">
                <div>
                  <p className="hub-eyebrow">YOUR NEXT EXPERIENCE</p>
                  <h1>
                    오늘의 작은 도전이,
                    <br />
                    내일의 나를 바꾸니까.
                  </h1>
                  <p>
                    이력서와 포트폴리오에서 발견한 다음 경험.
                    <br />
                    나에게 맞는 프로젝트로 채워보세요.
                  </p>
                  <button
                    className="btn primary"
                    onClick={() => navigate('templates')}
                  >
                    내 프로젝트 찾기 <ArrowRight size={17} />
                  </button>
                </div>
                <div className="hub-orbit" aria-hidden="true">
                  <span>LEARN</span>
                  <b>
                    한 걸음
                    <br />
                    <em>더, 나답게.</em>
                  </b>
                  <span>BUILD · GROW</span>
                </div>
              </section>
              <div className="hub-home-grid">
                <div>
                  <div className="hub-heading">
                    <div>
                      <h2>함께 달리고 있는 팀</h2>
                      <p>진행 중인 팀과 새 멤버를 기다리는 팀이에요.</p>
                    </div>
                    <span className="hub-pill">
                      공개 모집 {data?.directory.length ?? 0}
                    </span>
                  </div>
                  {!data && !error ? (
                    <output className="hub-empty">
                      팀 목록을 불러오는 중입니다.
                    </output>
                  ) : !data?.directory.length ? (
                    <div className="hub-empty">
                      <Users size={29} />
                      <h3>아직 공개 모집 중인 팀이 없어요.</h3>
                      <p>
                        팀을 기다리는 동안 혼자 시작해도 좋아요.
                        <br />
                        모집 공개를 선택한 실제 프로젝트만 이곳에 나타납니다.
                      </p>
                      <button
                        className="btn"
                        onClick={() => navigate('templates')}
                      >
                        템플릿으로 시작하기
                      </button>
                    </div>
                  ) : (
                    <div className="hub-grid">
                      {data.directory.map((team) => (
                        <article className="hub-card" key={team.project_id}>
                          <div className="hub-card-top">
                            <span className="hub-live">
                              {team.lifecycle === 'active'
                                ? '진행 중'
                                : '멤버 모집'}
                            </span>
                            <span>{team.members}/4명</span>
                          </div>
                          <h3>{team.title}</h3>
                          <p>{team.template?.goal || team.goal}</p>
                          <Chips
                            skills={[
                              ...new Set(
                                team.template?.tasks.flatMap((t) => t.skills) ??
                                  [],
                              ),
                            ].slice(0, 4)}
                          />
                          <ProjectTime
                            start={team.started_at}
                            end={team.deadline_at}
                          />
                          {team.joined ? (
                            <button
                              className="btn wide"
                              onClick={() => navigate('work', team.project_id)}
                            >
                              프로젝트 열기
                            </button>
                          ) : !team.template ? (
                            <button
                              className="btn wide"
                              onClick={() => navigate('teams')}
                            >
                              참여 조건 확인하고 신청
                            </button>
                          ) : (
                            <>
                              <button
                                className="btn wide"
                                disabled={
                                  busy || team.interested || team.members >= 4
                                }
                                onClick={() =>
                                  void act(async () => {
                                    await request({
                                      action: 'interest',
                                      projectId: team.project_id,
                                      consent: true,
                                    });
                                    await refresh();
                                    setNotice(
                                      '관심을 전달했습니다. 실제 팀 참여는 팀장의 초대와 목표 동의 후 확정됩니다.',
                                    );
                                  })
                                }
                              >
                                {team.interested
                                  ? '관심 전달됨 · 초대 대기'
                                  : team.members >= 4
                                    ? '모집 마감'
                                    : '연락처 공유하고 참여 요청'}
                              </button>
                              <small className="hub-note">
                                팀장에게 이름과 로그인 이메일을 전달해요.
                                이력서는 공개되지 않아요.
                              </small>
                            </>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                  <div className="hub-heading">
                    <div>
                      <h2>이어서 할 나의 프로젝트</h2>
                      <p>혼자 시작했든 함께 시작했든, 같은 공간에서.</p>
                    </div>
                    <button
                      className="hub-text-button"
                      onClick={() => navigate('work')}
                    >
                      전체 보기 <ArrowRight size={14} />
                    </button>
                  </div>
                  {!data?.projects.length ? (
                    <div className="hub-card">
                      <p>첫 프로젝트를 고르면 할 일이 자동으로 준비돼요.</p>
                      <button
                        className="btn"
                        onClick={() => navigate('templates')}
                      >
                        20개 템플릿 살펴보기
                      </button>
                    </div>
                  ) : (
                    data.projects.slice(0, 4).map((p) => (
                      <article className="hub-card hub-project-row" key={p.id}>
                        <div>
                          <span className="hub-note">
                            {
                              {
                                active: '진행 중',
                                draft: '준비 중',
                                completed: '완료',
                                expired: '기간 종료',
                                legacy: '이전 기록',
                              }[p.lifecycle]
                            }
                          </span>
                          <h3>{p.title}</h3>
                          <ProjectTime
                            start={p.started_at}
                            end={p.deadline_at}
                          />
                        </div>
                        <button
                          className="btn"
                          onClick={() => navigate('work', p.id)}
                        >
                          이어 하기 <ArrowRight size={16} />
                        </button>
                      </article>
                    ))
                  )}
                </div>
                <aside className="hub-home-side">
                  <section className="hub-card">
                    <p className="hub-eyebrow">
                      <Flame size={15} /> DAILY CHECK-IN
                    </p>
                    <h2>오늘, 어떻게 보내셨나요?</h2>
                    <p>
                      잘 된 날도 막힌 날도 기록해요.
                      <br />
                      학습 여부는 본인 기록이며 자동 검증은 아니에요.
                    </p>
                    <div className="hub-checkin-skills">
                      {SKILLS.filter((s) =>
                        [
                          'python',
                          'react',
                          'sql',
                          'api',
                          'design',
                          'testing',
                          'docker',
                        ].includes(s.id),
                      ).map((s) => (
                        <button
                          className={learning.includes(s.id) ? 'selected' : ''}
                          aria-pressed={learning.includes(s.id)}
                          key={s.id}
                          onClick={() =>
                            setLearning((v) =>
                              v.includes(s.id)
                                ? v.filter((i) => i !== s.id)
                                : [...v, s.id],
                            )
                          }
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                    <div className="hub-checkin">
                      {[
                        ['studied', '공부했어요'],
                        ['stuck', '막혔어요'],
                        ['rest', '쉬어갈게요'],
                      ].map(([status, label]) => (
                        <button
                          key={status}
                          className={
                            data?.stats.today === status ? 'selected' : ''
                          }
                          aria-pressed={data?.stats.today === status}
                          disabled={busy || !data}
                          onClick={() =>
                            void act(async () => {
                              await request({
                                action: 'checkin',
                                status,
                                skills: learning,
                              });
                              await refresh();
                              setNotice(
                                '오늘 기록을 저장했습니다. 같은 날 여러 번 눌러도 점수는 중복되지 않아요.',
                              );
                            })
                          }
                        >
                          {data?.stats.today === status && <Check size={14} />}
                          {label}
                        </button>
                      ))}
                    </div>
                    {data?.stats.today === 'stuck' && (
                      <button
                        className="hub-text-button"
                        onClick={() => navigate('templates')}
                      >
                        범위를 작게 잡을 프로젝트 찾아보기{' '}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </section>
                  <section className="hub-card hub-growth">
                    <p className="hub-eyebrow">
                      <Trophy size={15} /> MY MOMENTUM
                    </p>
                    <h2>학습 기록</h2>
                    <div className="hub-stat-row">
                      <div>
                        <b>
                          {data?.stats.streak ?? 0}
                          <small>일</small>
                        </b>
                        <span>연속 학습</span>
                      </div>
                      <div>
                        <b>
                          {data?.stats.days ?? 0}
                          <small>일</small>
                        </b>
                        <span>학습한 날</span>
                      </div>
                    </div>
                    <p className="hub-note">
                      ‘공부함’으로 체크인한 날을 셉니다.
                      <br />
                      등급·뱃지는 동료평가 결과로만 정해져요.
                    </p>
                    <button
                      className="btn wide"
                      disabled={!data}
                      onClick={() =>
                        void act(async () => {
                          await navigator.clipboard.writeText(
                            `ProjectMate에서 ${data!.stats.days}일 학습을 기록했어요.`,
                          );
                          setNotice(
                            '학습 기록 문구를 복사했습니다. 원하는 곳에 직접 공유해보세요.',
                          );
                        })
                      }
                    >
                      학습 기록 문구 복사
                    </button>
                  </section>
                  <section className="hub-card">
                    <h3>나에게 필요한 다음 경험</h3>
                    {data?.profile ? (
                      <>
                        <Chips
                          skills={missing.slice(0, 4).map((g) => g.skillId)}
                        />
                        <p>
                          {missing.length
                            ? '원문에서 충분한 근거가 확인되지 않은 역량이에요. 능력이 없다는 뜻은 아닙니다.'
                            : '목표 역량의 수행 근거를 확인했어요. 다른 목표도 살펴보세요.'}
                        </p>
                      </>
                    ) : (
                      <p>
                        이력서나 포트폴리오를 등록하면 내 경험을 기준으로
                        프로젝트를 추천해요.
                      </p>
                    )}
                    <button
                      className="hub-text-button"
                      onClick={() => navigate('profile')}
                    >
                      나의 역량 살펴보기 <ArrowRight size={14} />
                    </button>
                  </section>
                </aside>
              </div>
            </>
          )}
          {tab === 'templates' && (
            <>
              <div className="hub-heading">
                <div>
                  <p className="hub-eyebrow">PICK YOUR NEXT PROJECT</p>
                  <h1>고르고, 크기를 맞추고, 시작하세요.</h1>
                  <p>
                    랜덤 생성 대신 검토된 학습 템플릿 20개. 이름과 할 일을 직접
                    쓰지 않아도 돼요.
                  </p>
                </div>
              </div>
              <div className="hub-filter">
                <button
                  className={!filter ? 'selected' : ''}
                  onClick={() => setFilter('')}
                >
                  전체 20
                </button>
                {SKILLS.map((s) => (
                  <button
                    key={s.id}
                    className={filter === s.id ? 'selected' : ''}
                    aria-pressed={filter === s.id}
                    onClick={() => setFilter(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <p className="hub-note">
                {data?.profile
                  ? '내 수행 근거와 보완할 역량을 기준으로 추천 순서를 정했어요. 슬라이더를 줄이면 포함되는 역량도 달라집니다.'
                  : '이력서 없이도 시작할 수 있어요. 등록 후에는 내 역량에 맞춰 추천 순서가 바뀝니다.'}
              </p>
              <div
                className={
                  'hub-template-layout' + (chosen ? ' has-selection' : '')
                }
              >
                <div className="hub-grid">
                  {templates.map((t, i) => {
                    const recommendation = data?.recommendations.find(
                      (r) => r.template.id === t.id,
                    );
                    return (
                      <article
                        key={t.id}
                        className={
                          'hub-card hub-template' +
                          (chosen === t.id ? ' selected-card' : '')
                        }
                      >
                        <div className="hub-card-top">
                          <span className="hub-template-number">
                            {String(
                              TEMPLATES.indexOf(t) >= 0
                                ? TEMPLATES.indexOf(t) + 1
                                : i + 1,
                            ).padStart(2, '0')}
                          </span>
                          <span className="hub-note">혼자 · 팀 모두 가능</span>
                        </div>
                        <h3>{t.title}</h3>
                        <p>{t.goal}</p>
                        <Chips
                          skills={[
                            ...new Set(t.tasks.flatMap((task) => task.skills)),
                          ].slice(0, 5)}
                        />
                        {recommendation?.growth.length ? (
                          <p className="hub-fit">
                            보완할 경험 ·{' '}
                            {recommendation.growth.map(skillName).join(', ')}
                          </p>
                        ) : null}
                        <button
                          className="btn wide"
                          onClick={() => {
                            setChosen(t.id);
                            setLevel(1);
                            setAgreed(false);
                            setRequestId(crypto.randomUUID());
                            setTimeout(
                              () =>
                                document
                                  .getElementById('hub-builder')
                                  ?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'nearest',
                                  }),
                              0,
                            );
                          }}
                        >
                          {chosen === t.id
                            ? '선택한 템플릿'
                            : '이 프로젝트 고르기'}{' '}
                          <ArrowRight size={15} />
                        </button>
                      </article>
                    );
                  })}
                </div>
                {scoped && (
                  <aside className="hub-card hub-builder" id="hub-builder">
                    <div className="hub-card-top">
                      <span className="hub-eyebrow">MAKE IT YOURS</span>
                      <button
                        className="hub-text-button"
                        onClick={() => setChosen('')}
                      >
                        닫기
                      </button>
                    </div>
                    <h2>{scoped.title}</h2>
                    <label className="hub-slider">
                      기능 범위 <b>{SCOPE_LABELS[level - 1]}</b>
                      <input
                        aria-label="기능 범위"
                        type="range"
                        min={1}
                        max={3}
                        step={1}
                        value={level}
                        onChange={(e) => {
                          setLevel(Number(e.target.value));
                          setAgreed(false);
                          setRequestId(crypto.randomUUID());
                        }}
                      />
                      <span>
                        핵심만 <span>검증까지</span> 확장까지
                      </span>
                    </label>
                    <p className="hub-note">
                      {scoped.tasks.length}개 할 일 · 예상{' '}
                      {scoped.tasks.reduce((n, t) => n + t.hours, 0)}시간
                      <br />
                      예상 공수는 전체 합계이며, 준비 기간은 7일에 포함되지
                      않아요.
                    </p>
                    <ol className="hub-task-preview">
                      {scoped.tasks.map((t) => (
                        <li key={t.key}>
                          <Check size={14} />
                          <span>
                            {t.title}
                            <small>
                              {t.hours}시간 ·{' '}
                              {t.skills.map(skillName).join(', ')}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ol>
                    <fieldset className="hub-mode">
                      <legend>어떻게 시작할까요?</legend>
                      {[
                        ['solo', '혼자 시작'],
                        ['team', '팀으로 시작'],
                      ].map(([value, label]) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="project-mode"
                            checked={mode === value}
                            onChange={() => {
                              setMode(value as 'solo' | 'team');
                              setRequestId(crypto.randomUUID());
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    {mode === 'team' && (
                      <label className="hub-check-label">
                        <input
                          type="checkbox"
                          checked={listed}
                          onChange={(e) => setListed(e.target.checked)}
                        />
                        팀 이름·템플릿·인원·진행 기간을 홈에 공개하고 모집하기
                      </label>
                    )}
                    <p className="hub-note">
                      혼자 먼저 출발하고 나중에 초대해도 돼요. 업무는 우선
                      나에게 배정되며 팀이 모이면 역할 추천에서 조정합니다.
                    </p>
                    <label className="hub-check-label">
                      <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                      />
                      목표와 선택한 범위를 확인했어요.
                    </label>
                    <button
                      className="btn primary wide"
                      disabled={busy || !agreed || !data}
                      onClick={() =>
                        void act(async () => {
                          const result = await request<{ projectId: string }>({
                            action: 'createTemplate',
                            templateId: scoped.id,
                            scopeLevel: level,
                            mode,
                            listed,
                            agreed,
                            requestId,
                          });
                          navigate('work', result.projectId);
                        })
                      }
                    >
                      {busy ? '준비 중…' : '이 계획으로 프로젝트 만들기'}
                    </button>
                    <p className="hub-note">
                      생성만으로 타이머가 시작되지 않습니다.
                      <br />
                      필수 결과물·완료 기준 입력은 없어요.
                    </p>
                  </aside>
                )}
              </div>
            </>
          )}
          {tab === 'work' && (
            <>
              <ProjectDashboard key={selectedProject} />
              {data?.settings.some(
                (s) => s.project_id === selectedProject && s.mode === 'team',
              ) && (
                <section className="hub-card">
                  <h2>홈에서 팀 모집하기</h2>
                  {data.settings
                    .filter((s) => s.project_id === selectedProject)
                    .map((s) => (
                      <label className="hub-check-label" key={s.project_id}>
                        <input
                          type="checkbox"
                          checked={s.listed}
                          disabled={busy}
                          onChange={(e) => {
                            const listed = e.target.checked;
                            void act(async () => {
                              await request({
                                action: 'listing',
                                projectId: s.project_id,
                                listed,
                                revision: data.projects.find(
                                  (p) => p.id === s.project_id,
                                )?.revision,
                              });
                              await refresh();
                            });
                          }}
                        />
                        프로젝트 이름·템플릿·인원·진행 기간 공개
                      </label>
                    ))}
                  <p>
                    참여 관심{' '}
                    {
                      data.interests.filter(
                        (i) => i.project_id === selectedProject,
                      ).length
                    }
                    명 · 초대를 보내면 상대방 홈에 초대가 도착해요. 이메일
                    발송은 서버 설정에 따릅니다.
                  </p>
                  {data.interests
                    .filter((i) => i.project_id === selectedProject)
                    .map((i, n) => (
                      <div className="hub-project-row" key={n}>
                        <p>
                          {i.display_name} · 관심 전달{' '}
                          {new Date(i.created_at).toLocaleDateString('ko-KR')}
                          <small className="hub-note">{i.email}</small>
                        </p>
                        <button
                          className="btn"
                          disabled={busy || !i.email}
                          onClick={() =>
                            void act(async () => {
                              const latest = await request<Hub>();
                              await request({
                                action: 'inviteInterested',
                                projectId: i.project_id,
                                userId: i.user_id,
                                revision: latest.projects.find(
                                  (p) => p.id === i.project_id,
                                )?.revision,
                              });
                              await refresh();
                              setNotice(
                                '홈에서 확인할 수 있는 초대를 전달했습니다. 팀 합류는 상대방의 목표 확인 후 확정됩니다.',
                              );
                            })
                          }
                        >
                          {i.invited ? '초대 상태 확인·재발급' : '초대 보내기'}
                        </button>
                      </div>
                    ))}
                </section>
              )}
            </>
          )}
          {(tab === 'profile' || tab === 'team' || tab === 'experience') && (
            <>
              {tab === 'profile' && (posting || evidence) && (
                <div className="hub-notice">
                  {posting ? '저장한 공고를' : '포트폴리오 본문을'} 입력란에
                  가져왔습니다. 내용을 확인한 뒤 분석·저장해주세요.
                </div>
              )}
              <CareerWorkspace
                key={tab + selectedProject + posting + evidence}
                embedded
                initialSection={tab}
                initialProject={selectedProject}
                prefillPosting={posting}
                prefillEvidence={evidence}
                onNavigate={(next) =>
                  navigate(
                    next === 'recommend' ? 'templates' : next,
                    next === 'team' ? selectedProject : '',
                  )
                }
              />
            </>
          )}
          {tab === 'portfolio' && (
            <>
              <section className="hub-card hub-info">
                <FileText size={27} />
                <div>
                  <h2>이력서 뒤의 실제 경험까지.</h2>
                  <p>
                    포트폴리오 본문과 기여 기록을 이력서 분석에 합칠 수 있어요.
                    GitHub 링크는 보관만 하며, 저장소 수집·코드 검증·AI 구술
                    평가는 아직 수행하지 않습니다.
                  </p>
                </div>
                <button
                  className="btn primary"
                  onClick={() => newRecord('portfolio')}
                >
                  자료 추가
                </button>
              </section>
              {record.id &&
                recordKind === 'portfolio' &&
                recordForm('portfolio')}
              <div className="hub-grid">
                {portfolios.map((p) => (
                  <article className="hub-card" key={p.id}>
                    <span className="hub-eyebrow">PRIVATE PORTFOLIO</span>
                    <h3>{p.payload.title}</h3>
                    <p className="hub-excerpt">
                      {p.payload.text ||
                        '본문을 추가하면 역량 분석에 함께 사용할 수 있어요.'}
                    </p>
                    {p.payload.url && (
                      <a
                        className="hub-text-button"
                        href={p.payload.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        원본 열기 ↗
                      </a>
                    )}
                    <div className="hub-actions">
                      <button
                        className="btn"
                        disabled={!p.payload.text}
                        onClick={() => {
                          setEvidence(
                            `[포트폴리오: ${p.payload.title}]\n${p.payload.text}`,
                          );
                          navigate('profile');
                        }}
                      >
                        이력서 분석에 합치기
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          setRecordKind('portfolio');
                          setRecord({
                            id: p.id,
                            revision: p.revision,
                            title: p.payload.title || '',
                            url: p.payload.url || '',
                            text: p.payload.text || '',
                          });
                        }}
                      >
                        수정
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!portfolios.length && (
                <p className="hub-empty">
                  프로젝트의 문제, 내가 한 일, 확인한 결과를 한 번만
                  정리해두세요.
                  <br />
                  역량 분석과 이력서 보완의 재료로 함께 사용할 수 있어요.
                </p>
              )}
            </>
          )}
          {tab === 'jobs' && (
            <>
              <div className="hub-heading">
                <div>
                  <p className="hub-eyebrow">FIND YOUR NEXT OPPORTUNITY</p>
                  <h1>가고 싶은 곳에서, 다음 경험을 찾으세요.</h1>
                  <p>
                    공고를 찾아 저장하고, 요구 역량을 내 경험과 비교해보세요.
                  </p>
                </div>
                <button
                  className="btn primary"
                  onClick={() => newRecord('job')}
                >
                  공고 저장하기
                </button>
              </div>
              <section className="hub-card">
                <h2>Jooble에서 공고를 검색해보세요.</h2>
                <p className="hub-note">
                  API 키는 서버에서만 사용하고, 결과에는 공고 요약과 원문 링크만
                  표시합니다.
                </p>
                <div className="hub-filter">
                  {TARGETS.map((t) => (
                    <button
                      className={jobRole === t.id ? 'selected' : ''}
                      aria-pressed={jobRole === t.id}
                      key={t.id}
                      onClick={() => {
                        setJobRole(t.id);
                        setJobKeywords(t.name);
                      }}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
                <form
                  className="hub-job-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchJobs();
                  }}
                >
                  <label>
                    직무·기술
                    <input
                      value={jobKeywords}
                      maxLength={120}
                      onChange={(event) => setJobKeywords(event.target.value)}
                      placeholder="예: 백엔드 Python 개발"
                    />
                  </label>
                  <label>
                    지역
                    <input
                      value={jobLocation}
                      maxLength={120}
                      onChange={(event) => setJobLocation(event.target.value)}
                      placeholder="예: 서울 또는 대한민국"
                    />
                  </label>
                  <button className="btn primary" disabled={jobSearchBusy}>
                    {jobSearchBusy ? '검색 중…' : '공고 검색'}
                  </button>
                </form>
                <div className="hub-actions">
                  <a
                    className="btn"
                    href={
                      'https://www.saramin.co.kr/zf_user/search?searchword=' +
                      encodeURIComponent(
                        TARGETS.find((t) => t.id === jobRole)!.name,
                      )
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    사람인에서 찾기 ↗
                  </a>
                  <a
                    className="btn"
                    href={
                      'https://www.jobkorea.co.kr/Search/?stext=' +
                      encodeURIComponent(
                        TARGETS.find((t) => t.id === jobRole)!.name,
                      )
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    잡코리아에서 찾기 ↗
                  </a>
                </div>
                {jobSearchError && (
                  <p className="hub-job-error" role="alert">
                    {jobSearchError}
                  </p>
                )}
              </section>
              {jobResults && (
                <section className="hub-job-results">
                  <div className="hub-heading">
                    <div>
                      <h2>
                        검색 결과{' '}
                        <span>{jobResults.totalCount.toLocaleString()}개</span>
                      </h2>
                      <p>
                        {jobResults.keywords} · {jobResults.location} · Jooble
                      </p>
                    </div>
                    <span className="hub-pill">{jobResults.page}페이지</span>
                  </div>
                  {jobResults.jobs.length ? (
                    <div className="hub-grid">
                      {jobResults.jobs.map((job) => (
                        <article className="hub-card" key={job.id + job.link}>
                          <div className="hub-card-top">
                            <span className="hub-live">공고 확인</span>
                            <span>{job.source || 'Jooble'}</span>
                          </div>
                          <h3>{job.title}</h3>
                          <p className="hub-job-company">
                            {job.company || '회사 정보 미기재'}
                          </p>
                          <p className="hub-excerpt">
                            {job.snippet ||
                              '공고 원문에서 상세 내용을 확인해주세요.'}
                          </p>
                          <div className="hub-chips">
                            {job.location && <span>{job.location}</span>}
                            {job.type && <span>{job.type}</span>}
                            {job.salary && <span>{job.salary}</span>}
                          </div>
                          <div className="hub-actions">
                            <a
                              className="btn"
                              href={job.link}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              원문 보기 ↗
                            </a>
                            <button
                              className="btn primary"
                              onClick={() => prepareJobSave(job)}
                            >
                              관심 공고로 저장
                            </button>
                          </div>
                          {job.updated && (
                            <small className="hub-note">
                              마지막 갱신 {job.updated}
                            </small>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="hub-empty">
                      <BriefcaseBusiness size={29} />
                      <h3>조건에 맞는 공고가 없어요.</h3>
                      <p>직무명이나 지역을 조금 넓혀 다시 검색해보세요.</p>
                    </div>
                  )}
                  {jobResults.totalCount > jobResults.resultOnPage && (
                    <div className="hub-actions hub-job-pagination">
                      <button
                        className="btn"
                        disabled={jobSearchBusy || jobResults.page <= 1}
                        onClick={() => void searchJobs(jobResults.page - 1)}
                      >
                        이전 결과
                      </button>
                      <button
                        className="btn"
                        disabled={
                          jobSearchBusy ||
                          jobResults.page >=
                            Math.min(
                              10,
                              Math.ceil(
                                jobResults.totalCount / jobResults.resultOnPage,
                              ),
                            )
                        }
                        onClick={() => void searchJobs(jobResults.page + 1)}
                      >
                        다음 결과
                      </button>
                    </div>
                  )}
                </section>
              )}
              {record.id && recordKind === 'job' && recordForm('job')}
              <div className="hub-heading">
                <h2>
                  저장한 관심 공고 <span>{jobs.length}</span>
                </h2>
              </div>
              <div className="hub-grid">
                {jobs.map((j) => (
                  <article className="hub-card" key={j.id}>
                    <BriefcaseBusiness size={21} />
                    <h3>{j.payload.title}</h3>
                    <p className="hub-excerpt">
                      {j.payload.text ||
                        '원문에서 요구 역량을 복사해 추가해주세요.'}
                    </p>
                    {j.payload.url && (
                      <a
                        className="hub-text-button"
                        href={j.payload.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        공고 원문 ↗
                      </a>
                    )}
                    <div className="hub-actions">
                      <button
                        className="btn primary"
                        disabled={!j.payload.text}
                        onClick={() => {
                          setPosting(j.payload.text || '');
                          navigate('profile');
                        }}
                      >
                        내 역량과 비교
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          setRecordKind('job');
                          setRecord({
                            id: j.id,
                            title: j.payload.title || '',
                            url: j.payload.url || '',
                            text: j.payload.text || '',
                          });
                        }}
                      >
                        수정
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!jobs.length && (
                <p className="hub-empty">
                  관심 있는 공고를 저장해보세요.
                  <br />
                  필요한 역량 → 추천 프로젝트 → 새로운 경험으로 이어집니다.
                </p>
              )}
            </>
          )}
        </main>
        <footer className="hub-footer">
          작게 시작하고, 경험으로 남기세요.{' '}
          <Link href="/">ProjectMate 소개</Link>
        </footer>
      </div>
      <PendingReviewGate />
    </div>
  );
}
