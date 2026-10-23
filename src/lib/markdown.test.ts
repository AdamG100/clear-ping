import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and lists', () => {
    const blocks = parseMarkdown('## New\n\n### Chart the range\n\nIt spans\nthe range.\n\n- one\n- two\n  more\n\nAfter.')

    expect(blocks).toEqual([
      { kind: 'heading', level: 2, content: [{ kind: 'text', text: 'New' }] },
      { kind: 'heading', level: 3, content: [{ kind: 'text', text: 'Chart the range' }] },
      { kind: 'paragraph', content: [{ kind: 'text', text: 'It spans the range.' }] },
      { kind: 'list', items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two more' }]] },
      { kind: 'paragraph', content: [{ kind: 'text', text: 'After.' }] },
    ])
  })

  it('ends a paragraph where a list starts without a blank line', () => {
    expect(parseMarkdown('Three things:\n- a\n- b').map(block => block.kind)).toEqual(['paragraph', 'list'])
  })
})

describe('parseInline', () => {
  it('picks out code, bold and links', () => {
    expect(parseInline('Run `docker compose pull`, **then** see [the docs](https://example.com/d).')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'docker compose pull' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', text: 'then' },
      { kind: 'text', text: ' see ' },
      { kind: 'link', text: 'the docs', href: 'https://example.com/d' },
      { kind: 'text', text: '.' },
    ])
  })

  it('leaves a link to anywhere but the web as the text it was', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[click](javascript:alert(1))' }])
  })

  it('leaves text with nothing to pick out alone', () => {
    expect(parseInline('52 of 1,440 probes * lost')).toEqual([{ kind: 'text', text: '52 of 1,440 probes * lost' }])
  })
})
