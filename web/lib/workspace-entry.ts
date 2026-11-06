/**
 * 작업 공간을 처음 열 때 무엇을 보여줄지 정한다.
 * 진행 중, 없으면 준비 중인 프로젝트가 있으면 그 프로젝트를 연다. 둘 다 없으면 만들기 대신 '팀 찾기'를 연다
 * (랜딩의 ?create=1도 같다, 사용자 결정 2026-11-03). ?teams=1은 언제나 팀 찾기.
 * 주소의 ?project=와 ?invite=는 그보다 우선한다. 같은 상태가 여럿이면 목록 순서(최근 수정순)의 첫 프로젝트.
 * 동료평가를 아직 낼 수 있는 프로젝트(pending)가 있으면 그 프로젝트를 가장 먼저 연다(2026-11-06).
 */
export function workspaceEntry(
  search: string,
  projects: { id: string; lifecycle: string }[],
  pending: string[] = [],
) {
  const params = new URLSearchParams(search);
  const invite = params.get('invite') || '';
  const project = params.get('project') || '';
  const open =
    projects.find((p) => pending.includes(p.id)) ??
    projects.find((p) => p.lifecycle === 'active') ??
    projects.find((p) => p.lifecycle === 'draft');
  return {
    invite,
    browsing: !invite && !project && (params.get('teams') === '1' || !open),
    selected: project || open?.id || projects[0]?.id || '',
  };
}
