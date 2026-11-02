import {
  roleName,
  skillName,
  type ProjectTemplate,
  type RoleId,
  type SkillId,
} from './catalog';

export type SharedMember = {
  userId: string;
  person: number;
  name: string;
  profileId: string | null;
  skills: { skillId: SkillId; level: 'applied' | 'learning' | 'mentioned' }[];
  learningGoals: SkillId[];
  preferredRoles: RoleId[];
  currentHours: number;
};
export type RoleAssignment = {
  role: RoleId;
  person: number | null;
  reasons: string[];
  missing: SkillId[];
  growth: SkillId[];
  hours: number;
};
export type RolePlan = {
  templateId: string;
  assignments: RoleAssignment[];
  warnings: string[];
};

/** Small teams permit exhaustive assignment. Optimize total coverage, not independent per-role winners. */
export function recommendRoles(
  template: ProjectTemplate,
  members: SharedMember[],
): RolePlan {
  const choices = template.roles.map((r) =>
    members.filter(
      (m) =>
        m.profileId &&
        (m.skills.some(
          (s) => r.skills.includes(s.skillId) && s.level !== 'mentioned',
        ) ||
          m.preferredRoles.includes(r.id)),
    ),
  );
  const hours = template.roles.map((r) =>
    template.tasks
      .filter((t) => t.role === r.id)
      .reduce((n, t) => n + t.hours, 0),
  );
  let best: (SharedMember | null)[] = template.roles.map(() => null);
  let bestScore = -Infinity;
  function visit(
    index: number,
    selected: (SharedMember | null)[],
    score: number,
  ) {
    if (index === template.roles.length) {
      const loads = members.map(
        (m) =>
          m.currentHours +
          selected.reduce(
            (n, v, i) => n + (v?.person === m.person ? hours[i] : 0),
            0,
          ),
      );
      const balanced = score - loads.reduce((n, h) => n + (h * h) / 100, 0);
      if (balanced > bestScore) {
        best = [...selected];
        bestScore = balanced;
      }
      return;
    }
    const role = template.roles[index];
    for (const candidate of [...choices[index], null]) {
      const fit = candidate
        ? role.skills.reduce((n, id) => {
            const level = candidate.skills.find((s) => s.skillId === id)?.level;
            return n + (level === 'applied' ? 5 : level === 'learning' ? 2 : 0);
          }, 0) +
          (candidate.preferredRoles.includes(role.id) ? 3 : 0) +
          8
        : -10;
      visit(index + 1, [...selected, candidate], score + fit);
    }
  }
  visit(0, [], 0);
  const assignments = template.roles.map((role, i): RoleAssignment => {
    const member = best[i];
    const fit = role.skills.filter((id) =>
      member?.skills.some((s) => s.skillId === id && s.level !== 'mentioned'),
    );
    const growth = [
      ...new Set(
        template.tasks
          .filter((t) => t.role === role.id)
          .flatMap((t) => t.skills),
      ),
    ].filter((s) => member?.learningGoals.includes(s));
    return {
      role: role.id,
      person: member?.person ?? null,
      hours: hours[i],
      reasons: member
        ? [
            fit.length
              ? `공유한 경험: ${fit.map(skillName).join(', ')}`
              : '본인이 선택한 희망 역할입니다. 수행 경험은 확인이 필요합니다.',
            ...(member.preferredRoles.includes(role.id)
              ? ['희망 역할과 일치합니다.']
              : []),
            '다른 역할의 담당과 업무량을 함께 고려했습니다.',
          ]
        : [
            '공유된 경험·희망 역할에서 담당 근거를 찾지 못했습니다. 팀에서 담당자를 정해주세요.',
          ],
      missing: role.skills.filter((s) => !fit.includes(s)),
      growth,
    };
  });
  return {
    templateId: template.id,
    assignments,
    warnings: [
      ...members
        .filter((m) => !m.profileId)
        .map(
          (m) =>
            `${m.name}: 공유된 역량 프로필이 없어 경험을 추정하지 않았습니다.`,
        ),
      ...assignments
        .filter((a) => a.person === null)
        .map((a) => `${roleName(a.role)} 담당이 미정입니다.`),
      ...members.flatMap((m) => {
        const exposed = template.tasks
          .filter(
            (t) =>
              assignments.find((a) => a.role === t.role)?.person === m.person,
          )
          .flatMap((t) => t.skills);
        const missed = m.learningGoals.filter((s) => !exposed.includes(s));
        return missed.length
          ? [
              `${m.name}: 현재 추천 업무로는 ${missed.map(skillName).join(', ')} 성장 목표를 다루지 못합니다. 협업 과제를 검토해주세요.`,
            ]
          : [];
      }),
    ],
  };
}
