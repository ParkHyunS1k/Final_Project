// 시작 시 합의한 결과물 목록과 그 증빙·팀장 확인.
// 고정 내용(제목·순서)과 확인 이력(증빙·확인)은 분리해서 갱신한다.
// 2026-10-14부터 새 프로젝트는 결과물을 받지 않고 서버가 완료 기준 행 하나(CRITERIA_ID)만 만든다.
// 이전에 만든 결과물 프로젝트는 저장된 행을 그대로 쓴다.
import { PolicyError } from './sprint-policy.ts';

export const CRITERIA_ID = 'd_criteria';
export const CRITERIA_TITLE = '완료 기준';

export type Deliverable = {
  deliverableId: string;
  position: number;
  title: string;
  fixedAt: Date | null;
  evidence: string;
  evidenceBy: string | null;
  evidenceAt: Date | null;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: Date | null;
};

export function deliverableRow(row: Record<string, unknown>): Deliverable {
  return {
    deliverableId: String(row.deliverable_id),
    position: Number(row.position),
    title: String(row.title),
    fixedAt: (row.fixed_at as Date | null) ?? null,
    evidence: typeof row.evidence === 'string' ? row.evidence : '',
    evidenceBy: (row.evidence_by as string | null) ?? null,
    evidenceAt: (row.evidence_at as Date | null) ?? null,
    confirmed: Boolean(row.confirmed),
    confirmedBy: (row.confirmed_by as string | null) ?? null,
    confirmedAt: (row.confirmed_at as Date | null) ?? null,
  };
}

export function isCriteriaOnly(list: Deliverable[]) {
  return list.length === 1 && list[0].deliverableId === CRITERIA_ID;
}

// 완주 판정: 체크인 수·업무 수가 아니라 고정 항목(완료 기준 또는 기존 결과물)의 확인 여부만 본다.
export function completionCheck(list: Deliverable[]) {
  const missing = list.filter((d) => !d.confirmed);
  return {
    ready: list.length > 0 && !missing.length,
    total: list.length,
    confirmed: list.length - missing.length,
    missing: missing.map((d) => d.title),
    mode: (isCriteriaOnly(list) ? 'criteria' : 'deliverables') as
      | 'criteria'
      | 'deliverables',
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
