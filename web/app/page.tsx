import { LandingPage } from '@/components/landing-page';
import { redirect } from 'next/navigation';
import { appDestination } from '@/lib/app-navigation';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // 이미 보낸 프로젝트·초대·알림 링크(/?project=…)는 계속 작업 공간으로 연다.
  if (
    params.project ||
    params.invite ||
    params.view ||
    params.teams ||
    params.create
  )
    redirect(appDestination(params, 'work'));
  return <LandingPage />;
}
