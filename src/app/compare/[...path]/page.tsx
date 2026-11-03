import { notFound } from 'next/navigation'
import { Dashboard } from '@/app/_components/dashboard/dashboard'
import { pageFromPath } from '@/lib/dashboard-pages'

/**
 * The dashboard, opened at the builder for a new comparison (/compare/new), or
 * at one saved (/compare/<id>) or being changed (/compare/<id>/edit): see
 * dashboard-pages.
 */
export default async function Page({ params }: PageProps<'/compare/[...path]'>) {
  const { path } = await params
  if (!pageFromPath(`/compare/${path.join('/')}`)) notFound()
  return <Dashboard />
}
