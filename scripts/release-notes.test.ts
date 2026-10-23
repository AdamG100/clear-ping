import { describe, expect, it } from 'vitest'
// The script CI writes each release's patch notes with.
import { markdownFor, noteFor } from './release-notes.mjs'

describe('noteFor', () => {
  it('joins a wrapped body back into paragraphs, and leaves the trailers out', () => {
    const note = noteFor({
      subject: 'Chart the whole range',
      release: 'minor',
      body: 'Unzoomed, it spans the whole range picked, so 90 days\nis drawn as 90 days.\n\nThe axis is worked out once.\n\nRelease: minor\nCo-Authored-By: Someone <someone@example.com>\n',
    })

    expect(note).toEqual({
      title: 'Chart the whole range',
      kind: 'new',
      paragraphs: ['Unzoomed, it spans the whole range picked, so 90 days is drawn as 90 days.', 'The axis is worked out once.'],
    })
  })

  it('keeps list items on lines of their own', () => {
    const { paragraphs } = noteFor({ subject: 's', body: 'Three things:\n- one\n- two that\n  wraps\n' })
    expect(paragraphs).toEqual(['Three things:', '- one', '- two that wraps'])
  })

  it('files a commit by its Release trailer', () => {
    expect(noteFor({ subject: 's', body: '', release: 'major' }).kind).toBe('action')
    expect(noteFor({ subject: 's', body: '', release: 'Minor' }).kind).toBe('new')
    expect(noteFor({ subject: 's', body: '' }).kind).toBe('improved')
  })
})

describe('markdownFor', () => {
  it('puts what needs doing first, then what is new, then the rest', () => {
    const markdown = markdownFor({
      notes: [
        noteFor({ subject: 'Fix a thing', body: '' }),
        noteFor({ subject: 'Add a thing', body: 'It does it.', release: 'minor' }),
        noteFor({ subject: 'Rename a setting', body: '', release: 'major' }),
      ],
    })

    const order = ['## Before you update', '### Rename a setting', '## New', '### Add a thing', 'It does it.', '## Fixes and improvements', '### Fix a thing']
    const at = order.map(line => markdown.indexOf(line))
    expect(at.every(index => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it('says so when nothing but the number changed', () => {
    expect(markdownFor({ notes: [] })).toMatch(/Nothing but the version/)
  })
})
