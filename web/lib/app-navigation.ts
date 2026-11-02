export type AppParams = Record<string, string | string[] | undefined>;
export function appDestination(params: AppParams, tab = 'home') {
  const query = new URLSearchParams({ tab });
  for (const key of ['project', 'invite', 'view']) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  return '/app?' + query.toString();
}
