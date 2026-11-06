'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  FileText,
  Layers3,
  Users,
  Check,
  Upload,
  RefreshCw,
  Download,
  Sparkles,
} from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { apiFetch, signInWithGoogle } from '@/lib/supabase-browser';
import {
  SKILLS,
  ROLES,
  TARGETS,
  roleName,
  skillName,
  type SkillId,
  type ProjectTemplate,
} from '@/lib/career/catalog';
import type {
  Profile,
  ProfileInput,
  SkillEvidence,
  gapsFor,
  recommendations,
} from '@/lib/career/profile';
import type { Experience, teamState } from '@/lib/career/store';
import type { Wire } from '@/lib/wire';

type Personal = {
  profile: Profile | null;
  experiences: Wire<Experience>[];
  extraSkills: SkillEvidence[];
  gaps: ReturnType<typeof gapsFor>;
  beforeGaps: ReturnType<typeof gapsFor>;
  recommendations: ReturnType<typeof recommendations>;
  aiConfigured: boolean;
};
type Team = Wire<Omit<Awaited<ReturnType<typeof teamState>>, '_team'>>;
type Section = 'profile' | 'recommend' | 'team' | 'experience';
const SECTIONS = [
  { id: 'profile' as Section, title: '나의 역량', icon: FileText },
  { id: 'recommend' as Section, title: '프로젝트 추천', icon: Layers3 },
  { id: 'team' as Section, title: '팀 역할·과제', icon: Users },
  { id: 'experience' as Section, title: '경험 기록', icon: Check },
];
const EMPTY: ProfileInput = {
  resumeName: '나의 이력서',
  resumeText: '',
  targetRole: 'ai-engineer',
  targetPosting: '',
  learningGoals: [],
  preferredRoles: [],
  noExperience: [],
};
const LEVEL = {
  applied: '수행 근거',
  learning: '학습·실습',
  mentioned: '단순 언급',
};
const STATUS: Record<string, string> = {
  matched: '수행 근거 있음',
  partial: '경험 범위 확인',
  not_found: '이력서 근거 없음',
  no_experience: '미경험으로 확인',
};
async function request<T>(
  url: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch(url, {
    cache: 'no-store',
    signal,
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data as T;
}
function toggle<T>(items: T[], item: T) {
  return items.includes(item)
    ? items.filter((v) => v !== item)
    : [...items, item];
}
function Chips({ ids }: { ids: readonly string[] }) {
  return (
    <span className="cf-chips">
      {ids.map((id) => (
        <span className="cf-chip" key={id}>
          {skillName(id)}
        </span>
      ))}
    </span>
  );
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CareerWorkspace({
  embedded = false,
  initialSection = 'profile',
  initialProject = '',
  prefillPosting = '',
  prefillEvidence = '',
  onNavigate,
}: {
  embedded?: boolean;
  initialSection?: Section;
  initialProject?: string;
  prefillPosting?: string;
  prefillEvidence?: string;
  onNavigate?: (section: Section) => void;
}) {
  const [section, setLocalSection] = useState<Section>(initialSection);
  function setSection(next: Section) {
    if (embedded && onNavigate) onNavigate(next);
    else setLocalSection(next);
  }
  const [data, setData] = useState<Personal | null>(null);
  const [form, setForm] = useState<ProfileInput>(EMPTY);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<'basic' | 'ai'>('basic');
  const [consent, setConsent] = useState(false);
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [projectId, setProjectId] = useState(initialProject);
  const [team, setTeam] = useState<Team | null>(null);
  const [sharedSkills, setSharedSkills] = useState<SkillId[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<ProjectTemplate | null>(null);
  const [createKey, setCreateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [teamLoading, setTeamLoading] = useState(false);
  const prefillApplied = useRef(false);
  const hydrate = useCallback(
    (value: Personal) => {
      setData(value);
      if (prefillApplied.current) {
        if (value.profile) {
          setForm(value.profile);
          setVersion(value.profile.version);
        }
        return;
      }
      prefillApplied.current = true;
      if (value.profile) {
        setForm({
          ...value.profile,
          ...(prefillPosting ? { targetPosting: prefillPosting } : {}),
          ...(prefillEvidence &&
          !value.profile.resumeText.includes(prefillEvidence)
            ? {
                resumeText: value.profile.resumeText + '\n\n' + prefillEvidence,
              }
            : {}),
        });
        setVersion(value.profile.version);
      } else if (prefillPosting || prefillEvidence)
        setForm((f) => ({
          ...f,
          targetPosting: prefillPosting || f.targetPosting,
          resumeText: prefillEvidence || f.resumeText,
        }));
    },
    [prefillPosting, prefillEvidence],
  );
  const acceptTeam = useCallback((value: Team) => {
    setTeam(value);
    setSharedSkills(
      value.members
        .find((m) => m.person === value.me.person)
        ?.skills.map((s) => s.skillId) ?? [],
    );
    setAssignments(
      Object.fromEntries(
        (value.proposal?.payload.assignments ?? []).map((a) => [
          a.role,
          a.person === null ? '' : String(a.person),
        ]),
      ),
    );
  }, []);
  function chooseProject(id: string) {
    setProjectId(id);
    setTeam(null);
    setSharedSkills([]);
    setAssignments({});
    setTeamLoading(Boolean(id));
  }
  useEffect(() => {
    const c = new AbortController();
    const params = new URLSearchParams(location.search);
    Promise.all([
      request<Personal>('/api/career', undefined, c.signal),
      request<{ projects: { id: string; title: string }[] }>(
        '/api/projects',
        undefined,
        c.signal,
      ),
    ])
      .then(([personal, list]) => {
        if (c.signal.aborted) return;
        hydrate(personal);
        setMode(personal.aiConfigured ? 'ai' : 'basic');
        setProjects(list.projects);
        if (params.get('project')) {
          setProjectId(params.get('project')!);
          setTeamLoading(true);
          if (!embedded) setLocalSection('team');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [hydrate, embedded]);
  useEffect(() => {
    if (!projectId) return;
    const c = new AbortController();
    request<Team>(
      '/api/career?project=' + encodeURIComponent(projectId),
      undefined,
      c.signal,
    )
      .then((value) => {
        if (!c.signal.aborted) acceptTeam(value);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setTeamLoading(false);
      });
    return () => c.abort();
  }, [projectId, acceptTeam]);
  async function refreshTeam() {
    if (projectId)
      acceptTeam(
        await request<Team>(
          '/api/career?project=' + encodeURIComponent(projectId),
        ),
      );
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
  async function teamAction(
    action: string,
    fields: Record<string, unknown> = {},
  ) {
    await request('/api/career', {
      action,
      projectId,
      revision: team?.revision,
      ...fields,
    });
    await refreshTeam();
  }
  function update<K extends keyof ProfileInput>(
    key: K,
    value: ProfileInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  async function saveProfile(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    await act(async () => {
      await request('/api/career', {
        ...form,
        action: 'profile',
        version,
        mode,
        consent,
      });
      hydrate(await request<Personal>('/api/career'));
      setNotice(
        '근거와 추천을 저장했습니다. 프로젝트 추천에서 다음 경험을 골라보세요.',
      );
    });
  }
  const shareable = data
    ? [
        ...new Map(
          [
            ...(data.profile?.analysis.skills ?? []).filter(
              (s) => !data.profile!.noExperience.includes(s.skillId),
            ),
            ...data.extraSkills,
          ].map((s) => [s.skillId, s]),
        ).values(),
      ]
    : [];
  const me = team?.members.find((m) => m.person === team.me.person);
  const writable =
    team && ['draft', 'active'].includes(team.lifecycle) && team.me.agreed;
  const profile = data?.profile;
  const imported = data?.experiences.filter((e) => e.valid) ?? [];
  const Content = embedded ? 'section' : 'main';
  return (
    <div className={'cf-shell' + (embedded ? ' cf-embedded' : '')}>
      <header className="cf-header">
        <Link href="/" className="cf-brand">
          careerflow<span> × projectmate</span>
        </Link>
        <div className="cf-header-actions">
          <Link className="btn" href="/workspace">
            프로젝트 작업 공간 <ArrowRight size={15} />
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <Content className="cf-main">
        <div className="cf-intro">
          <div>
            <p className="eyebrow">YOUR NEXT EXPERIENCE</p>
            <h1>
              나의 경험에서,
              <br />
              다음 프로젝트로.
            </h1>
            <p>강점을 발견하고, 필요한 경험을 팀과 함께 만드세요.</p>
          </div>
          <div className="cf-journey">
            <span>이력서</span>
            <ArrowRight />
            <span>7일 프로젝트</span>
            <ArrowRight />
            <span>새로운 경험</span>
          </div>
        </div>
        <nav className="cf-nav" aria-label="커리어 성장 단계">
          {SECTIONS.map((s, i) => (
            <button
              key={s.id}
              className={section === s.id ? 'active' : ''}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => setSection(s.id)}
            >
              <s.icon size={18} />
              <span>
                <small>0{i + 1}</small>
                {s.title}
              </span>
            </button>
          ))}
        </nav>
        {error && (
          <div className="cf-message error" role="alert">
            <p>{error}</p>
            {error.includes('로그인') ? (
              <button
                className="btn primary"
                onClick={() =>
                  void act(async () => {
                    await signInWithGoogle();
                  })
                }
              >
                Google로 로그인
              </button>
            ) : (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    hydrate(await request<Personal>('/api/career'));
                    setProjects(
                      (
                        await request<{
                          projects: { id: string; title: string }[];
                        }>('/api/projects')
                      ).projects,
                    );
                    await refreshTeam();
                  })
                }
              >
                최신 상태 다시 불러오기
              </button>
            )}
          </div>
        )}
        {notice && <output className="cf-message success">{notice}</output>}
        {!data && !error && (
          <output className="cf-message">
            나의 커리어 정보를 불러오고 있어요…
          </output>
        )}
        {data && section === 'profile' && (
          <div className="cf-columns">
            <section className="cf-card">
              <div className="cf-card-heading">
                <div>
                  <p className="eyebrow">01 · PROFILE</p>
                  <h2>경험과 목표를 알려주세요</h2>
                </div>
                {profile && (
                  <span className="cf-chip">프로필 v{profile.version}</span>
                )}
              </div>
              <form onSubmit={saveProfile} className="cf-form">
                <fieldset disabled={busy}>
                  <label>
                    이력서 이름
                    <input
                      value={form.resumeName}
                      maxLength={80}
                      required
                      onChange={(e) => update('resumeName', e.target.value)}
                    />
                  </label>
                  <label className="cf-upload">
                    <Upload size={20} />
                    <span>
                      PDF·텍스트 파일 불러오기
                      <small>5MB 이하 · PDF 원본은 브라우저에서만 읽어요</small>
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.txt,application/pdf,text/plain"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void act(async () => {
                          const { resumeFileText } =
                            await import('@/lib/career/pdf');
                          const text = await resumeFileText(file);
                          update('resumeText', text);
                          setNotice(
                            '내용을 불러왔습니다. 추출 내용과 개인정보를 확인한 뒤 저장해주세요.',
                          );
                        });
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <label>
                    이력서·포트폴리오 내용
                    <textarea
                      rows={10}
                      minLength={30}
                      maxLength={40000}
                      required
                      value={form.resumeText}
                      placeholder="직접 했던 프로젝트, 맡은 업무, 사용한 기술과 결과를 적어주세요."
                      onChange={(e) => update('resumeText', e.target.value)}
                    />
                  </label>
                  <p className="cf-help">
                    원문과 분석은 내 계정에 저장됩니다. 팀에는 선택해서 공유한
                    역량만 전달됩니다.
                  </p>
                  <label>
                    목표 직무
                    <select
                      value={form.targetRole}
                      onChange={(e) => update('targetRole', e.target.value)}
                    >
                      <option value="">아직 탐색 중</option>
                      {TARGETS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    비교할 채용공고 <span className="muted">선택</span>
                    <textarea
                      rows={4}
                      maxLength={20000}
                      value={form.targetPosting}
                      onChange={(e) => update('targetPosting', e.target.value)}
                      placeholder="관심 공고의 자격요건·우대사항을 붙여넣어 주세요. 없으면 직무별 학습 참고 기준과 비교합니다."
                    />
                  </label>
                  <fieldset>
                    <legend>프로젝트에서 쌓고 싶은 경험</legend>
                    <div className="cf-choice-grid">
                      {SKILLS.map((s) => (
                        <label key={s.id}>
                          <input
                            type="checkbox"
                            checked={form.learningGoals.includes(s.id)}
                            onChange={() =>
                              update(
                                'learningGoals',
                                toggle(form.learningGoals, s.id),
                              )
                            }
                          />
                          {s.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>해보고 싶은 역할</legend>
                    <div className="cf-choice-grid">
                      {ROLES.map((r) => (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={form.preferredRoles.includes(r.id)}
                            onChange={() =>
                              update(
                                'preferredRoles',
                                toggle(form.preferredRoles, r.id),
                              )
                            }
                          />
                          {r.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <details>
                    <summary>아직 경험해보지 않은 역량 직접 표시</summary>
                    <p className="cf-help">
                      이력서에 없는 것과 실제 미경험을 구분하기 위한 선택
                      항목입니다.
                    </p>
                    <div className="cf-choice-grid">
                      {SKILLS.map((s) => (
                        <label key={s.id}>
                          <input
                            type="checkbox"
                            checked={form.noExperience.includes(s.id)}
                            onChange={() =>
                              update(
                                'noExperience',
                                toggle(form.noExperience, s.id),
                              )
                            }
                          />
                          {s.name}
                        </label>
                      ))}
                    </div>
                  </details>
                  <label>
                    분석 방식
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMode(e.target.value as 'ai' | 'basic')
                      }
                    >
                      <option value="basic">
                        기본 근거 추출 · 외부 AI 전송 없음
                      </option>
                      <option value="ai" disabled={!data.aiConfigured}>
                        AI 근거 분석
                        {!data.aiConfigured ? ' · 서버 설정 필요' : ''}
                      </option>
                    </select>
                  </label>
                  {mode === 'ai' && (
                    <label className="cf-agreement">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                        required
                      />
                      이력서와 목표 공고를 OpenAI 분석에 보내는 데 동의합니다.
                      개인정보를 먼저 확인했습니다.
                    </label>
                  )}
                  <button
                    className="btn primary wide"
                    disabled={busy || (mode === 'ai' && !consent)}
                  >
                    <Sparkles size={16} />
                    {busy
                      ? '근거를 확인하고 있어요…'
                      : '역량 분석하고 추천받기'}
                  </button>
                </fieldset>
              </form>
            </section>
            <div className="cf-stack">
              <section className="cf-card">
                <p className="eyebrow">EVIDENCE, NOT A SCORE</p>
                <h2>나의 역량 프로필</h2>
                {profile ? (
                  <>
                    <p>{profile.analysis.summary}</p>
                    <span className="cf-chip">
                      {profile.analysis.mode === 'ai'
                        ? 'AI 분석 · 원문 근거 확인'
                        : '기본 추출 · 키워드 기반'}
                    </span>
                    <div className="cf-evidence-list">
                      {profile.analysis.skills.map((s) => (
                        <article key={s.skillId}>
                          <div>
                            <strong>{skillName(s.skillId)}</strong>
                            <span className="cf-chip">{LEVEL[s.level]}</span>
                          </div>
                          <blockquote>{s.quote}</blockquote>
                          {profile.noExperience.includes(s.skillId) && (
                            <p className="cf-help">
                              본인이 미경험으로 표시해 추천의 강점에서는
                              제외했습니다.
                            </p>
                          )}
                        </article>
                      ))}
                      {!profile.analysis.skills.length && (
                        <p>
                          확인 가능한 근거를 찾지 못했습니다. 담당 업무와 기술을
                          구체적으로 적어주세요.
                        </p>
                      )}
                    </div>
                    {!!profile.analysis.questions.length && (
                      <div className="cf-callout">
                        <strong>추가로 확인하면 좋아요</strong>
                        <ul>
                          {profile.analysis.questions.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="cf-empty">
                    이력서를 저장하면 역량마다 어떤 문장에서 찾았는지
                    보여드려요.
                  </p>
                )}
              </section>
              <section className="cf-card">
                <h2>목표까지, 보완할 경험</h2>
                <p className="cf-help">
                  ‘근거 없음’은 능력이 없다는 뜻이 아닙니다. 실제 경험이 있다면
                  이력서에 추가해주세요.
                </p>
                {!!profile?.targetPosting && !data.gaps.length && (
                  <p>
                    이 공고에서 지원하는 역량 항목을 찾지 못했습니다. AI
                    분석이나 더 구체적인 공고 본문으로 다시 확인해주세요.
                  </p>
                )}
                <div className="cf-gap-list">
                  {data.gaps.map((g) => (
                    <article key={g.skillId}>
                      <div>
                        <strong>{skillName(g.skillId)}</strong>
                        <span
                          className={
                            g.status === 'matched'
                              ? 'cf-status good'
                              : 'cf-status'
                          }
                        >
                          {STATUS[g.status]}
                        </span>
                      </div>
                      <p>{g.quote}</p>
                    </article>
                  ))}
                </div>
                {profile && (
                  <button
                    className="btn primary wide"
                    onClick={() => setSection('recommend')}
                  >
                    프로젝트로 경험 쌓기 <ArrowRight size={16} />
                  </button>
                )}
              </section>
            </div>
          </div>
        )}
        {data && section === 'recommend' && (
          <section>
            <div className="cf-section-heading">
              <div>
                <p className="eyebrow">02 · NEXT PROJECT</p>
                <h2>기여하면서 성장하는 7일</h2>
                <p>
                  직접 설계한 학습 프로젝트입니다. 공개 모집 공고가 아니며,
                  선택하면 팀을 초대할 새 프로젝트를 만듭니다.
                </p>
              </div>
            </div>
            {!profile ? (
              <div className="cf-card cf-empty">
                먼저 이력서를 분석하면 나에게 맞는 프로젝트와 참여 역할을 볼 수
                있어요.
                <button className="btn" onClick={() => setSection('profile')}>
                  이력서 등록하기
                </button>
              </div>
            ) : (
              <div className="cf-project-grid">
                {data.recommendations.map((r, i) => (
                  <article
                    className="cf-card cf-project-card"
                    key={r.template.id}
                  >
                    <div className="cf-card-heading">
                      <span className="cf-chip">
                        {r.track === 'growth' ? '성장 도전형' : '강점 활용형'}
                      </span>
                      <span className="muted">0{i + 1} / 7 DAYS</span>
                    </div>
                    <h3>{r.template.title}</h3>
                    <p>{r.template.goal}</p>
                    <div>
                      <small>활용할 경험</small>
                      {r.strengths.length ? (
                        <Chips ids={r.strengths} />
                      ) : (
                        <p className="cf-help">
                          확인된 경험이 적어 사전 학습·팀 지원이 필요합니다.
                        </p>
                      )}
                    </div>
                    <div>
                      <small>보완할 경험</small>
                      {r.growth.length ? (
                        <Chips ids={r.growth} />
                      ) : (
                        <p className="cf-help">
                          기존 경험을 결과물로 더 구체화할 수 있어요.
                        </p>
                      )}
                    </div>
                    <div className="cf-callout">
                      <strong>
                        추천 참여 역할 · {roleName(r.recommendedRole.role)}
                      </strong>
                      <p>
                        {r.recommendedRole.growth.length
                          ? `해당 역할의 과제로 ${r.recommendedRole.growth.map(skillName).join(', ')} 경험을 다룰 수 있어요.`
                          : '팀 전체의 경험을 확인한 뒤 최종 역할을 함께 정합니다.'}
                      </p>
                    </div>
                    <button
                      className="btn primary wide"
                      onClick={() => {
                        setChosen(r.template);
                        setCreateKey(crypto.randomUUID());
                      }}
                    >
                      목표·과제 살펴보기 <ArrowRight size={16} />
                    </button>
                  </article>
                ))}
              </div>
            )}
            {chosen && (
              <section
                className="cf-card cf-preview"
                aria-label="프로젝트 생성 전 검토"
              >
                <div className="cf-card-heading">
                  <h2>{chosen.title}</h2>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => setChosen(null)}
                  >
                    닫기
                  </button>
                </div>
                <p>{chosen.goal}</p>
                <p>
                  <strong>범위</strong> · {chosen.scope}
                </p>
                <p>
                  <strong>완료 기준</strong> · {chosen.criteria}
                </p>
                <ul>
                  {chosen.deliverables.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
                <div className="cf-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>예상 과제</th>
                        <th>역할</th>
                        <th>초안 공수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chosen.tasks.map((t) => (
                        <tr key={t.key}>
                          <td>{t.title}</td>
                          <td>{roleName(t.role)}</td>
                          <td>{t.hours}시간</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="cf-help">
                  최소 2명이 목표에 동의한 뒤 팀장이 시작하면 7일이 시작됩니다.
                  업무는 팀 역할안을 검토한 후 등록합니다.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const result = await request<{ projectId: string }>(
                        '/api/career',
                        {
                          action: 'createProject',
                          templateId: chosen.id,
                          profileId: profile!.id,
                          requestId: createKey,
                          agreed: true,
                        },
                      );
                      location.assign(
                        '/career?project=' +
                          encodeURIComponent(result.projectId),
                      );
                    });
                  }}
                >
                  <label className="cf-agreement">
                    <input type="checkbox" required />
                    목표·범위·결과물·완료 기준을 확인했습니다. 시작 후 고정되는
                    내용을 이해합니다.
                  </label>
                  <button className="btn primary" disabled={busy}>
                    {busy ? '프로젝트 생성 중…' : '이 계획으로 프로젝트 만들기'}
                  </button>
                </form>
              </section>
            )}
          </section>
        )}
        {data && (section === 'team' || section === 'experience') && (
          <>
            <div className="cf-section-heading">
              <div>
                <p className="eyebrow">
                  {section === 'team'
                    ? '03 · TEAM & TASKS'
                    : '04 · EXPERIENCE LOOP'}
                </p>
                <h2>
                  {section === 'team'
                    ? '각자의 강점을, 팀의 실행으로'
                    : '함께 만든 결과를 나의 경험으로'}
                </h2>
              </div>
              <label className="cf-project-select">
                프로젝트
                <select
                  value={projectId}
                  disabled={busy}
                  onChange={(e) => {
                    chooseProject(e.target.value);
                    history.replaceState(
                      null,
                      '',
                      (embedded ? '/app?tab=' + section : '/career') +
                        (e.target.value
                          ? (embedded ? '&project=' : '?project=') +
                            encodeURIComponent(e.target.value)
                          : ''),
                    );
                  }}
                >
                  <option value="">프로젝트 선택</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!projectId && (
              <div className="cf-card cf-empty">
                <p>
                  프로젝트를 선택하거나 추천에서 새 프로젝트를 만들어주세요.
                </p>
                <button className="btn" onClick={() => setSection('recommend')}>
                  프로젝트 추천 보기
                </button>
              </div>
            )}
            {teamLoading && <output>팀 정보를 불러오고 있어요…</output>}
            {team && (
              <div className="cf-team-toolbar">
                <Link
                  className="btn"
                  href={
                    '/workspace?project=' +
                    encodeURIComponent(projectId) +
                    '&view=project'
                  }
                >
                  팀원 초대·목표 합의 <ArrowRight size={15} />
                </Link>
                <Link
                  className="btn"
                  href={
                    '/workspace?project=' +
                    encodeURIComponent(projectId) +
                    '&view=tasks'
                  }
                >
                  업무 진행·완료 근거 기록 <ArrowRight size={15} />
                </Link>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(refreshTeam)}
                >
                  <RefreshCw size={14} />
                  최신 상태
                </button>
              </div>
            )}
            {team && section === 'team' && (
              <div className="cf-columns">
                <div className="cf-stack">
                  <section className="cf-card">
                    <h3>이 팀에 공유할 나의 역량</h3>
                    <p>
                      선택한 역량과 경험 구분, 저장한 성장 목표·희망 역할을
                      공유합니다. 이력서 원문과 공고 본문은 팀에 공개하지
                      않습니다.
                    </p>
                    {profile ? (
                      <>
                        <div className="cf-choice-grid">
                          {shareable.map((s) => (
                            <label key={s.skillId}>
                              <input
                                type="checkbox"
                                disabled={busy || !writable}
                                checked={sharedSkills.includes(s.skillId)}
                                onChange={() =>
                                  setSharedSkills(
                                    toggle(sharedSkills, s.skillId),
                                  )
                                }
                              />
                              {skillName(s.skillId)} · {LEVEL[s.level]}
                            </label>
                          ))}
                        </div>
                        <p className="cf-help">
                          성장 목표:{' '}
                          {profile.learningGoals.map(skillName).join(', ') ||
                            '없음'}
                          <br />
                          희망 역할:{' '}
                          {profile.preferredRoles.map(roleName).join(', ') ||
                            '없음'}
                        </p>
                        <button
                          className="btn primary"
                          disabled={busy || !writable}
                          onClick={() =>
                            void act(async () => {
                              await teamAction('share', {
                                profileId: profile.id,
                                skillIds: sharedSkills,
                              });
                              setNotice(
                                '선택한 역량과 희망을 이 팀에 공유했습니다.',
                              );
                            })
                          }
                        >
                          {me?.profileId
                            ? '선택한 내용으로 공유 갱신'
                            : '선택한 내용 공유하기'}
                        </button>
                        {me?.profileId && (
                          <button
                            className="btn"
                            disabled={busy || !writable}
                            onClick={() =>
                              void act(async () => {
                                await teamAction('unshare');
                                setNotice(
                                  '이 프로젝트의 역량 공유를 철회했습니다. 기존 업무 배정은 유지됩니다.',
                                );
                              })
                            }
                          >
                            공유 철회
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        className="btn"
                        onClick={() => setSection('profile')}
                      >
                        내 이력서 등록하기
                      </button>
                    )}
                    {!writable && (
                      <p className="cf-help">
                        진행 가능한 프로젝트에서 최신 목표에 동의한 뒤 공유·역할
                        제안을 사용할 수 있습니다.
                      </p>
                    )}
                  </section>
                  <section className="cf-card">
                    <h3>팀이 공유한 경험</h3>
                    {team.members.map((m) => (
                      <article className="cf-member" key={m.person}>
                        <strong>
                          {m.name}
                          {m.person === team.me.person ? ' · 나' : ''}
                        </strong>
                        {m.profileId ? (
                          <>
                            <Chips ids={m.skills.map((s) => s.skillId)} />
                            <p>
                              희망 역할:{' '}
                              {m.preferredRoles.map(roleName).join(', ') ||
                                '미선택'}
                            </p>
                            {m.outdated && (
                              <p className="cf-help">
                                이전 프로필을 공유 중입니다. 본인이 새 버전으로
                                갱신할 수 있어요.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="cf-help">
                            아직 역량을 공유하지 않았습니다. 능력이 없는 것으로
                            판단하지 않습니다.
                          </p>
                        )}
                      </article>
                    ))}
                  </section>
                </div>
                <section className="cf-card">
                  <div className="cf-card-heading">
                    <div>
                      <h3>팀 역할 추천</h3>
                      <p className="cf-help">
                        경험·희망·업무량을 함께 비교하는 규칙 기반 추천입니다.
                      </p>
                    </div>
                    <button
                      className="btn primary"
                      disabled={busy || !writable || !team.templateMatchesGoal}
                      onClick={() =>
                        void act(async () => {
                          await teamAction('recommendRoles');
                          setNotice(
                            '역할안을 만들었습니다. 팀장이 담당자와 업무를 검토한 뒤 반영할 수 있습니다.',
                          );
                        })
                      }
                    >
                      역할안 만들기
                    </button>
                  </div>
                  {!team.templateMatchesGoal && (
                    <p className="cf-callout">
                      추천 템플릿으로 만든 프로젝트에서 처음 합의한 목표를
                      유지할 때 자동 과제를 연결할 수 있습니다. 현재 프로젝트의
                      업무는 작업 공간에서 관리해주세요.
                    </p>
                  )}
                  {team.staleProposal && (
                    <p className="cf-callout">
                      팀·업무·공유 정보가 바뀌었습니다. 역할안을 다시
                      만들어주세요.
                    </p>
                  )}
                  {team.proposal ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                          await teamAction('applyRoles', {
                            proposalId: team.proposal!.id,
                            assignments: Object.entries(assignments).map(
                              ([role, person]) => ({
                                role,
                                person: Number(person),
                              }),
                            ),
                            approved: true,
                          });
                          setNotice(
                            '역할별 업무를 저장했습니다. 업무 작업 공간에서 진행할 수 있어요.',
                          );
                        });
                      }}
                    >
                      {team.proposal.payload.assignments.map((a) => (
                        <article className="cf-role" key={a.role}>
                          <div className="cf-card-heading">
                            <h4>{roleName(a.role)}</h4>
                            <span className="cf-chip">초안 {a.hours}시간</span>
                          </div>
                          <label>
                            담당자
                            <select
                              value={assignments[a.role] ?? ''}
                              required
                              disabled={busy || !team.me.isOwner || !writable}
                              onChange={(e) =>
                                setAssignments({
                                  ...assignments,
                                  [a.role]: e.target.value,
                                })
                              }
                            >
                              <option value="">팀에서 담당자 선택</option>
                              {team.members.map((m) => (
                                <option key={m.person} value={m.person}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <ul>
                            {a.reasons.map((r) => (
                              <li key={r}>{r}</li>
                            ))}
                          </ul>
                          {!!a.missing.length && (
                            <p className="cf-help">
                              추천 담당자에게 확인할 경험:{' '}
                              {a.missing.map(skillName).join(', ')}
                            </p>
                          )}
                          {!!a.growth.length && (
                            <p>
                              추천 담당자의 성장 과제:{' '}
                              {a.growth.map(skillName).join(', ')}
                            </p>
                          )}
                          <ul className="cf-task-preview">
                            {team.template?.tasks
                              .filter((t) => t.role === a.role)
                              .map((t) => (
                                <li key={t.key}>
                                  {t.title} · {t.hours}시간
                                </li>
                              ))}
                          </ul>
                        </article>
                      ))}
                      {!!team.proposal.payload.warnings.length && (
                        <div className="cf-callout">
                          <ul>
                            {team.proposal.payload.warnings.map((w) => (
                              <li key={w}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="cf-help">
                        담당자를 수정하면 위 추천 근거는 원래 추천자에 대한
                        설명으로 남습니다. 이미 완료한 업무는 바꾸지 않으며,
                        생성된 업무는 중복 등록하지 않습니다.
                      </p>
                      {team.me.isOwner && (
                        <>
                          <label className="cf-agreement">
                            <input
                              type="checkbox"
                              required
                              disabled={busy || !writable}
                            />
                            팀과 담당 업무·초안 공수를 검토했습니다. 수행 역할만
                            반영하며 팀장·팀원 권한은 바뀌지 않습니다.
                          </label>
                          <button
                            className="btn primary wide"
                            disabled={
                              busy ||
                              !writable ||
                              Object.values(assignments).some((v) => v === '')
                            }
                          >
                            검토한 역할·업무 반영하기
                          </button>
                        </>
                      )}
                    </form>
                  ) : (
                    <p className="cf-empty">
                      팀원이 역량을 공유하면 역할안을 만들어보세요. 근거가 없는
                      역할은 미정으로 남겨 팀에서 결정할 수 있습니다.
                    </p>
                  )}
                  {!!team.tasks.some((t) => t.workRole) && (
                    <details open>
                      <summary>연결된 성장 과제</summary>
                      {team.tasks
                        .filter((t) => t.workRole)
                        .map((t) => (
                          <div className="cf-linked-task" key={t.id}>
                            <strong>{t.title}</strong>
                            <p>
                              {team.members.find((m) => m.person === t.person)
                                ?.name ?? '담당자 확인 필요'}{' '}
                              · {t.done ? '완료' : '진행 대기·진행 중'}
                            </p>
                            <Chips ids={t.skills} />
                          </div>
                        ))}
                    </details>
                  )}
                </section>
              </div>
            )}
            {section === 'experience' && (
              <div className="cf-columns">
                <section className="cf-card">
                  <h3>내가 수행한 업무 확인</h3>
                  <p>
                    완료 근거가 있는 본인 담당 업무를 가져옵니다. 팀 전체의
                    결과가 자동으로 개인 역량이 되지는 않습니다.
                  </p>
                  {team?.myCompletedTasks
                    .filter((t) => t.skills.length)
                    .map((t) => (
                      <ExperienceForm
                        key={t.id + ':' + t.changeVersion}
                        task={t}
                        busy={busy}
                        onSave={(values) =>
                          act(async () => {
                            await teamAction('recordExperience', {
                              taskId: t.id,
                              taskVersion: t.changeVersion,
                              ...values,
                            });
                            setData(await request<Personal>('/api/career'));
                            setNotice(
                              '본인이 확인한 경험과 이력서 문장 초안을 저장했습니다.',
                            );
                          })
                        }
                      />
                    ))}
                  {!team?.myCompletedTasks.some((t) => t.skills.length) && (
                    <p className="cf-empty">
                      아직 가져올 성장 과제가 없습니다. 업무를 수행하고 완료
                      근거를 기록한 뒤 다시 확인해주세요.
                    </p>
                  )}
                </section>
                <section className="cf-card">
                  <h3>나의 경험 기록과 이력서 초안</h3>
                  <p className="cf-help">
                    본인이 기여를 확인한 기록입니다. 시스템이 결과물을 자동
                    검증한 것은 아닙니다.
                  </p>
                  {data.experiences.map((e) => (
                    <article className="cf-experience" key={e.id}>
                      <div className="cf-card-heading">
                        <strong>{e.task_title}</strong>
                        <span
                          className={e.valid ? 'cf-status good' : 'cf-status'}
                        >
                          {e.valid ? '본인 확인' : '재확인 필요'}
                        </span>
                      </div>
                      <Chips ids={e.skill_ids} />
                      <p>{e.resume_bullet}</p>
                      <details>
                        <summary>완료 근거</summary>
                        <blockquote>{e.evidence}</blockquote>
                      </details>
                      {!e.valid && (
                        <p className="cf-help">
                          업무·담당·완료 근거가 변경돼 현재 역량 계산에서는
                          제외했습니다. 최신 상태를 확인한 후 다시 가져올 수
                          있습니다.
                        </p>
                      )}
                    </article>
                  ))}
                  {!data.experiences.length && (
                    <p className="cf-empty">
                      확인한 기여가 쌓이면 여기에 이력서 문장 초안이
                      만들어집니다.
                    </p>
                  )}
                  {!!imported.length && (
                    <button
                      className="btn primary wide"
                      onClick={() =>
                        download(
                          `${profile?.resumeText ?? ''}\n\n[프로젝트 추가 경험 · 본인 확인]\n${imported.map((e) => '- ' + e.resume_bullet).join('\n')}`,
                          'careerflow-resume-draft.txt',
                        )
                      }
                    >
                      <Download size={16} />
                      기존 이력서 + 새 경험 내려받기
                    </button>
                  )}
                  <h4>목표 공고·직무 다시 비교</h4>
                  <div className="cf-gap-list">
                    {data.gaps.map((g) => (
                      <article key={g.skillId}>
                        <div>
                          <strong>{skillName(g.skillId)}</strong>
                          <span className="cf-status">{STATUS[g.status]}</span>
                        </div>
                        {data.beforeGaps.find((b) => b.skillId === g.skillId)
                          ?.status !== g.status && (
                          <p className="cf-growth">
                            프로젝트 기여로 수행 근거가 추가됐어요.
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                  <button
                    className="btn"
                    onClick={() => setSection('recommend')}
                  >
                    갱신된 프로필로 다음 프로젝트 보기 <ArrowRight size={15} />
                  </button>
                </section>
              </div>
            )}
          </>
        )}
      </Content>
      <footer className="cf-footer">
        작은 경험이 다음 기회의 근거가 되도록.{' '}
        <span>CareerFlow × ProjectMate</span>
      </footer>
    </div>
  );
}
function ExperienceForm({
  task,
  busy,
  onSave,
}: {
  task: Team['myCompletedTasks'][number];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [skills, setSkills] = useState<SkillId[]>([]);
  const [contribution, setContribution] = useState('');
  return (
    <form
      className="cf-experience cf-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ skillIds: skills, contribution, confirmed: true });
      }}
    >
      <fieldset disabled={busy}>
        <h4>{task.title}</h4>
        <blockquote>{task.evidence}</blockquote>
        <legend className="sr-only">개인 기여 확인</legend>
        <p>실제로 직접 수행한 역량만 선택해주세요.</p>
        <div className="cf-choice-grid">
          {task.skills.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={skills.includes(s)}
                onChange={() => setSkills(toggle(skills, s))}
              />
              {skillName(s)}
            </label>
          ))}
        </div>
        <label>
          구체적인 본인 기여
          <textarea
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            value={contribution}
            onChange={(e) => setContribution(e.target.value)}
            placeholder="직접 구현·검증한 부분과 협업한 부분을 구분해주세요."
          />
        </label>
        <label className="cf-agreement">
          <input type="checkbox" required />위 근거와 설명이 본인이 수행한
          내용을 나타내는지 확인했습니다.
        </label>
        <button className="btn" disabled={busy || !skills.length}>
          경험 기록에 추가하기
        </button>
      </fieldset>
    </form>
  );
}
