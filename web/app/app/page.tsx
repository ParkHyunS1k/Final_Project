import { UnifiedApp } from '@/components/unified-app';
import { type AppParams } from '@/lib/app-navigation';
import '../career/career.css';
import './app.css';
export const metadata = { title: 'ProjectMate · 경험을 만드는 나의 공간' };
export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<AppParams>;
}) {
  const params = await searchParams;
  return (
    <UnifiedApp
      key={String(params.tab) + String(params.project)}
      initialTab={typeof params.tab === 'string' ? params.tab : 'home'}
      projectId={typeof params.project === 'string' ? params.project : ''}
    />
  );
}
