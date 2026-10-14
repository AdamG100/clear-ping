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

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams
  return <LoginForm next={safeNext(next)} />
}
