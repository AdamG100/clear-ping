'use client'

import { useEffect, useState } from 'react'
import type { Role } from '@/lib/security/roles'

export interface SignedIn {
  username: string
  role: Role
}

/**
 * Who is signed in, and so what the dashboard should offer them: a viewer is
 * shown everything and offered no way to change it. Null while not known, and
 * when nobody is signed in, which with sign-in off is anyone, free to change
 * anything as before.
 *
 * Only what is offered. What each account may do is decided on the server,
 * which refuses whatever its role does not allow, whatever this says.
 */
export function useSignedIn(): SignedIn | null {
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null)

  useEffect(() => {
    let current = true
    fetch('/api/auth/status')
      .then(response => (response.ok ? response.json() : null))
      .then(status => {
        if (current && status?.signedIn) setSignedIn(status.signedIn as SignedIn)
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  return signedIn
}
