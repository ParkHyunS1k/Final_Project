#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const PROJECT = {
  title: '[개발 시드] ProjectMate 업무분담 검증',
  goal: '가상 팀원 네 명으로 계획서의 담당자 배정 변경안을 검토한다.',
  scope: '프로젝트 생성, 이메일 지정 초대, 목표 합의, 스프린트 시작, 계획서 변경안 검토',
  completionCriteria: '네 명이 참여한 진행 중 프로젝트에서 계획서 네 건을 붙여넣어 변경안을 검토할 수 있다.',
  deliverables: '담당자 배정 변경안\n검증 결과 기록',
  duration: 7,
};
const PEOPLE = [
  {
    id: 'dev-seed-lead-pm-qa',
    email: 'dev-seed-lead@projectmate.local',
    name: '김리드 (PM·QA 팀장)',
    role: 'owner',
  },
  {
    id: 'dev-seed-frontend',
    email: 'dev-seed-frontend@projectmate.local',
    name: '이프론트 (프론트엔드)',
    role: 'member',
  },
  {
    id: 'dev-seed-backend',
    email: 'dev-seed-backend@projectmate.local',
    name: '박백엔드 (백엔드)',
    role: 'member',
  },
  {
    id: 'dev-seed-design',
    email: 'dev-seed-design@projectmate.local',
    name: '최디자인 (UX 디자인)',
    role: 'member',
  },
];

function usage() {
  return `ProjectMate 개발용 가상 팀 시드

사용법:
  node scripts/seed-dev-team.mjs [--base-url URL]
  node scripts/seed-dev-team.mjs --help

옵션:
  --base-url URL  로컬 개발 서버 주소 (기본값: ${DEFAULT_BASE_URL})
  --help           이 도움말 출력

스크립트는 DB를 직접 수정하지 않고 HTTP API만 사용한다. 같은 프로젝트 이름을
찾아 재사용하므로 정상 완료 후 다시 실행해도 프로젝트를 중복 생성하지 않는다.`;
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, baseUrl };
    if (arg === '--base-url') {
      if (!argv[index + 1]) throw new Error('--base-url 뒤에 URL이 필요합니다.');
      baseUrl = argv[++index];
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('--base-url은 http 또는 https URL이어야 합니다.');
  return { help: false, baseUrl: parsed.origin };
}

function identityHeaders(person, json = false, origin = '') {
  const headers = {
    'oai-authenticated-user-id': person.id,
    'oai-authenticated-user-email': person.email,
    // Fetch의 Header 값은 ByteString이므로 한글 표시명은 서버가 지원하는 방식으로 보낸다.
    'oai-authenticated-user-full-name': encodeURIComponent(person.name),
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  };
  if (json) {
    headers['content-type'] = 'application/json';
    headers.origin = origin;
  }
  return headers;
}

async function request(baseUrl, person, pathname, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: identityHeaders(person, method !== 'GET', baseUrl),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const message = body && typeof body.error === 'string' ? body.error : text;
    throw new Error(`${method} ${pathname} 실패 (${response.status}): ${message}`);
  }
  return body;
}

async function readState(baseUrl, person, projectId) {
  return request(
    baseUrl,
    person,
    `/api/sprint?project=${encodeURIComponent(projectId)}`,
  );
}

async function isMember(baseUrl, person, projectId) {
  const body = await request(baseUrl, person, '/api/projects');
  return body.projects.some((project) => project.id === projectId);
}

async function ensureProject(baseUrl) {
  const owner = PEOPLE[0];
  const listed = await request(baseUrl, owner, '/api/projects');
  const existing = listed.projects.find((project) => project.title === PROJECT.title);
  if (existing) return { projectId: existing.id, reused: true };
  const created = await request(baseUrl, owner, '/api/projects', {
    method: 'POST',
    body: { action: 'create', ...PROJECT, agreed: true },
  });
  return { projectId: created.projectId, reused: false };
}

async function ensureMember(baseUrl, projectId, person) {
  if (await isMember(baseUrl, person, projectId)) return false;
  const owner = PEOPLE[0];
  const state = await readState(baseUrl, owner, projectId);
  const invite = await request(baseUrl, owner, '/api/projects', {
    method: 'POST',
    body: {
      action: 'invite',
      projectId,
      revision: state.sprint.revision,
      email: person.email,
    },
  });
  await request(baseUrl, person, '/api/projects', {
    method: 'POST',
    body: {
      action: 'accept',
      token: invite.token,
      agreed: true,
      goalVersion: state.policy.goalVersion,
    },
  });
  return true;
}

async function ensureCurrentGoalAgreement(baseUrl, projectId, person) {
  const state = await readState(baseUrl, person, projectId);
  if (state.me.agreedGoalVersion === state.policy.goalVersion) return false;
  await request(baseUrl, person, '/api/sprint', {
    method: 'POST',
    body: {
      action: 'agreeGoal',
      projectId,
      revision: state.sprint.revision,
      goalVersion: state.policy.goalVersion,
    },
  });
  return true;
}

async function seed(baseUrl) {
  const owner = PEOPLE[0];
  const { projectId, reused } = await ensureProject(baseUrl);
  for (const person of PEOPLE.slice(1)) await ensureMember(baseUrl, projectId, person);
  for (const person of PEOPLE) await ensureCurrentGoalAgreement(baseUrl, projectId, person);

  let state = await readState(baseUrl, owner, projectId);
  if (state.lifecycle === 'draft') {
    state = await request(baseUrl, owner, '/api/sprint', {
      method: 'POST',
      body: {
        action: 'start',
        projectId,
        revision: state.sprint.revision,
      },
    });
  }
  if (state.lifecycle !== 'active')
    throw new Error(`시드 프로젝트가 진행 상태가 아닙니다: ${state.lifecycle}`);
  if (state.members.length !== PEOPLE.length)
    throw new Error(`가상 팀원 수가 ${PEOPLE.length}명이 아닙니다: ${state.members.length}명`);
  for (const person of PEOPLE) {
    if (!(await isMember(baseUrl, person, projectId)))
      throw new Error(`${person.name} 계정에서 시드 프로젝트를 조회할 수 없습니다.`);
  }
  return { projectId, reused, state };
}

function printResult(baseUrl, result) {
  console.log(`ProjectMate 개발 시드 완료 (${result.reused ? '기존 프로젝트 재사용' : '새 프로젝트 생성'})`);
  console.log(`base URL: ${baseUrl}`);
  console.log(`project ID: ${result.projectId}`);
  console.log(`lifecycle: ${result.state.lifecycle}`);
  console.log(`members: ${result.state.members.length}`);
  console.log('');
  console.log('브라우저 요청에 사용할 가상 인물 헤더:');
  for (const person of PEOPLE) {
    console.log(`- ${person.name} [${person.role}]`);
    console.log(`  oai-authenticated-user-id: ${person.id}`);
    console.log(`  oai-authenticated-user-email: ${person.email}`);
    console.log(`  oai-authenticated-user-full-name: ${encodeURIComponent(person.name)}`);
    console.log('  oai-authenticated-user-full-name-encoding: percent-encoded-utf-8');
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const result = await seed(options.baseUrl);
    printResult(options.baseUrl, result);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
