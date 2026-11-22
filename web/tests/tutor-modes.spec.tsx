import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import StarterSuggestions from '@/components/chat/home/StarterSuggestions'
import {
  getChatCapability,
  isChatModeCapability,
  TUTOR_MODE_VALUES,
} from '@/features/capabilities/presentation'

const fetcher = vi.hoisted(() => vi.fn())
vi.mock('@/shared/api/client', () => ({
  asJsonOrThrow: async (response: Response) => response.json(),
  apiFetch: fetcher,
  apiUrl: (path: string) => path,
}))
beforeEach(() => {
  fetcher.mockReset()
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({ suggestions: [], stale: false, status: 'no-material' }),
  })
})

it('offers the five composer actions as real chat capabilities', () => {
  for (const value of TUTOR_MODE_VALUES) {
    expect(isChatModeCapability(value)).toBe(true)
    expect(getChatCapability(value).value).toBe(value)
    expect(getChatCapability(value).label).toBe(value.charAt(0).toUpperCase() + value.slice(1))
  }
  expect(isChatModeCapability('')).toBe(true)
  expect(isChatModeCapability('mastery_path')).toBe(false)
  expect(isChatModeCapability('immersive_reading')).toBe(false)
})

it('shows only starter actions whose modes the backend registers', async () => {
  render(
    <StarterSuggestions
      onPick={vi.fn()}
      supportedModes={['explain', 'solve']}
    />,
  )

  expect(await screen.findByRole('button', { name: 'Explain' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Solve' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Practice' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Research' })).toBeNull()
})

it('a starter tab selects its mode, while a prompt still only prefills', async () => {
  const onPick = vi.fn()
  const onSelectGroup = vi.fn()
  render(<StarterSuggestions onPick={onPick} onSelectGroup={onSelectGroup} />)

  const plan = await screen.findByRole('button', { name: 'Plan' })
  fireEvent.click(plan)
  expect(onSelectGroup).toHaveBeenCalledWith('plan')
  expect(onPick).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Make a study plan' }))
  expect(onPick).toHaveBeenCalledTimes(1)
  expect(onPick).toHaveBeenCalledWith(
    "Make me a study plan: weekly goals broken into small daily tasks, with review points marked. If I haven't said what I'm learning, for how long and how much time I have each day, ask me first — at most two questions."
  )
})
