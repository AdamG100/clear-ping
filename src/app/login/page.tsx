import type { Metadata } from 'next'
import { safeNext } from '@/lib/dashboard-pages'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in — ClearPing' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>
}) {
  const { next, error } = await searchParams
  // Why single sign-on did not work, as the way back from the provider put it.
  return <LoginForm next={safeNext(next)} initialError={typeof error === 'string' ? error.slice(0, 300) : null} />
}
