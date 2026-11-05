import { notFound } from 'next/navigation'
import { Dashboard } from '@/app/_components/dashboard/dashboard'

/** The dashboard, opened at Game Server Ping: /game-ping, or /game-ping/<game> (see dashboard-pages). */
export default async function Page({ params }: PageProps<'/game-ping/[[...path]]'>) {
  const { path } = await params
  if (path && path.length > 1) notFound()
  return <Dashboard />
}
