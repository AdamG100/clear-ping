import type { Metadata } from 'next'
import { UpgradeScreen } from '../_components/shell/upgrade-screen'

export const metadata: Metadata = { title: 'ClearPing — Starting up' }

/**
 * Shown in place of any page while the database is being opened, and brought
 * up to date after an upgrade. The proxy sends every page here until it is.
 */
export default function UpgradingPage() {
  return <UpgradeScreen />
}
