import {
  identity,
  listProjects,
  createProject,
  createInvite,
  inspectInvite,
  acceptInvite,
  member,
  actorOf,
  AccessError,
  GoalChanged,
} from '@/lib/projects';
import { database, readSprint, readPolicy, save, Conflict } from '@/lib/sprint-store';
import {
  assertProjectMutationAllowed,
  PolicyError,
} from '@/lib/sprint-policy';
export const dynamic = 'force-dynamic';
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
function failure(error: unknown) {
  if (error instanceof AccessError)
    return reply({ error: error.message }, error.status);
  if (error instanceof PolicyError)
    return reply({ error: error.message }, error.status);
  if (error instanceof GoalChanged)
    return reply({ error: error.message, details: error.details }, error.status);
  if (error instanceof Conflict)
    return reply(
      { error: '다른 변경이 있습니다. 최신 상태에서 다시 시도해주세요.' },
      409,
    );
  if (
    error instanceof Error &&
    !/SQLITE|D1_|database|binding/i.test(error.message)
  )
    return reply({ error: error.message }, 400);
  console.error('project request failed', error);
  return reply(
    { error: '처리하지 못했습니다. 잠시 후 다시 시도해주세요.' },
    503,
  );
}
export async function GET(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const token = new URL(request.url).searchParams.get('invite');
    if (token) {
      const { details, invite } = await inspectInvite(user, token);
      return reply({ details, expiresAt: invite.expires_at });
    }
    return reply({
      projects: await listProjects(user),
      me: { name: user.name, email: user.email },
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = identity(request);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 16000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error('요청 형식을 확인해주세요.');
    if (b.action === 'create')
      return reply({ projectId: await createProject(user, b) }, 201);
    if (b.action === 'accept')
      return reply({
        projectId: await acceptInvite(
          user,
          String(b.token),
          b.agreed,
          b.goalVersion,
        ),
      });
    if (typeof b.projectId !== 'string' || !Number.isInteger(b.revision))
      throw new Error('프로젝트와 최신 버전을 선택해주세요.');
    if (b.action === 'invite')
      return reply(
        await createInvite(b.projectId, user, b.revision, b.email),
        201,
      );
    if (b.action === 'revoke') {
      const me = await member(b.projectId, user);
      assertProjectMutationAllowed({
        policy: await readPolicy(b.projectId),
        actor: actorOf(me),
        action: 'revokeInvite',
        now: new Date(),
      });
      const s = await readSprint(b.projectId);
      if (!s || s.revision !== b.revision) throw new Conflict();
      await save(
        b.projectId,
        s,
        'revoke_invite',
        `${me.display_name} · 초대 취소`,
        (m) => [
          database()
            .prepare(
              "UPDATE project_invites SET status='revoked' WHERE project_id=? AND id=? AND status='pending' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
            )
            .bind(b.projectId, b.inviteId, b.projectId, m),
        ],
        ['draft', 'active'],
      );
      return reply({ ok: true });
    }
    throw new Error('지원하지 않는 작업입니다.');
  } catch (e) {
    return failure(e);
  }
}
