import { notFound } from 'next/navigation'
import { Dashboard } from '../../_components/monitoring/dashboard'
import { pageFromPath } from '@/lib/dashboard-pages'

/**
 * The dashboard, opened at the form for a new alert (/alerts/new) or for
 * editing one (/alerts/<id>/edit): see dashboard-pages.
 */
export default async function Page({ params }: PageProps<'/alerts/[...path]'>) {
  const { path } = await params
  if (!pageFromPath(`/alerts/${path.join('/')}`)) notFound()
  return <Dashboard />
}
