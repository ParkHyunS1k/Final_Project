import {
  SKILLS,
  TARGETS,
  ROLES,
  TEMPLATES,
  isSkill,
  skillName,
  type SkillId,
  type RoleId,
} from './catalog';

export class CareerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export type SkillEvidence = {
  skillId: SkillId;
  level: 'applied' | 'learning' | 'mentioned';
  quote: string;
  source: 'resume' | 'project';
  sourceId?: string;
};
export type Requirement = {
  skillId: SkillId;
  quote: string;
  importance: 'required' | 'preferred' | 'reference';
};
export type Analysis = {
  mode: 'basic' | 'ai';
  summary: string;
  skills: SkillEvidence[];
  requirements: Requirement[];
  questions: string[];
};
export type ProfileInput = {
  resumeName: string;
  resumeText: string;
  targetRole: string;
  targetPosting: string;
  learningGoals: SkillId[];
  preferredRoles: RoleId[];
  noExperience: SkillId[];
};
export type Profile = ProfileInput & {
  id: string;
  version: number;
  analysis: Analysis;
  createdAt: string;
};
export function textInput(v: unknown, name: string, min: number, max: number) {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max)
    throw new CareerError(`${name}: ${min}~${max}자로 입력해주세요.`);
  return v.trim();
}
export function skillIds(v: unknown): SkillId[] {
  if (
    !Array.isArray(v) ||
    v.length > SKILLS.length ||
    v.some((s) => !isSkill(s))
  )
    throw new CareerError('역량 목록을 확인해주세요.');
  return [...new Set(v)] as SkillId[];
}
export function profileInput(b: Record<string, unknown>): ProfileInput {
  const targetRole = b.targetRole ?? '';
  if (typeof targetRole !== 'string')
    throw new CareerError('목표 직무를 확인해주세요.');
  if (targetRole && !TARGETS.some((t) => t.id === targetRole))
    throw new CareerError('목표 직무를 확인해주세요.');
  const preferredRoles = b.preferredRoles ?? [];
  if (
    !Array.isArray(preferredRoles) ||
    preferredRoles.length > ROLES.length ||
    preferredRoles.some((r) => !ROLES.some((v) => v.id === r))
  )
    throw new CareerError('희망 역할을 확인해주세요.');
  return {
    resumeName: textInput(b.resumeName ?? '나의 이력서', '이력서 이름', 1, 80),
    resumeText: textInput(b.resumeText, '이력서', 30, 40000),
    targetRole,
    targetPosting: textInput(b.targetPosting ?? '', '목표 공고', 0, 20000),
    learningGoals: skillIds(b.learningGoals ?? []),
    noExperience: skillIds(b.noExperience ?? []),
    preferredRoles: [...new Set(preferredRoles)] as RoleId[],
  };
}
function hasAlias(text: string, aliases: readonly string[]) {
  return aliases.some((a) => {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Latin token boundaries avoid Git in digital, React in reaction, SQL in prose fragments.
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
  });
}
const NEGATIVE =
  /경험(?:이|은)?\s*(?:없|부족)|해본 적(?:이)?\s*없|사용하지\s*않|못했|미경험|no experience|never used/i;
const FUTURE = /예정|계획|배우고\s*싶|해보고\s*싶|want to|plan to/i;
const APPLIED =
  /구현|개발|구축|분석했|분석한|배포했|작성했|설계했|설계한|구성했|수행|만들|built|implemented|developed|deployed/i;
const LEARNING = /학습|수강|실습|공부|튜토리얼|learn|course|tutorial/i;
export function basicAnalysis(input: ProfileInput): Analysis {
  const lines = input.resumeText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const skills: SkillEvidence[] = [];
  for (const skill of SKILLS) {
    const hits = lines.filter(
      (line) =>
        hasAlias(line, skill.aliases) &&
        !NEGATIVE.test(line) &&
        !FUTURE.test(line),
    );
    const quote = hits.find((s) => APPLIED.test(s)) ?? hits[0];
    if (quote)
      skills.push({
        skillId: skill.id,
        quote,
        source: 'resume',
        level: APPLIED.test(quote)
          ? 'applied'
          : LEARNING.test(quote)
            ? 'learning'
            : 'mentioned',
      });
  }
  const requirements: Requirement[] = [];
  for (const skill of SKILLS) {
    const quote = input.targetPosting
      .split(/\n+/)
      .find(
        (s) =>
          hasAlias(s, skill.aliases) &&
          !/불필요|필요하지|not required/i.test(s),
      );
    if (quote)
      requirements.push({
        skillId: skill.id,
        quote,
        importance: /우대|preferred/i.test(quote) ? 'preferred' : 'required',
      });
  }
  return {
    mode: 'basic',
    skills,
    requirements,
    summary:
      '원문 표현을 기준으로 찾은 경험입니다. 기본 추출은 AI 숙련도 평가가 아니며, 실제 담당 범위는 확인이 필요합니다.',
    questions: skills
      .filter((s) => s.level === 'mentioned')
      .slice(0, 3)
      .map(
        (s) => `${skillName(s.skillId)}를 직접 수행한 업무와 결과물이 있나요?`,
      ),
  };
}
// Validate not only JSON shape, but exact source quotes. Model text never grants a skill by itself.
export function validateAnalysis(raw: unknown, input: ProfileInput): Analysis {
  if (!raw || typeof raw !== 'object')
    throw new CareerError('AI 분석 형식이 올바르지 않습니다.', 502);
  const value = raw as Record<string, unknown>;
  if (
    !Array.isArray(value.skills) ||
    value.skills.length > 36 ||
    !Array.isArray(value.requirements) ||
    value.requirements.length > 36 ||
    !Array.isArray(value.questions)
  )
    throw new CareerError('AI 분석 형식이 올바르지 않습니다.', 502);
  const skills: SkillEvidence[] = [];
  for (const item of value.skills) {
    if (!item || typeof item !== 'object')
      throw new CareerError('AI 근거를 확인하지 못했습니다.', 502);
    const s = item as Record<string, unknown>;
    if (
      !isSkill(s.skillId) ||
      !['applied', 'learning', 'mentioned'].includes(String(s.level)) ||
      typeof s.quote !== 'string' ||
      s.quote.trim().length < 3 ||
      !input.resumeText.includes(s.quote)
    )
      throw new CareerError(
        'AI가 반환한 이력서 근거가 원문과 일치하지 않습니다. 다시 분석해주세요.',
        502,
      );
    if (NEGATIVE.test(s.quote) || FUTURE.test(s.quote)) continue;
    if (!skills.some((v) => v.skillId === s.skillId))
      skills.push({
        skillId: s.skillId,
        level: s.level as SkillEvidence['level'],
        quote: s.quote,
        source: 'resume',
      });
  }
  const requirements: Requirement[] = [];
  for (const item of value.requirements) {
    if (!item || typeof item !== 'object')
      throw new CareerError('AI 공고 근거를 확인하지 못했습니다.', 502);
    const r = item as Record<string, unknown>;
    if (
      !isSkill(r.skillId) ||
      !['required', 'preferred'].includes(String(r.importance)) ||
      typeof r.quote !== 'string' ||
      r.quote.trim().length < 3 ||
      !input.targetPosting.includes(r.quote)
    )
      throw new CareerError(
        'AI가 반환한 공고 근거가 원문과 일치하지 않습니다.',
        502,
      );
    if (!requirements.some((v) => v.skillId === r.skillId))
      requirements.push({
        skillId: r.skillId,
        quote: r.quote,
        importance: r.importance as Requirement['importance'],
      });
  }
  return {
    mode: 'ai',
    skills,
    requirements,
    summary: textInput(value.summary, '분석 요약', 1, 1500),
    questions: value.questions
      .slice(0, 3)
      .map((q) => textInput(q, '확인 질문', 1, 300)),
  };
}
export function gapsFor(
  profile: ProfileInput & { analysis: Analysis },
  extra: SkillEvidence[] = [],
) {
  const requirements: Requirement[] = profile.targetPosting.trim()
    ? profile.analysis.requirements
    : (TARGETS.find((t) => t.id === profile.targetRole)?.skills ?? []).map(
        (skillId) => ({
          skillId,
          quote: '직무별 학습 참고 기준 · 실제 공고의 필수 요건이 아닙니다.',
          importance: 'reference' as const,
        }),
      );
  return requirements.map((r) => {
    const evidence =
      [...extra, ...profile.analysis.skills].find(
        (s) => s.skillId === r.skillId && s.level === 'applied',
      ) ??
      [...extra, ...profile.analysis.skills].find(
        (s) => s.skillId === r.skillId,
      );
    const status = extra.some(
      (s) => s.skillId === r.skillId && s.level === 'applied',
    )
      ? 'matched'
      : profile.noExperience.includes(r.skillId)
        ? 'no_experience'
        : evidence?.level === 'applied'
          ? 'matched'
          : evidence
            ? 'partial'
            : 'not_found';
    return { ...r, status, evidence: evidence ?? null };
  });
}
export function recommendations(profile: Profile, extra: SkillEvidence[] = []) {
  const known = new Set(
    [...profile.analysis.skills, ...extra]
      .filter(
        (s) =>
          s.level !== 'mentioned' &&
          (!profile.noExperience.includes(s.skillId) || s.source === 'project'),
      )
      .map((s) => s.skillId),
  );
  const wanted = new Set([
    ...profile.learningGoals,
    ...gapsFor(profile, extra)
      .filter((g) => g.status !== 'matched')
      .map((g) => g.skillId),
  ]);
  return TEMPLATES.map((template) => {
    const skills = [...new Set(template.tasks.flatMap((t) => t.skills))];
    const strengths = skills.filter((s) => known.has(s));
    const growth = skills.filter((s) => wanted.has(s) && !known.has(s));
    const roles = template.roles
      .map((r) => {
        const fit = r.skills.filter((s) => known.has(s));
        const opportunities = template.tasks
          .filter((t) => t.role === r.id)
          .flatMap((t) => t.skills)
          .filter((s) => wanted.has(s));
        return {
          role: r.id,
          strengths: fit,
          growth: [...new Set(opportunities)],
          value:
            fit.length * 4 +
            opportunities.length +
            (profile.preferredRoles.includes(r.id) ? 2 : 0),
        };
      })
      .sort((a, b) => b.value - a.value);
    return {
      template,
      strengths,
      growth,
      recommendedRole: roles[0],
      track: growth.length ? 'growth' : 'strength',
      needsPreparation: !strengths.length,
      rank: strengths.length * 3 + growth.length * 4 + roles[0].value,
    };
  })
    .sort((a, b) => b.rank - a.rank)
    .map(({ rank: _rank, ...r }) => r);
}
