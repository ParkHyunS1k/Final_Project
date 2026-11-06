import { fakeModel, type Model } from './ai-extraction';
import { liveModelFromEnv } from './dev-live-model';

// Keep the test injection seam outside route.ts: Next only permits route/config exports there.
// Production selection and secret handling are unchanged.
export let model: Model = liveModelFromEnv(process.env) ?? fakeModel();
export function useModel(next: Model) {
  model = next;
}
