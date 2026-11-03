// 학습 확인 실제 모델. 압축(digest)은 저비용 모델, 질문·채점은 상위 모델(결정 2026-10-15).
// 변경안과 같은 서버 환경값(PROJECTMATE_LIVE_MODEL·OPENAI_API_KEY)이 있을 때만 켜진다.
// 이 파일은 process.env를 직접 읽지 않는다. route.ts가 값을 넘긴다.
import { callResponsesApi, extractOutputText, type FailureMessages } from './dev-live-model';
import {
  DATA_RULES,
  gradePrompt,
  questionPrompt,
  summarizePrompt,
  type ReviewModel,
} from './ai-review';

// 모델 이름은 환경값으로 바꿀 수 있다. 저비용 모델 이름은 운영 키로 아직 확인하지 않았다.
const DEFAULT_SUMMARY_MODEL = 'gpt-6.1-luna';
const DEFAULT_REVIEW_MODEL = 'gpt-6.1-sol';
const DEFAULT_EFFORT = 'low';
// 한 단계 호출의 제한 시간. start는 압축+질문 두 번을 부르므로 route maxDuration(90초) 안에 둔다.
const STEP_TIMEOUT_MS = 40_000;

const MESSAGES: FailureMessages = {
  timeout: 'AI 응답이 늦어 중단했습니다. 잠시 후 다시 시도해주세요.',
  busy: 'AI 서비스가 바빠 학습 확인을 만들지 못했습니다. 잠시 후 다시 시도해주세요.',
  failed: 'AI 학습 확인을 만들지 못했습니다. 설정 문제일 수 있으니 팀장에게 알려주세요.',
};

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { digest: { type: 'string' } },
  required: ['digest'],
  additionalProperties: false,
};
const QUESTION_SCHEMA = {
  type: 'object',
  properties: { questions: { type: 'array', items: { type: 'string' } } },
  required: ['questions'],
  additionalProperties: false,
};
const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    feedback: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['ok', 'partial', 'missing'] },
          comment: { type: 'string' },
        },
        required: ['id', 'verdict', 'comment'],
        additionalProperties: false,
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['feedback', 'gaps'],
  additionalProperties: false,
};

export type ReviewLiveOptions = {
  apiKey: string;
  summaryModel?: string;
  reviewModel?: string;
  effort?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

async function ask(
  options: ReviewLiveOptions,
  model: string,
  schemaName: string,
  schema: Record<string, unknown>,
  input: string,
): Promise<unknown> {
  const raw = await callResponsesApi(
    options.apiKey,
    model,
    options.effort || DEFAULT_EFFORT,
    input,
    options.timeoutMs ?? STEP_TIMEOUT_MS,
    { instructions: DATA_RULES, schemaName, schema },
    MESSAGES,
    options.fetchImpl,
  );
  if (raw.status !== 'completed') throw new Error(MESSAGES.failed);
  const { text, refusal, usedTools } = extractOutputText(raw);
  if (refusal || usedTools.length || !text) throw new Error(MESSAGES.failed);
  // 사용량은 서버 로그에만 남긴다(비용 측정용). 응답 본문은 남기지 않는다.
  const usage = raw.usage as Record<string, unknown> | undefined;
  if (usage) console.info('learning review usage', model, schemaName, usage.input_tokens, usage.output_tokens);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(MESSAGES.failed);
  }
}

export function reviewLiveModel(options: ReviewLiveOptions): ReviewModel {
  const summaryModel = options.summaryModel || DEFAULT_SUMMARY_MODEL;
  const reviewModel = options.reviewModel || DEFAULT_REVIEW_MODEL;
  return {
    name: `live:${summaryModel}+${reviewModel}`,
    live: true,
    async summarize(material) {
      const out = (await ask(options, summaryModel, 'projectmate_review_digest', SUMMARY_SCHEMA, summarizePrompt(material))) as {
        digest?: unknown;
      };
      return out?.digest as string;
    },
    questions(input) {
      return ask(options, reviewModel, 'projectmate_review_questions', QUESTION_SCHEMA, questionPrompt(input));
    },
    grade(input) {
      return ask(options, reviewModel, 'projectmate_review_grade', GRADE_SCHEMA, gradePrompt(input));
    },
  };
}

/** 변경안과 같은 플래그·키가 있을 때만 실제 모델. 아니면 null(→ 준비 중). */
export function reviewModelFromEnv(env: Record<string, string | undefined>): ReviewModel | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!env.PROJECTMATE_LIVE_MODEL || !apiKey) return null;
  return reviewLiveModel({
    apiKey,
    summaryModel: env.PROJECTMATE_REVIEW_SUMMARY_MODEL,
    reviewModel: env.PROJECTMATE_REVIEW_MODEL,
    effort: env.PROJECTMATE_REASONING_EFFORT,
  });
}
