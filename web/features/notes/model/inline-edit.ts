import type { NoteBlock } from '@/lib/notes-api'

/**
 * Put AI-edited text back where the learner selected it.
 *
 * A selection usually covers part of one line, so the block keeps its type,
 * props and every inline run the edit did not touch — only the covered text is
 * swapped. When the selection or the model's output does not fit that shape
 * (a selection ending inside a link, or a multi-paragraph answer), the caller
 * falls back to replacing the block with parsed Markdown.
 */

type InlineItem = Record<string, unknown> & { type?: string; text?: string }

function itemText(item: InlineItem): string | null {
  if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
  if (item.type === 'link') {
    if (!Array.isArray(item.content)) return null
    let text = ''
    for (const nested of item.content as InlineItem[]) {
      const piece = itemText(nested)
      if (piece === null) return null
      text += piece
    }
    return text
  }
  return null
}

function inlineItems(content: unknown): InlineItem[] | null {
  return Array.isArray(content) ? (content as InlineItem[]) : null
}

/** A text run carrying the styles of the first run the edit replaced. */
function replacementRun(items: InlineItem[], index: number, text: string): InlineItem {
  for (let i = index; i < items.length; i += 1) {
    const item = items[i]
    if (item.type === 'text') {
      return { type: 'text', text, styles: (item.styles as object) ?? {} }
    }
  }
  return { type: 'text', text, styles: {} }
}

export function spliceSelectedText(
  block: NoteBlock,
  selected: string,
  edited: string
): NoteBlock[] | null {
  const items = inlineItems(block.content)
  if (!items || !selected) return null

  const text = items.map(item => itemText(item)).reduce<string | null>(
    (all, piece) => (all === null || piece === null ? null : all + piece),
    ''
  )
  if (text === null) return null

  const at = text.indexOf(selected)
  if (at < 0) return null
  const end = at + selected.length

  // A selection spanning the whole line is a clean block replacement.
  if (at === 0 && end === text.length) {
    return [{ ...block, content: [replacementRun(items, 0, edited)] } as NoteBlock]
  }

  const next: InlineItem[] = []
  let offset = 0
  let inserted = false
  for (const item of items) {
    const length = itemText(item)?.length ?? 0
    const start = offset
    const stop = offset + length
    const outside = stop <= at || start >= end
    if (outside) {
      next.push(item)
    } else if (!inserted) {
      // Keep the part of a run before the selection, then the new text.
      if (start < at) {
        if (item.type !== 'text') return null
        next.push({ ...item, text: String(item.text).slice(0, at - start) })
      }
      next.push(replacementRun(items, items.indexOf(item), edited))
      inserted = true
    }
    // Text after the selection inside a covered run is dropped; runs that
    // start before the end and stop after it keep their tail below.
    if (!outside && stop > end) {
      if (item.type !== 'text') return null
      next.push({ ...item, text: String(item.text).slice(end - start) })
    }
    offset = stop
  }
  if (!inserted) return null
  return [{ ...block, content: next } as NoteBlock]
}
