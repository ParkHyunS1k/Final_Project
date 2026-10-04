// 로컬 화면 확인용 프로젝트 3개를 만든다: 진행 중(병목 1건·대기 1건), 준비 중, 완주.
// 개발 서버(AUTH_DEV_HEADERS=1, PGlite)에 직접 요청한다. 운영 DB에 쓰지 않도록 대상은 127.0.0.1만 받는다.
// 사용: node scripts/seed-ui.mjs [대상 포트=3102]
const port = process.argv[2] ?? '3102';
const base = `http://127.0.0.1:${port}`;
const who = (user, name) => ({
  'content-type': 'application/json',
  'oai-authenticated-user-id': user,
  'oai-authenticated-user-email': `${user}@test.local`,
  'oai-authenticated-user-full-name': encodeURIComponent(name),
  'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
});
const OWNER = who('owner', '도윤');
const MATE = who('mate', '서연');

async function call(path, headers, body) {
  const r = await fetch(
    base + path,
    body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(`${path} ${body?.action ?? 'GET'} → ${r.status} ${data.error ?? ''}`);
  return data;
}
const read = (headers, id) => call('/api/sprint?project=' + encodeURIComponent(id), headers);
const act = (headers, state, action, fields = {}) =>
  call('/api/sprint', headers, {
    action,
    projectId: state.projectId,
    revision: state.sprint.revision,
    ...fields,
  });

async function team(title) {
  const { projectId } = await call('/api/projects', OWNER, {
    action: 'create',
    title,
    goal: '공고문을 실행 계획으로 바꾸는 서비스를 출시한다',
    scope: '공고 붙여넣기, 마감일 추출, 결과 화면',
    completionCriteria: '핵심 흐름을 실제로 실행해 보인다',
    deliverables: '동작하는 서비스\n3분 데모 영상',
    duration: 7,
    agreed: true,
  });
  const state = await read(OWNER, projectId);
  const { token } = await call('/api/projects', OWNER, {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'mate@test.local',
  });
  await call('/api/projects', MATE, {
    action: 'accept',
    token,
    agreed: true,
    goalVersion: state.policy.goalVersion,
  });
  return read(OWNER, projectId);
}

const draft = await team('준비 중 스프린트');

let active = await act(OWNER, await team('취준 포트폴리오 스프린트'), 'start');
const lead = active.me.person;
const mate = active.members.find((m) => m.person !== lead).person;
const day = (n) => new Date(Date.parse(active.policy.startedAt) + n * 86400000).toISOString();
active = await act(OWNER, active, 'createTask', { title: '요구사항 정리', person: lead, remaining: 3, dependsOn: [], dueAt: day(1) });
active = await act(OWNER, active, 'createTask', { title: '메인 화면 시안', person: lead, remaining: 200, dependsOn: [], dueAt: day(4) });
active = await act(OWNER, active, 'createTask', { title: '로그인 API 연동', person: mate, remaining: 6, dependsOn: [2], dueAt: day(5) });
active = await act(OWNER, active, 'createTask', { title: '발표 자료 초안', person: mate, remaining: 5, dependsOn: [], dueAt: day(6) });
active = await act(OWNER, active, 'checkin', { taskId: 1, remaining: 1, note: '요구사항 초안 공유함' });

let done = await act(OWNER, await team('완주한 스프린트'), 'start');
for (const d of done.deliverables) {
  done = await act(OWNER, done, 'deliverableEvidence', {
    deliverableId: d.deliverableId,
    evidence: '저장소 링크와 실행 방법 정리',
  });
  done = await act(OWNER, done, 'deliverableConfirm', {
    deliverableId: d.deliverableId,
    confirmed: true,
  });
}
done = await act(OWNER, done, 'finish');

console.log(`active=${active.projectId}\ndraft=${draft.projectId}\ncompleted=${done.projectId}`);
