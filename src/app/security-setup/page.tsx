import type { Metadata } from 'next'
import { safeNext } from '@/lib/dashboard-pages'
import { SecuritySetup } from './security-setup'

export const metadata: Metadata = { title: 'Secure your account — ClearPing' }

/**
 * Where an account is sent when an admin requires a second factor it does
 * not have yet. Apart from the dashboard, as the sign-in page is: until it is
 * done, the dashboard and its API answer this account with nothing else.
 */
export default async function SecuritySetupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams
  return <SecuritySetup next={safeNext(next)} />
}
