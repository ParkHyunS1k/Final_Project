// 초대 링크 메일. 초대 저장(트랜잭션)이 끝난 뒤 보내고 결과만 초대 행에 기록한다.
// 발송·기록이 실패해도 초대는 그대로이며 링크는 화면에서 직접 전달할 수 있다.
import { database } from './db';
import { inviteSender, type EmailEnv, type Message, type Sender, type SendResult } from './email';

export const INVITE_SEND_LIMIT = 3;
export const DAILY_INVITE_LIMIT = 20;
export type InviteEmailStatus = 'sent' | 'failed' | 'off';
export type InviteMail = {
  inviteId: string;
  sends: number;
  to: string;
  token: string;
  origin: string;
  projectTitle: string;
  inviter: string;
  expiresAt: Date;
};

let override: Sender | null | undefined;
let timeoutMs = 15_000;
/** 테스트용 전송기(null = 설정 없음)와 제한 시간. undefined면 환경변수로 만든다. */
export function useInviteSender(next: Sender | null | undefined, timeout = 15_000) {
  override = next;
  timeoutMs = timeout;
}

/**
 * 메일 속 링크의 주소. Vercel에서는 Vercel이 알려 준 운영·브랜치 주소를 쓴다(요청의 Host를 믿지 않는다).
 * 로컬(next dev, 127.0.0.1에만 열림)에서만 요청 주소를 쓴다.
 */
export function inviteOrigin(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const deployed = env.VERCEL_ENV && (env.VERCEL_BRANCH_URL || env.VERCEL_URL);
  if (deployed) return `https://${deployed}`;
  return new URL(requestUrl).origin;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function inviteMessage(i: InviteMail): Message {
  const inviter = oneLine(i.inviter);
  const title = oneLine(i.projectTitle);
  const link = `${i.origin}/workspace?invite=${encodeURIComponent(i.token)}`;
  const until = i.expiresAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return {
    to: i.to,
    subject: `[ProjectMate] ${inviter}님이 '${title}' 팀에 초대했습니다`,
    text: [
      `${inviter}님이 ProjectMate의 '${title}' 팀에 초대했습니다.`,
      '',
      link,
      '',
      `링크 만료: ${until} (한국 시간)`,
      '초대받은 이메일의 Google 계정으로 로그인해야 수락됩니다.',
      '모르는 초대라면 이 메일을 무시하세요.',
    ].join('\n'),
    idempotencyKey: `invite:${i.inviteId}:${i.sends}`,
  };
}

export async function deliverInvite(i: InviteMail): Promise<InviteEmailStatus> {
  const sender = override === undefined ? inviteSender(process.env as EmailEnv) : override;
  let status: InviteEmailStatus = 'off';
  if (sender) {
    // 메일 서버가 응답하지 않아도 초대 요청은 제한 시간 안에 끝낸다.
    const r = await Promise.race([
      sender.send(inviteMessage(i)),
      new Promise<SendResult>((done) =>
        setTimeout(() => done({ status: 'failed', provider: sender.name, error: 'timeout' }), timeoutMs).unref(),
      ),
    ]);
    status = r.status === 'sent' ? 'sent' : 'failed';
    if (r.status !== 'sent') console.error('invite email failed', r.provider, r.error);
  }
  try {
    await database()
      .prepare('UPDATE project_invites SET email_status=? WHERE id=?')
      .bind(status, i.inviteId)
      .run();
  } catch (e) {
    // 메일은 이미 끝났다. 기록 실패로 초대 응답을 실패시키지 않는다.
    console.error('invite email status not recorded', (e as Error).message);
  }
  return status;
}
