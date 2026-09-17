// 이메일 전송 경계. 제공자는 아직 선정하지 않았다(B4 대기).
// 운영 자격 정보가 없으면 기록만 남기는 전송기를 쓰고 운영 발송으로 표시하지 않는다.
export type Message = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};
export type SendResult =
  | { status: 'sent'; provider: string; messageId: string | null }
  | { status: 'failed'; provider: string; error: string }
  // 제공자가 접수했는지 불명확한 응답. 무조건 재발송하지 않는다.
  | { status: 'unknown'; provider: string; error: string };
export type Sender = {
  name: string;
  live: boolean;
  send(message: Message): Promise<SendResult>;
};

/** 실제로 메일을 보내지 않는 전송기. 예약·묶음·중복 처리 검증에만 쓴다. */
export function recordingSender(log: Message[] = []): Sender & {
  log: Message[];
} {
  return {
    name: 'recording',
    live: false,
    log,
    async send(message) {
      log.push(message);
      return { status: 'sent', provider: 'recording', messageId: null };
    },
  };
}

export type EmailEnv = {
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
};

/**
 * 현재 지원하는 운영 제공자는 Resend 하나다. 제공자·발신 주소·API 키가
 * 모두 환경 변수로 주어질 때만 실제 발송을 시도한다. 비밀값은 저장소·로그·UI에
 * 남기지 않고 환경에서만 읽는다.
 */
export function senderFrom(env: EmailEnv): Sender {
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const key = (env.EMAIL_API_KEY ?? '').trim();
  const from = (env.EMAIL_FROM ?? '').trim();
  if (provider !== 'resend' || !key || !from) return recordingSender();
  return {
    name: 'resend',
    live: true,
    async send(message) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            // 같은 묶음의 재시도는 같은 식별자를 써서 제공자 쪽 중복을 막는다.
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          id?: string;
          message?: string;
        };
        if (res.ok) return { status: 'sent', provider: 'resend', messageId: body.id ?? null };
        // 4xx는 확실한 거절, 5xx는 접수 여부가 불명확하다.
        if (res.status >= 400 && res.status < 500)
          return {
            status: 'failed',
            provider: 'resend',
            error: `${res.status} ${body.message ?? ''}`.trim(),
          };
        return {
          status: 'unknown',
          provider: 'resend',
          error: `${res.status} ${body.message ?? ''}`.trim(),
        };
      } catch (e) {
        return {
          status: 'unknown',
          provider: 'resend',
          error: e instanceof Error ? e.message : 'network error',
        };
      }
    },
  };
}
