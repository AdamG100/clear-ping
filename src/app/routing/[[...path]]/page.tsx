import { notFound } from 'next/navigation'
import { Dashboard } from '@/app/_components/dashboard/dashboard'

/** The dashboard, opened at BGP monitoring: /routing, or /routing/<prefix id> (see dashboard-pages). */
export default async function Page({ params }: PageProps<'/routing/[[...path]]'>) {
  const { path } = await params
  if (path && path.length > 1) notFound()
  return <Dashboard />
}
