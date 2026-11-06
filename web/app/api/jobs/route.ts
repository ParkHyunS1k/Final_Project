import { identity, AuthUnavailable } from '@/lib/auth';
import { JoobleError, searchJooble } from '@/lib/jooble';

export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable)
    return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);

  const params = new URL(request.url).searchParams;
  try {
    const radiusValue = params.get('radius');
    const radius = radiusValue ? Number(radiusValue) : undefined;
    return reply(
      await searchJooble({
        keywords: params.get('keywords') ?? '',
        location: params.get('location') ?? '대한민국',
        radius: Number.isFinite(radius) ? radius : undefined,
        page: Number(params.get('page') ?? 1),
        resultOnPage: Number(params.get('resultOnPage') ?? 10),
        companySearch: params.get('companySearch') === 'true',
      }),
    );
  } catch (error) {
    if (error instanceof JoobleError)
      return reply({ error: error.message }, error.status);
    console.error(
      'jobs request failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return reply(
      { error: '공고 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' },
      502,
    );
  }
}
