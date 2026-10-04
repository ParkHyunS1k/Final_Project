// 이메일 전송 경계. 마감 독촉(senderFrom)은 Resend 전용으로 남아 있으나 제품에서 쓰지 않는다(2026-10-04).
// 초대 링크 메일은 inviteSender(Gmail SMTP)로 보낸다. 자격 정보가 없으면 보내지 않는다.
import nodemailer from 'nodemailer';
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

/**
 * 초대 링크 메일 전송기(Gmail SMTP). 제공자·발신 주소·앱 비밀번호가 모두 있을 때만 만들고,
 * 없으면 null(보내지 않음). 마감 독촉의 senderFrom과 분리해 Gmail 설정이 독촉 발송을 켜지 않게 한다.
 */
export function inviteSender(env: EmailEnv): Sender | null {
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const from = (env.EMAIL_FROM ?? '').trim();
  // Google은 앱 비밀번호를 4자리씩 띄워 보여준다.
  const key = (env.EMAIL_API_KEY ?? '').replace(/\s+/g, '');
  if (provider !== 'gmail' || !from || !key) return null;
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass: key },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  return {
    name: 'gmail',
    live: true,
    async send(m) {
      try {
        const info = await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
        return { status: 'sent', provider: 'gmail', messageId: info.messageId ?? null };
      } catch (e) {
        // 비밀번호·본문이 섞일 수 있는 원문 대신 오류 코드만 남긴다.
        const code = (e as { code?: unknown }).code;
        return { status: 'failed', provider: 'gmail', error: typeof code === 'string' ? code : 'error' };
      }
    },
  };
}
