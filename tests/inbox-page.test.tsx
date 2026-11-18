// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InboxPage from '../src/web/InboxPage.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('switches between the two reference models and saves a demo draft locally', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render(<InboxPage />)
  fireEvent.click(screen.getByRole('button', { name: /Choose an AI model.*Opus 4\.8/ }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /GPT 5\.5/ }))
  expect(screen.getByRole('button', { name: /Choose an AI model.*GPT 5\.5/ })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  const compose = within(screen.getByRole('dialog'))
  fireEvent.change(compose.getByLabelText('Subject'), { target: { value: 'Review notes' } })
  fireEvent.click(compose.getByRole('button', { name: 'Save draft' }))
  expect(screen.getByRole('heading', { level: 1, name: 'Drafts' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Review notes/ })).toBeTruthy()
  expect(fetch).not.toHaveBeenCalled()
})

it('archives only the selected rows and restores them from the archive', () => {
  render(<InboxPage />)
  const folders = within(screen.getByRole('navigation', { name: 'Mail folders' }))
  fireEvent.click(folders.getByRole('button', { name: 'Select messages' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select message from Rico Oktananda' }))
  fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
  expect(screen.queryByRole('button', { name: 'Open message from Rico Oktananda' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Open message from Alicia from Deel' })).toBeTruthy()
  fireEvent.click(folders.getByRole('button', { name: 'Archive' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open message from Rico Oktananda' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }))
  fireEvent.click(folders.getByRole('button', { name: 'Inbox' }))
  expect(screen.getByRole('button', { name: 'Open message from Rico Oktananda' })).toBeTruthy()
})
