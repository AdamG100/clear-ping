import { notFound } from 'next/navigation'
import { Dashboard } from '@/app/_components/dashboard/dashboard'
import { pageFromPath } from '@/lib/dashboard-pages'

/**
 * The dashboard, opened at the form for adding a monitor (/monitors/new) or
 * for editing one (/monitors/<id>/edit): see dashboard-pages.
 */
export default async function Page({ params }: PageProps<'/monitors/[...path]'>) {
  const { path } = await params
  if (!pageFromPath(`/monitors/${path.join('/')}`)) notFound()
  return <Dashboard />
}
