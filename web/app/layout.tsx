import type { Metadata } from 'next';
import { Geist, Geist_Mono, Noto_Sans_KR } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

// 한글 글리프는 Geist에 없어 Noto Sans KR로 이어진다. 한글 조각 파일은 미리 받지 않는다.
const notoSansKr = Noto_Sans_KR({
  variable: '--font-noto-kr',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  referrer: 'no-referrer',
  title: 'ProjectMate · 7일 완주 스프린트',
  description: '작은 팀의 7일 프로젝트 완주를 돕는 스프린트 에이전트 데모',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
