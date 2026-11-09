// Shared vocabulary for resume evidence, goals, templates and project tasks.
// These are curated learning examples, not live recruitment listings.
import { SCOPE_LEVELS } from '../idea-dice.ts';
export const SKILLS = [
  { id: 'python', name: 'Python', aliases: ['Python', '파이썬'] },
  { id: 'sql', name: 'SQL', aliases: ['SQL', 'PostgreSQL', 'SQLite', 'MySQL'] },
  {
    id: 'api',
    name: 'API 개발',
    aliases: [
      'FastAPI',
      'REST API',
      'API 개발',
      'API 구현',
      'Spring',
      'Express',
    ],
  },
  {
    id: 'rag',
    name: 'RAG·검색',
    aliases: ['RAG', 'LangChain', '검색 증강', '벡터 검색'],
  },
  {
    id: 'ml',
    name: '머신러닝',
    aliases: ['머신러닝', 'PyTorch', 'scikit-learn', '모델 학습'],
  },
  {
    id: 'evaluation',
    name: '품질 평가',
    aliases: ['품질 평가', '검색 평가', '평가셋', '모델 평가'],
  },
  { id: 'docker', name: 'Docker', aliases: ['Docker', '도커', '컨테이너'] },
  {
    id: 'deploy',
    name: '배포·운영',
    aliases: ['AWS', '배포', 'CI/CD', 'Vercel', '모니터링'],
  },
  { id: 'react', name: 'React', aliases: ['React', '리액트', 'Next.js'] },
  {
    id: 'typescript',
    name: 'TypeScript',
    aliases: ['TypeScript', '타입스크립트'],
  },
  {
    id: 'testing',
    name: '테스트',
    aliases: ['테스트', 'pytest', 'Playwright', '단위 검증'],
  },
  {
    id: 'analysis',
    name: '데이터 분석',
    aliases: ['데이터 분석', 'pandas', '통계 분석'],
  },
  {
    id: 'visualization',
    name: '데이터 시각화',
    aliases: ['시각화', '대시보드', 'Tableau', 'Power BI'],
  },
  {
    id: 'design',
    name: 'UI·UX 설계',
    aliases: ['Figma', 'UI 설계', 'UX', '와이어프레임'],
  },
  {
    id: 'research',
    name: '사용자 검증',
    aliases: ['사용자 인터뷰', '사용성 테스트', '사용자 검증'],
  },
  {
    id: 'planning',
    name: '요구사항·기획',
    aliases: ['요구사항', '서비스 기획', '기능 명세', '제품 기획'],
  },
  {
    id: 'documentation',
    name: '기술 문서화',
    aliases: ['문서화', 'README', '기술 문서', '실행 방법'],
  },
  {
    id: 'git',
    name: 'Git 협업',
    aliases: ['Git', 'GitHub', '코드 리뷰', 'PR 리뷰'],
  },
] as const;
export type SkillId = (typeof SKILLS)[number]['id'];
export const skillName = (id: string) =>
  SKILLS.find((s) => s.id === id)?.name ?? id;
export const isSkill = (id: unknown): id is SkillId =>
  SKILLS.some((s) => s.id === id);
export const ROLES = [
  { id: 'ai', name: 'AI·검색 개발' },
  { id: 'backend', name: '백엔드 개발' },
  { id: 'frontend', name: '프론트엔드 개발' },
  { id: 'data', name: '데이터 분석' },
  { id: 'design', name: '기획·디자인' },
  { id: 'delivery', name: '배포·품질 검증' },
] as const;
export type RoleId = (typeof ROLES)[number]['id'];
export const roleName = (id: string) =>
  ROLES.find((r) => r.id === id)?.name ?? id;
export const TARGETS: { id: string; name: string; skills: SkillId[] }[] = [
  {
    id: 'ai-engineer',
    name: 'AI 서비스 개발',
    skills: ['python', 'api', 'rag', 'evaluation', 'docker', 'deploy'],
  },
  {
    id: 'backend',
    name: '백엔드 개발',
    skills: ['api', 'sql', 'testing', 'docker', 'deploy'],
  },
  {
    id: 'frontend',
    name: '프론트엔드 개발',
    skills: ['react', 'typescript', 'api', 'testing', 'design'],
  },
  {
    id: 'data',
    name: '데이터 분석',
    skills: ['python', 'sql', 'analysis', 'visualization', 'documentation'],
  },
  {
    id: 'product',
    name: '서비스 기획·디자인',
    skills: ['planning', 'research', 'design', 'analysis'],
  },
];
export type TemplateTask = {
  key: string;
  title: string;
  role: RoleId;
  hours: number;
  skills: SkillId[];
  dependsOn: string[];
  evidence: string;
};
export type ProjectTemplate = {
  id: string;
  version: number;
  title: string;
  goal: string;
  scope: string;
  deliverables: string[];
  criteria: string;
  roles: { id: RoleId; skills: SkillId[] }[];
  tasks: TemplateTask[];
};
export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'search-api',
    version: 1,
    title: '문서 검색 API, 배포까지',
    goal: '작은 문서 모음에서 출처와 함께 답을 찾는 검색 서비스를 7일 안에 만든다.',
    scope:
      '텍스트 문서 10개 이내, 검색 API, 검색 화면, 컨테이너 실행. OCR·대용량 수집은 포함하지 않는다.',
    deliverables: [
      '출처를 표시하는 검색 서비스',
      '컨테이너 실행 방법과 검증 기록',
      '팀원별 기여와 데모',
    ],
    criteria:
      '팀이 준비한 질문 10개를 실행해 출처 표시·오류 처리를 확인하고, 다른 팀원이 문서대로 실행한다.',
    roles: [
      { id: 'ai', skills: ['python', 'rag', 'api'] },
      { id: 'frontend', skills: ['react', 'design'] },
      { id: 'delivery', skills: ['docker', 'testing', 'deploy'] },
    ],
    tasks: [
      {
        key: 'search',
        title: '문서 검색 API 구현',
        role: 'ai',
        hours: 10,
        skills: ['python', 'rag', 'api'],
        dependsOn: [],
        evidence: 'API 코드·실행 요청과 응답·본인이 구현한 부분',
      },
      {
        key: 'ui',
        title: '검색 화면과 API 연동',
        role: 'frontend',
        hours: 8,
        skills: ['react', 'api'],
        dependsOn: ['search'],
        evidence: '화면 코드·검색 시연·본인 기여',
      },
      {
        key: 'eval',
        title: '질문 10개로 검색 품질 평가',
        role: 'ai',
        hours: 5,
        skills: ['evaluation', 'testing'],
        dependsOn: ['search'],
        evidence: '평가 질문·기대 출처·실제 결과와 한계',
      },
      {
        key: 'container',
        title: 'Docker 실행 환경 구성',
        role: 'delivery',
        hours: 6,
        skills: ['docker'],
        dependsOn: ['search'],
        evidence: 'Dockerfile·실행 명령·재현 결과',
      },
      {
        key: 'release',
        title: '통합 실행 검증과 배포 문서',
        role: 'delivery',
        hours: 5,
        skills: ['testing', 'deploy', 'documentation'],
        dependsOn: ['ui', 'container'],
        evidence: '배포 또는 실행 기록·테스트 결과·실행 문서',
      },
    ],
  },
  {
    id: 'data-dashboard',
    version: 1,
    title: '데이터에서 의사결정까지',
    goal: '공개 데이터 하나를 분석하고 질문 3개에 답하는 대시보드를 만든다.',
    scope:
      'CSV 한 개, 지표 3개, 대시보드 한 화면. 실시간 수집·예측 모델은 제외한다.',
    deliverables: [
      '재현 가능한 데이터 정리·분석',
      '지표 대시보드',
      '해석과 한계·기여 보고서',
    ],
    criteria:
      '원본에서 지표를 다시 계산할 수 있고, 대시보드의 숫자가 분석 결과와 일치한다.',
    roles: [
      { id: 'data', skills: ['python', 'sql', 'analysis'] },
      { id: 'frontend', skills: ['react', 'visualization'] },
      { id: 'design', skills: ['planning', 'documentation'] },
    ],
    tasks: [
      {
        key: 'questions',
        title: '분석 질문과 지표 정의',
        role: 'design',
        hours: 4,
        skills: ['planning', 'documentation'],
        dependsOn: [],
        evidence: '질문·지표 정의서와 선택 이유',
      },
      {
        key: 'clean',
        title: '데이터 정리와 SQL 지표 계산',
        role: 'data',
        hours: 8,
        skills: ['python', 'sql', 'analysis'],
        dependsOn: ['questions'],
        evidence: '정리 코드·SQL·결측값 처리 기록',
      },
      {
        key: 'charts',
        title: '지표 대시보드 구현',
        role: 'frontend',
        hours: 8,
        skills: ['react', 'visualization'],
        dependsOn: ['clean'],
        evidence: '대시보드 코드와 화면·지표 대조 기록',
      },
      {
        key: 'report',
        title: '분석 해석과 한계 문서화',
        role: 'data',
        hours: 4,
        skills: ['analysis', 'documentation'],
        dependsOn: ['clean'],
        evidence: '분석 보고서·한계·본인 기여',
      },
      {
        key: 'review',
        title: '대시보드 사용 흐름 검증',
        role: 'design',
        hours: 4,
        skills: ['research', 'testing'],
        dependsOn: ['charts'],
        evidence: '검증 시나리오·관찰 결과·개선점',
      },
    ],
  },
  {
    id: 'feedback-service',
    version: 1,
    title: '사용자 피드백 수집 서비스',
    goal: '피드백을 제출하고 팀이 분류할 수 있는 작은 웹 서비스를 만든다.',
    scope:
      '피드백 입력·목록·분류, 테스트 계정. 결제·알림·공개 회원가입은 제외한다.',
    deliverables: [
      '피드백 제출·분류 서비스',
      '사용 흐름 검증 기록',
      '실행 문서와 개인 기여',
    ],
    criteria:
      '제출한 내용이 재조회되고 잘못된 입력을 거절하며, 팀 밖의 테스트 사용자 1명이 흐름을 수행한다.',
    roles: [
      { id: 'backend', skills: ['api', 'sql'] },
      { id: 'frontend', skills: ['react', 'typescript'] },
      { id: 'design', skills: ['planning', 'design', 'research'] },
    ],
    tasks: [
      {
        key: 'flow',
        title: '사용 흐름과 화면 설계',
        role: 'design',
        hours: 5,
        skills: ['planning', 'design'],
        dependsOn: [],
        evidence: '화면 설계·기능 정의·본인 기여',
      },
      {
        key: 'api',
        title: '피드백 저장·조회 API',
        role: 'backend',
        hours: 8,
        skills: ['api', 'sql'],
        dependsOn: ['flow'],
        evidence: 'API와 저장 구조·입출력 검증',
      },
      {
        key: 'form',
        title: '피드백 입력·분류 화면',
        role: 'frontend',
        hours: 8,
        skills: ['react', 'typescript'],
        dependsOn: ['flow'],
        evidence: '화면 코드·입력 오류 처리·시연',
      },
      {
        key: 'test',
        title: 'API 통합 테스트',
        role: 'backend',
        hours: 4,
        skills: ['testing', 'api'],
        dependsOn: ['api', 'form'],
        evidence: '정상·오류 시나리오와 테스트 결과',
      },
      {
        key: 'users',
        title: '사용자 검증과 개선 기록',
        role: 'design',
        hours: 5,
        skills: ['research', 'documentation'],
        dependsOn: ['form', 'api'],
        evidence: '동의받은 테스트 관찰·개선 기록',
      },
    ],
  },
  {
    id: 'quality-lab',
    version: 1,
    title: '검색 품질 평가 실험실',
    goal: '작은 검색 예제를 같은 질문으로 비교하고 개선 근거를 보여준다.',
    scope:
      '문서 10개, 질문 20개, 검색 방식 2개. 모델 학습·범용 벤치마크는 제외한다.',
    deliverables: ['평가 질문과 기준', '재현 가능한 검색 비교', '평가 리포트'],
    criteria:
      '동일 데이터·질문·기준으로 비교하고 개선되지 않은 사례도 보고한다.',
    roles: [
      { id: 'ai', skills: ['python', 'rag'] },
      { id: 'data', skills: ['analysis', 'evaluation'] },
    ],
    tasks: [
      {
        key: 'set',
        title: '질문과 평가 기준 만들기',
        role: 'data',
        hours: 6,
        skills: ['evaluation', 'documentation'],
        dependsOn: [],
        evidence: '질문·기대 결과·평가 기준',
      },
      {
        key: 'search',
        title: '검색 방식 두 가지 구현',
        role: 'ai',
        hours: 10,
        skills: ['python', 'rag'],
        dependsOn: [],
        evidence: '비교 구현·설정·실행 코드',
      },
      {
        key: 'measure',
        title: '검색 결과 측정과 오류 분석',
        role: 'data',
        hours: 6,
        skills: ['analysis', 'evaluation'],
        dependsOn: ['set', 'search'],
        evidence: '측정 원본·오류 사례·분석',
      },
      {
        key: 'reproduce',
        title: '실험 재현 테스트와 문서',
        role: 'ai',
        hours: 4,
        skills: ['testing', 'documentation'],
        dependsOn: ['measure'],
        evidence: '재현 명령·테스트 결과·본인 기여',
      },
    ],
  },
  {
    id: 'tested-api',
    version: 1,
    title: '테스트 가능한 작은 백엔드',
    goal: '할 일 API를 데이터 저장부터 테스트·컨테이너 실행까지 연결한다.',
    scope:
      '할 일 생성·조회·완료 API, 작은 DB, 테스트. 공개 인증·결제는 제외한다.',
    deliverables: [
      '저장되는 할 일 API',
      '자동 테스트와 컨테이너 실행',
      'API 문서·개인 기여',
    ],
    criteria:
      '새 실행에서도 데이터가 유지되고 정상·오류 요청 테스트를 통과하며 다른 팀원이 실행한다.',
    roles: [
      { id: 'backend', skills: ['api', 'sql', 'python'] },
      { id: 'delivery', skills: ['testing', 'docker'] },
    ],
    tasks: [
      {
        key: 'api',
        title: '할 일 API와 데이터 저장',
        role: 'backend',
        hours: 10,
        skills: ['api', 'sql'],
        dependsOn: [],
        evidence: 'API 코드·스키마·저장 후 재조회 결과',
      },
      {
        key: 'tests',
        title: '정상·오류 요청 자동 테스트',
        role: 'delivery',
        hours: 6,
        skills: ['testing'],
        dependsOn: ['api'],
        evidence: '테스트 코드와 실행 결과',
      },
      {
        key: 'docker',
        title: 'Docker 실행 구성과 재현',
        role: 'delivery',
        hours: 6,
        skills: ['docker'],
        dependsOn: ['api'],
        evidence: '실행 설정·데이터 보존 확인·재현 기록',
      },
      {
        key: 'docs',
        title: 'API 사용법과 통합 실행 문서',
        role: 'backend',
        hours: 4,
        skills: ['documentation', 'git'],
        dependsOn: ['tests', 'docker'],
        evidence: '문서·리뷰 기록·본인 기여',
      },
    ],
  },
];
type Curated = {
  id: string;
  title: string;
  goal: string;
  role: RoleId;
  build: string;
  skills: SkillId[];
  extension: string;
  extensionSkills: SkillId[];
};
const MORE_TEMPLATES: Curated[] = [
  {
    id: 'expense-insights',
    title: '내 소비 패턴 리포트',
    goal: '가상 지출 데이터를 분석해 월별 소비 패턴을 보여준다.',
    role: 'data',
    build: '지출 CSV 정제와 카테고리별 집계',
    skills: ['python', 'sql', 'analysis'],
    extension: '소비 패턴을 설명하는 대시보드',
    extensionSkills: ['visualization'],
  },
  {
    id: 'job-tracker',
    title: '취업 지원 현황 보드',
    goal: '지원한 공고와 다음 할 일을 한 화면에서 관리한다.',
    role: 'frontend',
    build: '지원 단계별 카드와 저장 기능',
    skills: ['react', 'typescript', 'api'],
    extension: '마감일 필터와 접근성 검증',
    extensionSkills: ['testing', 'design'],
  },
  {
    id: 'study-checkin',
    title: '매일 공부 체크인',
    goal: '오늘의 공부를 기록하고 연속 학습일을 확인한다.',
    role: 'backend',
    build: '날짜별 체크인 저장 API',
    skills: ['api', 'sql'],
    extension: '주간 통계와 시간대 경계 테스트',
    extensionSkills: ['analysis', 'testing'],
  },
  {
    id: 'review-insights',
    title: '리뷰 속 불편 찾기',
    goal: '샘플 리뷰에서 자주 반복되는 불편을 찾아 시각화한다.',
    role: 'data',
    build: '샘플 리뷰 정제와 키워드 빈도 분석',
    skills: ['python', 'analysis'],
    extension: '분류 모델과 수동 평가셋 비교',
    extensionSkills: ['ml', 'evaluation'],
  },
  {
    id: 'faq-assistant',
    title: '근거 있는 FAQ 도우미',
    goal: '제공한 FAQ 안에서 출처를 붙여 질문에 답한다.',
    role: 'ai',
    build: 'FAQ 검색과 출처 반환',
    skills: ['python', 'rag', 'api'],
    extension: '답이 없는 질문을 포함한 품질 평가',
    extensionSkills: ['evaluation', 'testing'],
  },
  {
    id: 'model-comparison',
    title: '작은 모델 실험실',
    goal: '같은 공개 데이터로 모델 두 가지를 비교한다.',
    role: 'ai',
    build: '학습·검증 데이터 분리와 기준 모델',
    skills: ['python', 'ml'],
    extension: '오류 사례 분석과 비교 차트',
    extensionSkills: ['evaluation', 'visualization'],
  },
  {
    id: 'deploy-lab',
    title: '내 서비스 배포 실습',
    goal: '작은 API를 컨테이너로 실행하고 배포 절차를 재현한다.',
    role: 'delivery',
    build: '헬스 체크 API와 Docker 구성',
    skills: ['api', 'docker'],
    extension: '배포 점검과 롤백 절차',
    extensionSkills: ['deploy', 'documentation'],
  },
  {
    id: 'test-lab',
    title: '깨지지 않는 로그인 화면',
    goal: '가상 인증 흐름에서 입력 오류와 주요 화면 동작을 검증한다.',
    role: 'frontend',
    build: '로그인·오류·성공 상태 화면',
    skills: ['react', 'typescript', 'design'],
    extension: '정상·실패 시나리오 자동 테스트',
    extensionSkills: ['testing'],
  },
  {
    id: 'accessibility-kit',
    title: '접근성 있는 UI 키트',
    goal: '키보드와 화면 읽기 도구로도 이용할 수 있는 컴포넌트를 만든다.',
    role: 'frontend',
    build: '버튼·입력창·대화상자 컴포넌트',
    skills: ['react', 'typescript', 'design'],
    extension: '포커스 이동과 대비 점검',
    extensionSkills: ['testing', 'research'],
  },
  {
    id: 'onboarding-lab',
    title: '가입 경험 개선 실험',
    goal: '서비스 가입 과정의 불편을 찾아 작은 개선안을 검증한다.',
    role: 'design',
    build: '사용자 흐름 지도와 클릭형 프로토타입',
    skills: ['planning', 'design'],
    extension: '동의받은 참여자의 사용성 테스트',
    extensionSkills: ['research', 'analysis'],
  },
  {
    id: 'sql-playground',
    title: '주문 데이터 SQL 탐험',
    goal: '가상 주문 데이터에서 매출과 재구매 지표를 계산한다.',
    role: 'data',
    build: '주문 스키마와 지표 SQL 쿼리',
    skills: ['sql', 'analysis'],
    extension: '조회 성능 비교와 실행 계획 기록',
    extensionSkills: ['testing', 'documentation'],
  },
  {
    id: 'event-metrics',
    title: '서비스 지표 미니보드',
    goal: '가상 이벤트 로그로 유입부터 전환까지 보여준다.',
    role: 'data',
    build: '이벤트 정의와 퍼널 집계',
    skills: ['planning', 'sql', 'analysis'],
    extension: '기간별 비교 대시보드',
    extensionSkills: ['visualization', 'react'],
  },
  {
    id: 'team-wiki',
    title: '함께 쓰는 팀 위키',
    goal: '작은 팀이 결정 사항과 실행 방법을 찾아볼 수 있게 한다.',
    role: 'backend',
    build: '문서 작성·조회·검색 API',
    skills: ['api', 'sql'],
    extension: '문서 검색 화면과 변경 이력',
    extensionSkills: ['react', 'git'],
  },
  {
    id: 'portfolio-story',
    title: '내 프로젝트 포트폴리오',
    goal: '문제·기여·결과를 근거와 함께 읽기 쉬운 페이지로 만든다.',
    role: 'frontend',
    build: '프로젝트 사례와 기여를 담은 반응형 화면',
    skills: ['react', 'design', 'documentation'],
    extension: '배포와 사용자 피드백 반영',
    extensionSkills: ['deploy', 'research'],
  },
  {
    id: 'issue-triage',
    title: 'GitHub 이슈 분류 보드',
    goal: '샘플 이슈를 분류하고 우선순위 판단 근거를 정리한다.',
    role: 'design',
    build: '이슈 유형 분류와 우선순위 보드',
    skills: ['planning', 'git', 'analysis'],
    extension: '분류 추천과 수동 판단 비교',
    extensionSkills: ['python', 'evaluation'],
  },
];
for (const item of MORE_TEMPLATES) {
  const tasks: TemplateTask[] = [
    {
      key: 'plan',
      title: '샘플과 핵심 흐름 선택',
      role: item.role,
      hours: 2,
      skills: ['planning'],
      dependsOn: [],
      evidence: '선택한 샘플·흐름과 선택 이유',
    },
    {
      key: 'core',
      title: item.build,
      role: item.role,
      hours: 8,
      skills: item.skills,
      dependsOn: ['plan'],
      evidence: '본인 구현·분석 내용과 실행 예시',
    },
    {
      key: 'check',
      title: '핵심 흐름 검증과 기록',
      role: item.role,
      hours: 4,
      skills: ['testing', 'documentation'],
      dependsOn: ['core'],
      evidence: '정상·실패 사례와 개선 기록',
    },
    {
      key: 'extend',
      title: item.extension,
      role: item.role,
      hours: 6,
      skills: item.extensionSkills,
      dependsOn: ['check'],
      evidence: '확장 전후 비교와 구현 근거',
    },
    {
      key: 'share',
      title: '데모와 나의 기여 정리',
      role: item.role,
      hours: 3,
      skills: ['documentation', 'git'],
      dependsOn: ['extend'],
      evidence: '데모·변경 기록·배운 점',
    },
  ];
  TEMPLATES.push({
    id: item.id,
    version: 1,
    title: item.title,
    goal: item.goal,
    scope:
      '가상·공개 샘플을 사용한 작은 학습 프로젝트. 개인정보 수집과 유료 서비스 운영은 제외합니다.',
    criteria: '',
    deliverables: [],
    roles: [
      {
        id: item.role,
        skills: [...new Set([...item.skills, ...item.extensionSkills])],
      },
    ],
    tasks,
  });
}
export const SCOPE_LABELS = SCOPE_LEVELS.map((l) => l.name);
export function scopedTemplate(
  template: ProjectTemplate,
  level: number,
): ProjectTemplate {
  if (![1, 2, 3].includes(level)) throw new Error('범위는 1~3단계입니다.');
  const count =
    level === 1
      ? 2
      : level === 2
        ? Math.ceil(template.tasks.length * 0.65)
        : template.tasks.length;
  const keys = new Set(template.tasks.slice(0, count).map((t) => t.key));
  function include(key: string) {
    keys.add(key);
    for (const dependency of template.tasks.find((t) => t.key === key)
      ?.dependsOn ?? [])
      if (!keys.has(dependency)) include(dependency);
  }
  for (const key of keys) include(key);
  const tasks = template.tasks.filter((t) => keys.has(t.key));
  return {
    ...template,
    scope: `${SCOPE_LABELS[level - 1]} · ${template.scope}\n${tasks.map((t) => t.title).join(' → ')}`,
    tasks,
    roles: template.roles.filter((r) => tasks.some((t) => t.role === r.id)),
  };
}
export function templateById(id: string) {
  return TEMPLATES.find((t) => t.id === id);
}
