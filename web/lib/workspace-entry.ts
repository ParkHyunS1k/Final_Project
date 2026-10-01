/**
 * 작업 공간을 처음 열 때 무엇을 보여줄지 정한다.
 * 진행 중인 스프린트가 있으면 랜딩의 ?create=1보다 그 프로젝트 현황을 먼저 연다.
 * 주소의 ?project=와 ?invite=는 그보다 우선한다. 여러 개면 목록 순서(최근 수정순)의 첫 진행 중 프로젝트.
 */
export function workspaceEntry(
  search: string,
  projects: { id: string; lifecycle: string }[],
) {
  const params = new URLSearchParams(search);
  const invite = params.get('invite') || '';
  const active = projects.find((p) => p.lifecycle === 'active');
  return {
    invite,
    creating: !invite && params.get('create') === '1' && !active,
    selected: params.get('project') || active?.id || projects[0]?.id || '',
  };
}
