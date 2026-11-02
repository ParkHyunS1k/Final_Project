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
