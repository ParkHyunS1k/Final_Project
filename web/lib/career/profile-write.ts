import { database } from '../sprint-store';
import { CareerError } from './profile';

export type ProfileWrite = {
  userId: string;
  version: number;
  id: string;
  quotaDay: string | null;
};

/** 계정별 저장을 선점하고, AI 요청만 같은 트랜잭션에서 한도를 예약한다. */
export async function claimProfileWrite(
  userId: string,
  version: number,
  ai: boolean,
): Promise<ProfileWrite> {
  const db = database();
  const id = crypto.randomUUID();
  const results = await db.batch<{ day: string }>([
    // 첫 저장도 직렬화한다. 잠금을 얻은 뒤 다음 문장에서 최신 프로필 버전을 읽는다.
    // 한 문장 안의 하위 쿼리는 잠금 대기 이전 스냅샷을 볼 수 있으므로 분리한다.
    db
      .prepare(
        'INSERT INTO career_profile_writes(user_id) VALUES(?) ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id',
      )
      .bind(userId),
    // 모델 제한 55초와 라우트 제한 90초보다 길게 두고, 중단된 요청은 자동 만료한다.
    db
      .prepare(`UPDATE career_profile_writes
      SET claim_id=?, expires_at=clock_timestamp()+interval '120 seconds'
      WHERE user_id=? AND (claim_id IS NULL OR expires_at<=clock_timestamp())
      AND COALESCE((SELECT version FROM career_profiles WHERE user_id=?),0)=?`)
      .bind(id, userId, userId, version),
    db
      .prepare(`INSERT INTO career_ai_quota(user_id,day,n)
      SELECT user_id,(clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,1
      FROM career_profile_writes WHERE user_id=? AND claim_id=? AND ?
      ON CONFLICT(user_id,day) DO UPDATE SET n=career_ai_quota.n+1
      WHERE career_ai_quota.n<10 RETURNING day`)
      .bind(userId, id, ai),
  ]);
  if (results[1].meta.changes !== 1)
    throw new CareerError(
      '프로필을 다른 화면에서 저장 중이거나 이미 변경했습니다. 잠시 후 새로고침하고 다시 저장해주세요.',
      409,
    );
  const claim = {
    userId,
    version,
    id,
    quotaDay: results[2].results[0]?.day ?? null,
  };
  if (ai && !claim.quotaDay) {
    await releaseProfileWrite(claim);
    throw new CareerError(
      '오늘의 이력서 AI 분석 10회를 모두 사용했습니다. 기본 추출은 계속 사용할 수 있습니다.',
      429,
    );
  }
  return claim;
}

/** 요청 실패 때만 한도를 돌려준다. 만료 후 다른 요청의 선점은 해제하지 않는다. */
export async function releaseProfileWrite(claim: ProfileWrite, refund = false) {
  const db = database();
  await db.batch([
    db
      .prepare(
        'SELECT user_id FROM career_profile_writes WHERE user_id=? FOR UPDATE',
      )
      .bind(claim.userId),
    db
      .prepare(
        'UPDATE career_ai_quota SET n=n-1 WHERE user_id=? AND day=? AND n>0 AND ?',
      )
      .bind(claim.userId, claim.quotaDay, refund),
    db
      .prepare(
        'UPDATE career_profile_writes SET claim_id=NULL,expires_at=NULL WHERE user_id=? AND claim_id=?',
      )
      .bind(claim.userId, claim.id),
  ]);
}
