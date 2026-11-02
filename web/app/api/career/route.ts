import { identity, AuthUnavailable } from '@/lib/auth';
import { AccessError } from '@/lib/projects';
import { PolicyError } from '@/lib/sprint-policy';
import { Conflict, database } from '@/lib/sprint-store';
import { SKILLS, ROLES, TARGETS } from '@/lib/career/catalog';
import {
  CareerError,
  profileInput,
  basicAnalysis,
  gapsFor,
  recommendations,
} from '@/lib/career/profile';
import { analyzeWithAI, careerAiConfigured } from '@/lib/career/model';
import {
  readProfile,
  saveProfile,
  readExperiences,
  experienceSkills,
  createRecommendedProject,
  teamState,
  shareProfile,
  proposeRoles,
  applyRoles,
  recordExperience,
} from '@/lib/career/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
function failure(e: unknown) {
  if (
    e instanceof CareerError ||
    e instanceof AccessError ||
    e instanceof PolicyError
  )
    return reply({ error: e.message }, e.status);
  if (e instanceof Conflict)
    return reply(
      {
        error: '프로젝트가 바뀌었습니다. 최신 상태를 불러와 다시 검토해주세요.',
      },
      409,
    );
  if (e instanceof SyntaxError)
    return reply({ error: '요청 형식을 확인해주세요.' }, 400);
  // Resume text, model responses, credentials and database errors must not enter logs or responses.
  console.error(
    'career request failed',
    e instanceof Error ? e.name : 'unknown',
  );
  return reply(
    {
      error:
        '저장소에 연결하지 못했습니다. 서버 설정·마이그레이션을 확인해주세요.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable)
    return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const projectId = new URL(request.url).searchParams.get('project');
    if (projectId) {
      const { _team, ...state } = await teamState(projectId, user);
      return reply(state);
    }
    const [profile, experiences] = await Promise.all([
      readProfile(user.id),
      readExperiences(user.id),
    ]);
    const extra = experienceSkills(experiences);
    return reply({
      profile,
      experiences,
      skills: SKILLS.map(({ id, name }) => ({ id, name })),
      roles: ROLES,
      targets: TARGETS,
      aiConfigured: careerAiConfigured(),
      extraSkills: extra,
      gaps: profile ? gapsFor(profile, extra) : [],
      beforeGaps: profile ? gapsFor(profile) : [],
      recommendations: profile ? recommendations(profile, extra) : [],
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable)
    return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const body = await request.text();
  if (body.length > 90000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(body) as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new CareerError('요청 형식을 확인해주세요.');
    if (b.action === 'profile') {
      const input = profileInput(b);
      if (!Number.isInteger(b.version) || Number(b.version) < 0)
        throw new CareerError('프로필 버전을 확인해주세요.');
      const current = await readProfile(user.id);
      if ((current?.version ?? 0) !== b.version)
        throw new CareerError(
          '프로필이 바뀌었습니다. 새로고침 후 다시 저장해주세요.',
          409,
        );
      let analysis;
      if (b.mode === 'basic') analysis = basicAnalysis(input);
      else if (b.mode === 'ai') {
        if (b.consent !== true)
          throw new CareerError(
            '이력서·목표 공고를 AI 분석에 보내는 데 동의해주세요.',
          );
        if (!careerAiConfigured())
          throw new CareerError(
            'AI 분석 설정이 없습니다. 기본 근거 추출을 선택해주세요.',
            503,
          );
        const quota = await database()
          .prepare(
            "INSERT INTO career_ai_quota(user_id,day,n) VALUES(?,(now() AT TIME ZONE 'Asia/Seoul')::date,1) ON CONFLICT(user_id,day) DO UPDATE SET n=career_ai_quota.n+1 WHERE career_ai_quota.n<10 RETURNING day",
          )
          .bind(user.id)
          .first<{ day: string }>();
        if (!quota)
          throw new CareerError(
            '오늘의 이력서 AI 분석 10회를 모두 사용했습니다. 기본 추출은 계속 사용할 수 있습니다.',
            429,
          );
        try {
          analysis = await analyzeWithAI(input);
        } catch (e) {
          await database()
            .prepare(
              'UPDATE career_ai_quota SET n=n-1 WHERE user_id=? AND day=? AND n>0',
            )
            .bind(user.id, quota.day)
            .run();
          throw e;
        }
      } else throw new CareerError('분석 방식을 선택해주세요.');
      return reply({
        profile: await saveProfile(user.id, Number(b.version), input, analysis),
      });
    }
    if (b.action === 'createProject')
      return reply({ projectId: await createRecommendedProject(user, b) }, 201);
    if (
      typeof b.projectId !== 'string' ||
      !b.projectId ||
      b.projectId.length > 100
    )
      throw new CareerError('프로젝트를 선택해주세요.');
    if (b.action === 'share' || b.action === 'unshare')
      await shareProfile(b.projectId, user, b);
    else if (b.action === 'recommendRoles')
      return reply(
        { proposalId: await proposeRoles(b.projectId, user, b.revision) },
        201,
      );
    else if (b.action === 'applyRoles') await applyRoles(b.projectId, user, b);
    else if (b.action === 'recordExperience')
      await recordExperience(b.projectId, user, b);
    else throw new CareerError('지원하지 않는 요청입니다.');
    return reply({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
