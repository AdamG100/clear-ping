/**
 * The Markdown the patch notes are written in, read into blocks a page can
 * draw. Pure: the browser runs it.
 *
 * Only what commit messages use: headings, paragraphs, lists, `code`,
 * **bold** and [links](https://…). The result is data, drawn as React
 * elements, so nothing in a note is ever handed to the page as HTML.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string }

export type Block =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; items: Inline[][] }

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** A line's text, with its code, bold and links picked out. A link goes nowhere but the web. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    const [whole, code, strong, label, href] = match
    if (code !== undefined) out.push({ kind: 'code', text: code })
    else if (strong !== undefined) out.push({ kind: 'strong', text: strong })
    else if (/^https?:\/\//i.test(href)) out.push({ kind: 'link', text: label, href })
    else out.push({ kind: 'text', text: whole })
    last = at + whole.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })

  // A link left as text joins the text either side of it again.
  return out.reduce<Inline[]>((joined, part) => {
    const previous = joined.at(-1)
    if (previous?.kind === 'text' && part.kind === 'text') previous.text += part.text
    else joined.push(part)
    return joined
  }, [])
}

/** A document's blocks. Lines run together into a paragraph until a blank line, a heading or a list. */
export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: string[] | null = null

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) })
    if (list) blocks.push({ kind: 'list', items: list.map(parseInline) })
    paragraph = []
    list = null
  }

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = /^[-*]\s+(.*)$/.exec(line)

    if (!line) flush()
    else if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, content: parseInline(heading[2]) })
    } else if (item) {
      if (paragraph.length) flush()
      list = [...(list ?? []), item[1]]
    } else if (list && /^\s/.test(raw)) {
      // An item's text carried on to the next line.
      list[list.length - 1] += ` ${line}`
    } else {
      if (list) flush()
      paragraph.push(line)
    }
  }
  flush()
  return blocks
}
