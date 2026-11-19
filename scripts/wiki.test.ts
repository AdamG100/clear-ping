import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The script CI makes the GitHub wiki from docs/ with.
import { pageFrom, PAGES, wikiTarget } from './wiki.mjs'

describe('wikiTarget', () => {
  it('points a link to another guide at its wiki page, keeping the heading', () => {
    expect(wikiTarget('security.md#locked-out')).toBe('Security#locked-out')
    expect(wikiTarget('./running.md')).toBe('Running-ClearPing')
  })

  it('points screenshots and other files at the repository', () => {
    expect(wikiTarget('screenshots/overview.jpg')).toBe('https://raw.githubusercontent.com/AdamG100/clear-ping/main/docs/screenshots/overview.jpg')
    expect(wikiTarget('../compose.example.yaml')).toBe('https://github.com/AdamG100/clear-ping/blob/main/compose.example.yaml')
  })

  it('leaves web addresses and headings on the same page alone', () => {
    expect(wikiTarget('https://example.net/a.md')).toBe('https://example.net/a.md')
    expect(wikiTarget('#words-used-throughout')).toBe('#words-used-throughout')
  })
})

describe('pageFrom', () => {
  it('drops the title and rewrites links outside code blocks only', () => {
    const page = pageFrom('# Alerting\n\nSee [MCP](mcp.md).\n\n```md\n[MCP](mcp.md)\n```\n')
    expect(page).toBe('See [MCP](Connecting-an-AI-Assistant).\n\n```md\n[MCP](mcp.md)\n```\n')
  })
})

it('has a wiki page for every guide', () => {
  const guides = readdirSync('docs').filter(name => name.endsWith('.md')).sort()
  expect(PAGES.map(each => each.file).sort()).toEqual(guides)
})
