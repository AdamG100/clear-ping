import { afterEach, describe, expect, it } from 'vitest'
import { databaseFailed, databaseOpeningAgain } from '@/lib/db/upgrade-progress'
import { GET } from './route'

afterEach(() => databaseOpeningAgain())

describe('GET /api/upgrade', () => {
  it('says the database failed, but not why, which can name paths on the server', async () => {
    databaseFailed('unable to open database file /srv/secret/place/clearping.db')
    const told = await GET().json()
    expect(told.phase).toBe('failed')
    expect(JSON.stringify(told)).not.toContain('/srv/secret')
  })
})
