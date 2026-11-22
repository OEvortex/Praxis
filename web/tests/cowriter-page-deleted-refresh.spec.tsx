// regression: when Co-writer deletes the open page while building a notebook,
// the workspace must refresh the page list and move to the new page instead of
// leaving a stale editor that only a manual browser refresh would clear.
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import NoteWorkspace from '@/features/notes/components/NoteWorkspace'
import {
  getNote,
  listNotes,
  getSuggestions,
  noteRequest,
  NoteRequestError,
  type NotePage,
} from '@/lib/notes-api'

const replace = vi.fn()
let onPageChanged: (() => void) | undefined

vi.mock('@/shared/router/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}))
vi.mock('@/lib/notes-api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/notes-api')>()
  return {
    ...actual,
    getNote: vi.fn(),
    listNotes: vi.fn(),
    getSuggestions: vi.fn(),
    noteRequest: vi.fn(),
  }
})
vi.mock('@/features/notes/components/useNoteThreads', () => ({
  useNoteThreads: (args: { onPageChanged?: () => void }) => {
    onPageChanged = args.onPageChanged
    return {
      threads: [], open: null, bound: false, hasMessages: false, prefill: null,
      send: vi.fn(), openThread: vi.fn(), startThread: vi.fn(),
      generateBlock: vi.fn(), regenerate: vi.fn(), removeThread: vi.fn(), close: vi.fn(),
    }
  },
}))
vi.mock('@/features/notes/components/NoteEditor', () => ({
  default: () => <div>Editor</div>,
}))

const oldPage: NotePage = {
  id: 'old-draft',
  title: 'Untitled draft',
  content: '',
  blocks: [],
  parent_id: null, icon: '', cover: '', pinned: false,
  revision: 1, created_at: 1, updated_at: 1,
}
const hub = {
  ...oldPage,
  id: 'new-hub',
  title: 'Lasers hub',
  preview: '',
}

beforeEach(() => {
  vi.clearAllMocks()
  onPageChanged = undefined
  vi.mocked(getNote).mockResolvedValue({ ...oldPage })
  vi.mocked(listNotes).mockResolvedValue({ documents: [{ ...oldPage, preview: '' }] })
  vi.mocked(getSuggestions).mockResolvedValue({ suggestions: [] })
  vi.mocked(noteRequest).mockResolvedValue({ pages: [] })
})

it('resyncs pages and navigates to the new page after Co-writer deletes the open one', async () => {
  render(<NoteWorkspace docId={oldPage.id} />)
  expect(await screen.findByRole('textbox', { name: 'Page title' })).toHaveValue('Untitled draft')
  expect(onPageChanged).toBeTypeOf('function')

  // The agent removed the draft and created a hub in one patch.
  vi.mocked(getNote).mockRejectedValue(new NoteRequestError('not found', 404))
  vi.mocked(listNotes).mockResolvedValue({ documents: [hub] })

  await act(async () => {
    onPageChanged?.()
  })

  await waitFor(() => {
    expect(replace).toHaveBeenCalledWith('/co-writer/new-hub')
  })
  expect(vi.mocked(listNotes)).toHaveBeenCalledTimes(2)
})
