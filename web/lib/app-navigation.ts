export type AppParams = Record<string, string | string[] | undefined>;
export function appDestination(params: AppParams, tab = 'home') {
  if (params.invite) tab = 'work';
  else if (params.teams === '1') tab = 'teams';
  else if (params.create === '1' && !params.project) tab = 'create';
  const query = new URLSearchParams({ tab });
  for (const key of ['project', 'invite', 'view']) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  return '/app?' + query.toString();
}
/** 홈을 내 프로젝트 화면으로 보일지. 준비·진행 중 프로젝트가 있을 때만이고, 로그인 전·끝난 프로젝트만 있으면 원래 홈. */
export function homeShowsProject(projects?: { lifecycle: string }[]) {
  return Boolean(projects?.some((p) => p.lifecycle === 'draft' || p.lifecycle === 'active'));
}
