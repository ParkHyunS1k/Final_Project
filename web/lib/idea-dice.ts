// 만들기 화면의 주사위 단어와 기능 범위 5단계. AI 없이 단어 조합으로 아이디어를 떠올리게 한다.

export const WORDS: readonly string[] = [
  '우산', '영수증', '지도', '냉장고', '자전거', '열쇠', '안경', '이어폰', '달력', '텀블러',
  '노트북', '택배', '쿠폰', '명함', '스티커', '화분', '거울', '시계', '의자', '가방',
  '편의점', '도서관', '카페', '지하철', '정류장', '옥상', '강의실', '헬스장', '공원', '시장',
  '놀이터', '기숙사', '주차장', '세탁소', '병원', '공항', '바다', '캠핑장', '빵집', '미용실',
  '할머니', '집사', '신입생', '이웃', '룸메이트', '알바생', '선배', '동아리', '반려견', '고양이',
  '여행자', '요리사', '작가', '운동선수', '유튜버', '사장님', '택배기사', '아기', '쌍둥이', '외국인',
  '산책', '이사', '시험', '면접', '다이어트', '독서', '중고거래', '정산', '분리수거', '출석',
  '낮잠', '야식', '등산', '청소', '저축', '투표', '헌혈', '봉사', '캠핑', '요가',
  '칭찬', '비밀', '추억', '약속', '실수', '고민', '응원', '습관', '행운', '기록',
  '소문', '선물', '사과', '걱정', '감사', '계획', '마감', '알람', '날씨', '미세먼지',
  '김밥', '라면', '커피', '떡볶이', '도시락', '레시피', '냉동식품', '과일', '치킨', '급식',
  '사진', '음악', '영화', '게임', '퀴즈', '투두리스트', '일기', '편지', '엽서', '포스터',
  '쓰레기', '전기요금', '월세', '용돈', '포인트', '영양제', '물병', '신발', '옷장', '빨래',
  '식물', '별자리', '꿈', '노래방', '버스', '택시', '엘리베이터', '계단', '신호등', '횡단보도',
  '축제', '생일', '휴가', '방학', '주말', '아침', '새벽', '퇴근', '출근', '장마',
];

export type ScopeLevel = { name: string; scope: string; criteria: string };

// 누적 단계: 3단계를 고르면 핵심 기능·MVP·테스트까지 한다.
export const SCOPE_LEVELS: readonly ScopeLevel[] = [
  {
    name: '핵심 기능',
    scope: '핵심 기능 1개가 처음부터 끝까지 동작한다',
    criteria: '핵심 기능 1개를 끊김 없이 시연할 수 있다',
  },
  {
    name: 'MVP',
    scope: '사용자가 들어와서 목적을 이루고 나가는 흐름 하나를 완성한다',
    criteria: '사용자 역할로 처음부터 끝까지 한 번에 해낼 수 있다',
  },
  {
    name: '테스트',
    scope: '팀 밖 사람 3명에게 써보게 하고 가장 큰 불편 하나를 고친다',
    criteria: '사용자 3명의 피드백과 고친 내용을 보여줄 수 있다',
  },
  {
    name: '데모',
    scope: '처음 보는 사람 앞에서 5분 안에 시연할 수 있게 다듬는다',
    criteria: '시연 영상이나 발표 자료로 전체 흐름을 보여줄 수 있다',
  },
  {
    name: '배포',
    scope: '배포해서 누구나 주소로 들어와 쓸 수 있게 한다',
    criteria: '배포 주소에서 팀 밖의 사람이 직접 써볼 수 있다',
  },
];

export const DEFAULT_LEVEL = 2;

function clampLevel(level: number) {
  return Math.min(SCOPE_LEVELS.length, Math.max(1, Math.round(level) || DEFAULT_LEVEL));
}

// 잠긴 칸은 유지하고, 나머지는 이전 단어·다른 칸 단어와 겹치지 않게 새로 뽑는다.
export function roll(
  current: readonly string[],
  locked: readonly boolean[],
  random: () => number = Math.random,
): string[] {
  const next = current.map((w, i) => (locked[i] ? w : ''));
  for (let i = 0; i < next.length; i++) {
    if (locked[i]) continue;
    let w: string;
    do w = WORDS[Math.floor(random() * WORDS.length)];
    while (w === current[i] || next.includes(w));
    next[i] = w;
  }
  return next;
}

export type CreateBody = {
  action: 'create';
  title: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  duration: 7;
  agreed: boolean;
};

export function scopeText(level: number) {
  const l = SCOPE_LEVELS[clampLevel(level) - 1];
  return `[${l.name}] ${l.scope}`;
}

export function levelOf(scope: string) {
  const name = /^\[([^\]]+)\]/.exec(scope)?.[1];
  const i = SCOPE_LEVELS.findIndex((l) => l.name === name);
  return i < 0 ? DEFAULT_LEVEL : i + 1;
}

export function createBody(input: {
  words: readonly string[];
  idea: string;
  level: number;
  agreed: boolean;
}): CreateBody {
  const idea = input.idea.trim();
  const level = clampLevel(input.level);
  return {
    action: 'create',
    title: idea ? idea.slice(0, 100) : input.words.join(' · '),
    goal: idea || `'${input.words.join('·')}' 조합에서 떠올린 서비스를 7일 안에 만든다`,
    scope: scopeText(level),
    completionCriteria: SCOPE_LEVELS[level - 1].criteria,
    duration: 7,
    agreed: input.agreed,
  };
}
