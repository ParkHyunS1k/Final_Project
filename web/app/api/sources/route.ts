// 붙여넣은 원문의 저장과 조회. 원문 문장은 데이터이며 지시로 실행하지 않는다.
import { identity, member, actorOf, AccessError } from '@/lib/projects';
import { readPolicy } from '@/lib/sprint-store';
import { assertProjectMutationAllowed, PolicyError } from '@/lib/sprint-policy';
import {
  createSource,
  listSources,
  readSource,
  sameHashSources,
  sourceInput,
} from '@/lib/source-documents';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
function failure(error: unknown) {
  if (error instanceof AccessError || error instanceof PolicyError)
    return reply({ error: error.message }, error.status);
  if (error instanceof SyntaxError)
    return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  console.error('source request failed', error);
  return reply({ error: '처리하지 못했습니다.' }, 503);
}

export async function GET(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project') ?? '';
    // 다른 프로젝트의 멤버는 ID를 알아도 읽지 못한다.
    await member(projectId, user);
    const id = url.searchParams.get('source');
    if (!id) return reply({ sources: await listSources(projectId) });
    const source = await readSource(projectId, id);
    if (!source) return reply({ error: '원문을 찾을 수 없습니다.' }, 404);
    return reply({
      source,
      duplicates: await sameHashSources(projectId, source.hash, source.id),
    });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 60000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const projectId = typeof b.projectId === 'string' ? b.projectId : '';
    const me = await member(projectId, user);
    assertProjectMutationAllowed({
      policy: await readPolicy(projectId),
      actor: actorOf(me),
      action: 'createSource',
      now: new Date(),
    });
    const id = await createSource(
      projectId,
      user.id,
      sourceInput(b),
      new Date(),
    );
    return reply({ sourceId: id }, 201);
  } catch (e) {
    return failure(e);
  }
}
