import { fakeReviewModel, type ReviewModel } from './ai-review';
import { reviewModelFromEnv } from './ai-review-live';
import type { FetchOptions } from './ai-review-github';

export let model: ReviewModel = reviewModelFromEnv(process.env) ?? fakeReviewModel();
export let github: FetchOptions = { token: process.env.GITHUB_TOKEN?.trim() || undefined };

// 테스트 대역 설정은 라우트의 HTTP 메서드와 분리한다.
export function useReviewModel(next: ReviewModel) {
  model = next;
}
export function useGithub(next: FetchOptions) {
  github = next;
}
