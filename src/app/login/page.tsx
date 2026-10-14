import type { Metadata } from 'next'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in — ClearPing' }

/**
 * Where to go once signed in: a path on this site and nothing else, or a
 * link to this page could send whoever signs in through it somewhere else.
 */
function safeNext(next: string | string[] | undefined): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/'
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>
}) {
  const { next, error } = await searchParams
  // Why single sign-on did not work, as the way back from the provider put it.
  return <LoginForm next={safeNext(next)} initialError={typeof error === 'string' ? error.slice(0, 300) : null} />
}
