// 저장된 실제 AI 평가 응답 4건을 화면 재생용 fixture로 고정한다.
// 응답은 결과 파일의 response를 그대로 옮기고, 원본 경로와 해시를 함께 기록한다.
// 생성 시각을 넣지 않으므로 같은 원본에서는 항상 같은 파일이 나온다.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, '..');
const candidatePath = 'datasets/github-role-division-candidates-v1/candidates.jsonl';
const selections = [
  ['sol-low', 'GH-TL-1114781787'],
  ['luna-low', 'GH-TL-1125100581'],
  ['luna-low', 'GH-TL-4880873604'],
  ['sol-low', 'GH-TL-5210407787'],
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function check(condition, message) {
  if (!condition) throw new Error(message);
}

const lines = readFileSync(join(root, candidatePath), 'utf8')
  .split('\n')
  .filter(Boolean);

const cases = selections.map(([variant, caseId]) => {
  const resultPath = `evals/github-role-division-2026-09-11/results/${variant}/${caseId}.json`;
  const resultText = readFileSync(join(root, resultPath), 'utf8');
  const run = JSON.parse(resultText);
  const line = lines.find((l) => JSON.parse(l).id === caseId);
  check(line, `${caseId}: 입력 사례가 없습니다.`);
  const candidate = JSON.parse(line);
  check(run.status === 'success', `${caseId}: 성공한 응답이 아닙니다.`);
  check(run.response?.id === caseId, `${caseId}: 응답 ID가 다릅니다.`);
  check(candidate.id === caseId, `${caseId}: 입력 ID가 다릅니다.`);
  check(Array.isArray(candidate.input.excerpts), `${caseId}: 발췌가 없습니다.`);
  check(
    Array.isArray(candidate.input.prior_project_state?.tasks),
    `${caseId}: 업무 목록이 없습니다.`,
  );
  return {
    caseId,
    variant,
    model: run.model_requested,
    reasoningEffort: run.reasoning_effort,
    startedAt: run.started_at,
    thread: { title: candidate.input.thread_title_as_of, url: candidate.input.thread_url },
    excerpts: candidate.input.excerpts.map((e, index) => ({
      index,
      text: e.text,
      authorLogin: e.author_login,
      createdAt: e.created_at,
      sourceUrl: e.source_url,
    })),
    tasks: candidate.input.prior_project_state.tasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      state: t.state,
      closed_reason: t.closed_reason,
      assignees: t.assignees,
    })),
    members: candidate.input.member_directory.logins,
    response: run.response,
    provenance: {
      resultPath,
      resultSha256: sha256(resultText),
      candidatePath,
      candidateLineSha256: sha256(line),
    },
  };
});

const out = join(web, 'fixtures/change-review-replays.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schemaVersion: 1, cases }, null, 2) + '\n');
console.log(`${cases.length}건 → ${relative(root, out)}`);
