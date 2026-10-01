/**
 * 작업 공간을 처음 열 때 무엇을 보여줄지 정한다.
 * 진행 중, 없으면 준비 중인 프로젝트가 있으면 랜딩의 ?create=1보다 그 프로젝트를 먼저 연다.
 * 주소의 ?project=와 ?invite=는 그보다 우선한다. 같은 상태가 여럿이면 목록 순서(최근 수정순)의 첫 프로젝트.
 */
export function workspaceEntry(
  search: string,
  projects: { id: string; lifecycle: string }[],
) {
  const params = new URLSearchParams(search);
  const invite = params.get('invite') || '';
  const open =
    projects.find((p) => p.lifecycle === 'active') ??
    projects.find((p) => p.lifecycle === 'draft');
  return {
    invite,
    creating: !invite && params.get('create') === '1' && !open,
    selected: params.get('project') || open?.id || projects[0]?.id || '',
  };
}
