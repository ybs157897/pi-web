import { useEffect, useRef, useState } from 'react'
import type { DraftImage } from './Composer.tsx'
import { attachmentLimitError, attachmentLimitText, fileData, imageFileType } from './conversation-input.ts'
import { useUiPreferences } from './ui-preferences.tsx'

/** Native draft storage is scoped to the actual conversation, including when reopened from the Bot roster. */
export function useWorkbenchDraft(conversationId: string) {
  const { t } = useUiPreferences()
  const key = 'pi-durable-web:draft:' + conversationId
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(key) ?? '' }
    catch { return '' }
  })
  const [attachments, setAttachments] = useState<readonly DraftImage[]>([])
  const current = useRef(attachments)
  const [attachmentError, setAttachmentError] = useState('')

  useEffect(() => () => {
    for (const item of current.current) URL.revokeObjectURL(item.preview)
    current.current = []
  }, [])

  function change(text: string) {
    setValue(text)
    try {
      if (text === '') localStorage.removeItem(key)
      else localStorage.setItem(key, text)
    } catch { /* Keep using the in-memory draft. */ }
  }

  function store(items: readonly DraftImage[]) {
    current.current = items
    setAttachments(items)
  }

  function update(item: DraftImage) {
    if (current.current.some(existing => existing.id === item.id)) {
      store(current.current.map(existing => existing.id === item.id ? item : existing))
    }
  }

  async function read(item: DraftImage) {
    try {
      const data = await fileData(item.file, t)
      update({ ...item, data, status: 'ready' })
    } catch (cause) {
      update({ ...item, status: 'error', error: cause instanceof Error ? cause.message : t('无法读取附件', 'Could not read attachment') })
    }
  }

  function add(files: FileList | File[]) {
    const selected = Array.from(files, file => ({ file, type: imageFileType(file) }))
    if (selected.length === 0) return
    const limit = attachmentLimitError(current.current, [], selected.map(({ file, type }) => ({ size: file.size, image: type !== '' })))
    setAttachmentError(limit === null ? '' : attachmentLimitText(limit, t))
    if (limit !== null) return
    const batch = selected.map(({ file, type }): DraftImage => ({
      id: crypto.randomUUID(), file, preview: URL.createObjectURL(file),
      mimeType: type || file.type || 'application/octet-stream', data: '', status: 'reading',
    }))
    store([...current.current, ...batch])
    for (const item of batch) void read(item)
  }

  function remove(id: string) {
    const item = current.current.find(existing => existing.id === id)
    if (!item) return
    URL.revokeObjectURL(item.preview)
    store(current.current.filter(existing => existing.id !== id))
    setAttachmentError('')
  }

  function retry(id: string) {
    const item = current.current.find(existing => existing.id === id)
    if (!item || item.status !== 'error') return
    const reading = { ...item, status: 'reading' as const, error: undefined }
    update(reading)
    void read(reading)
  }

  function sent(text: string, items: readonly DraftImage[]) {
    // Preserve a draft edited after the same conversation was reopened elsewhere.
    setValue(previous => previous === text ? '' : previous)
    try {
      if (localStorage.getItem(key) === text) localStorage.removeItem(key)
    } catch { /* Keep using the in-memory draft. */ }
    const sentIds = new Set(items.map(item => item.id))
    for (const item of items) URL.revokeObjectURL(item.preview)
    store(current.current.filter(item => !sentIds.has(item.id)))
    setAttachmentError('')
  }

  return { value, attachments, attachmentError, change, add, remove, retry, sent }
}
