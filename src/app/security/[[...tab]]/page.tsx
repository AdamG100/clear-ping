import { notFound } from 'next/navigation'
import { Dashboard } from '../../_components/monitoring/dashboard'
import { isSecurityTab } from '@/lib/dashboard-pages'

/** The dashboard, opened at its security page: /security, or /security/<tab> (see dashboard-pages). */
export default async function Page({ params }: PageProps<'/security/[[...tab]]'>) {
  const { tab } = await params
  if (tab && (tab.length > 1 || !isSecurityTab(tab[0]))) notFound()
  return <Dashboard />
}
