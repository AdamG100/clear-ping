'use client'

import { useEffect, useState } from 'react'
import type { Role } from '@/lib/security/roles'

export interface SignedIn {
  username: string
  role: Role
  /** Nobody is signed in, and changing things asks for it: offered what a viewer is. */
  guest?: boolean
}

/**
 * Who is signed in, and so what the dashboard should offer them: a viewer is
 * shown everything and offered no way to change it, and so is a visitor to a
 * ClearPing that lets anyone look but asks for sign-in to change things. Null
 * while not known, and when nobody is signed in and nothing asks for it, which
 * with sign-in off is anyone, free to change anything as before.
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
        if (!current) return
        if (status?.signedIn) setSignedIn(status.signedIn as SignedIn)
        else if (status?.changesNeedSignIn) setSignedIn({ username: 'Guest', role: 'viewer', guest: true })
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  return signedIn
}
