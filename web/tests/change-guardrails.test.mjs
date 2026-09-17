// 합성 시나리오로 변경안 검증 경계를 측정한다.
// 측정 대상은 서버 가드레일이며, 모델의 해석 품질이나 실제 자동 반영 정확도가 아니다.
// 시나리오: evals/change-review/2026-09-09/scenarios.json (전부 합성, 실제 사례 아님)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// lib은 번들러 기준의 확장자 없는 상대 경로를 쓰므로 테스트에서도 같은 방식으로 묶는다.
const dir = mkdtempSync(join(tmpdir(), 'projectmate-guardrail-'));
const outfile = join(dir, 'extraction.mjs');
await build({
  entryPoints: ['lib/ai-extraction.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { validateChanges } = await import(pathToFileURL(outfile).href);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const suite = JSON.parse(
  readFileSync('../evals/change-review/2026-09-09/scenarios.json', 'utf8'),
);

function inputFor(c) {
  return {
    source: { id: 's', body: c.source },
    tasks: suite.project.tasks,
    members: suite.project.members,
    deliverables: [],
    now: suite.project.now,
    deadline: suite.project.deadline,
  };
}

// evidenceText는 원문에서 실제 위치를 찾아 근거 오프셋으로 바꾼다.
function resolve(c) {
  return c.model.map((raw) => {
    const { evidenceText, ...rest } = raw;
    if (!evidenceText) return rest;
    const start = c.source.indexOf(evidenceText);
    assert.ok(start >= 0, `${c.id}: 근거 문장을 원문에서 찾지 못했습니다.`);
    return {
      ...rest,
      evidence: { start, end: start + evidenceText.length, quote: evidenceText },
    };
  });
}

test('합성 가드레일 시나리오가 모두 기대대로 처리된다', () => {
  const report = {
    cases: suite.cases.length,
    accepted: 0,
    rejected: 0,
    flaggedForReview: 0,
    wrongTargetAccepted: 0,
    autoApplied: 0,
  };
  for (const c of suite.cases) {
    const { changes, rejected } = validateChanges(
      resolve(c),
      inputFor(c),
    );
    assert.deepEqual(
      changes.map((x) => x.changeId).sort(),
      [...c.expect.accepted].sort(),
      `${c.id} 통과 항목: ${c.why}`,
    );
    assert.deepEqual(
      rejected.map((x) => String(x.raw.changeId)).sort(),
      [...c.expect.rejected].sort(),
      `${c.id} 거절 항목: ${c.why}`,
    );
    for (const id of c.expect.needsReview) {
      const change = changes.find((x) => x.changeId === id);
      assert.ok(
        change && change.needsReview,
        `${c.id}/${id}: 확인 필요 표시가 없습니다. ${c.why}`,
      );
    }
    for (const id of c.expect.assigneeMustBeNull ?? []) {
      const change = changes.find((x) => x.changeId === id);
      assert.equal(
        change?.after.person,
        null,
        `${c.id}/${id}: 근거 없는 담당자를 배정했습니다.`,
      );
    }
    for (const [id, basis] of Object.entries(c.expect.basisMustBe ?? {})) {
      const change = changes.find((x) => x.changeId === id);
      assert.equal(change?.basis, basis, `${c.id}/${id}: 사실/추정 구분 오류`);
    }
    report.accepted += changes.length;
    report.rejected += rejected.length;
    report.flaggedForReview += changes.filter((x) => x.needsReview).length;
    report.wrongTargetAccepted += (c.expect.wrongTarget ?? []).length;
  }
  // 검증을 통과했다는 것은 "검토 대상이 되었다"는 뜻이며 적용된 것이 아니다.
  assert.equal(report.autoApplied, 0);
  assert.ok(report.cases === 12 && report.rejected >= 6, JSON.stringify(report));
  console.log('guardrail report', JSON.stringify(report));
});

test('검증 통과는 해석의 정확성을 보장하지 않는다', () => {
  // GR-08: 이름이 비슷한 다른 업무를 지목한 응답도 형식 검증은 통과한다.
  // 서버가 막을 수 있는 것은 형식·권한·범위이며, 대상 선택의 옳고 그름은 사람이 본다.
  const wrong = suite.cases.find((c) => c.id === 'GR-08');
  const { changes } = validateChanges(
    resolve(wrong),
    inputFor(wrong),
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].taskId, 1);
  assert.notEqual(changes[0].taskId, 3);
});
