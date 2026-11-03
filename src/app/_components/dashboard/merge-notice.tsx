'use client'

import { useEffect, useState } from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'

/** Remembered per browser, with how many sets there were: a new one shows it again. */
const DISMISSED_KEY = 'clearping.merge-notice-dismissed'

/**
 * Says when monitors look like one monitor set up again for each probe, as
 * they had to be before a monitor could have several probes, and points to
 * where they can be merged. Nothing is merged from here.
 */
export function MergeNotice({ onReview }: { onReview: () => void }) {
  const [sets, setSets] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)

  useEffect(() => {
    let current = true
    try {
      const stored = Number(window.localStorage.getItem(DISMISSED_KEY))
      // Read once mounted: the server has no storage to read it from.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Number.isFinite(stored) && stored > 0) setDismissed(stored)
    } catch {}
    fetch('/api/targets/merge')
      .then(response => (response.ok ? response.json() : null))
      .then(data => { if (current) setSets(Array.isArray(data?.sets) ? data.sets.length : 0) })
      .catch(() => {})
    return () => { current = false }
  }, [])

  if (sets === 0 || dismissed === sets) return null

  const dismiss = () => {
    setDismissed(sets)
    try { window.localStorage.setItem(DISMISSED_KEY, String(sets)) } catch {}
  }

  return (
    <Alert tone="info" title={`${sets} ${sets === 1 ? 'monitor is' : 'monitors are'} set up once for each probe`} onDismiss={dismiss}>
      <p>
        They watch the same address from different probes. Merged, each is one monitor measured from all of them, with every
        probe&apos;s readings kept. Nothing is merged unless you ask.
      </p>
      <div className="mt-2">
        <Button size="sm" variant="secondary" onClick={onReview}>Review and merge</Button>
      </div>
    </Alert>
  )
}
