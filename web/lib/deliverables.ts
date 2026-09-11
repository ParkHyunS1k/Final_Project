// 시작 시 합의한 결과물 목록과 그 증빙·팀장 확인.
// 고정 내용(제목·순서)과 확인 이력(증빙·확인)은 분리해서 갱신한다.
import { PolicyError } from './sprint-policy';

export type Deliverable = {
  deliverableId: string;
  position: number;
  title: string;
  fixedAt: string | null;
  evidence: string;
  evidenceBy: string | null;
  evidenceAt: string | null;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
};

export function deliverableRow(row: Record<string, unknown>): Deliverable {
  return {
    deliverableId: String(row.deliverable_id),
    position: Number(row.position),
    title: String(row.title),
    fixedAt: (row.fixed_at as string | null) ?? null,
    evidence: typeof row.evidence === 'string' ? row.evidence : '',
    evidenceBy: (row.evidence_by as string | null) ?? null,
    evidenceAt: (row.evidence_at as string | null) ?? null,
    confirmed: Boolean(row.confirmed),
    confirmedBy: (row.confirmed_by as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  };
}

// 준비 중에는 제목 목록을 자유롭게 편집한다. 시작하면 이 목록이 고정된다.
export function parseDeliverables(value: unknown): string[] {
  if (typeof value !== 'string')
    throw new PolicyError('필수 결과물을 입력해주세요.');
  const list = value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length || list.length > 10 || list.some((s) => s.length > 200))
    throw new PolicyError('필수 결과물은 항목당 200자 이내, 1~10개입니다.');
  if (new Set(list).size !== list.length)
    throw new PolicyError('필수 결과물 이름이 중복됩니다.');
  return list;
}

// 완주 판정: 체크인 수·업무 수가 아니라 고정 결과물의 확인 여부만 본다.
export function completionCheck(list: Deliverable[]) {
  const missing = list.filter((d) => !d.confirmed);
  return {
    ready: list.length > 0 && !missing.length,
    total: list.length,
    confirmed: list.length - missing.length,
    missing: missing.map((d) => d.title),
  };
}

export function assertEvidence(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.trim().length < 5 ||
    value.length > 2000
  )
    throw new PolicyError(
      '결과물 근거(저장소·실행 방법·데모·기여 내용)를 5~2000자로 남겨주세요.',
    );
  return value.trim();
}
