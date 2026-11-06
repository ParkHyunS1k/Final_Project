import { redirect } from 'next/navigation';
import { appDestination, type AppParams } from '@/lib/app-navigation';
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<AppParams>;
}) {
  const params = await searchParams;
  redirect(appDestination(params, params.create ? 'templates' : 'work'));
}
