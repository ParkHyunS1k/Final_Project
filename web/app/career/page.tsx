import { redirect } from 'next/navigation';
import { appDestination, type AppParams } from '@/lib/app-navigation';

export const metadata = {
  title: 'CareerFlow × ProjectMate · 경험에서 다음 프로젝트로',
};
export default async function CareerPage({
  searchParams,
}: {
  searchParams: Promise<AppParams>;
}) {
  const params = await searchParams;
  redirect(appDestination(params, params.project ? 'team' : 'profile'));
}
