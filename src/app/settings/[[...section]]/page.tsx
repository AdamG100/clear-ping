import { notFound } from 'next/navigation'
import { Dashboard } from '../../_components/monitoring/dashboard'
import { isSettingsSection } from '@/lib/dashboard-pages'

/** The dashboard, opened at Settings: /settings, or /settings/<section> (see dashboard-pages). */
export default async function Page({ params }: PageProps<'/settings/[[...section]]'>) {
  const { section } = await params
  if (section && (section.length > 1 || !isSettingsSection(section[0]))) notFound()
  return <Dashboard />
}
