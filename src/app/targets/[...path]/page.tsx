import { notFound } from 'next/navigation'
import { Dashboard } from '@/app/_components/dashboard/dashboard'
import { pageFromPath } from '@/lib/dashboard-pages'

/**
 * The dashboard, opened at the form for adding a target (/targets/new) or
 * for editing one (/targets/<id>/edit): see dashboard-pages.
 */
export default async function Page({ params }: PageProps<'/targets/[...path]'>) {
  const { path } = await params
  if (!pageFromPath(`/targets/${path.join('/')}`)) notFound()
  return <Dashboard />
}
