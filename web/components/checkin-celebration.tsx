'use client';

import { useEffect, useRef } from 'react';

// 진행 보고 저장 직후 재생하는 4초 축하 영상. 사람만 다른 같은 장면 6개 중 하나를 고른다(6번은 무표정 포니테일).
export const CELEBRATIONS = [1, 2, 3, 4, 5, 6].map((n) => `/checkin/${n}.mp4`);

export function celebrationFor(
  action: string,
  reducedMotion: boolean,
  rand: number,
): string | null {
  if (action !== 'checkin' || reducedMotion) return null;
  return CELEBRATIONS[Math.floor(rand * CELEBRATIONS.length)];
}

export function CheckinCelebration({
  src,
  onDone,
}: {
  src: string;
  onDone: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const d = dialog.current;
    const v = video.current;
    if (!d || !v) return;
    if (!d.open) d.showModal();
    // React는 muted를 속성으로만 넣어서 자동 재생이 막힐 수 있다. 직접 켜고 재생한다.
    v.muted = true;
    v.play().catch(() => d.close());
  }, []);
  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      className="celebration-dialog"
      aria-label="진행 보고 완료"
      onClose={onDone}
    >
      <button type="button" aria-label="닫기" onClick={close}>
        <video
          ref={video}
          src={src}
          autoPlay
          muted
          playsInline
          onEnded={close}
          onError={close}
        />
      </button>
    </dialog>
  );
}
