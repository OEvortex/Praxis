'use client'
import { useEffect, useState } from 'react'

import Link from '@/shared/router/link'
import './note-library.css'
import { FileDown, Layers, X } from 'lucide-react'
import { exportNoteFlashcards, noteRequest } from '@/lib/notes-api'
import PickerShell from '@/components/common/PickerShell'
interface Card {
  page_id: string
  page_title: string
  block_id: string
  card_id: string
  front: string
  back: string
}
export default function NoteReview() {
  
  const [cards, setCards] = useState<Card[]>([])
  const [open, setOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void noteRequest<{ cards: Card[] }>('/review/due')
      .then(r => setCards(r.cards))
      .catch(e => setError(String(e)))
  }, [])
  const card = cards[0]
  const exportAll = async () => {
    setBusy(true)
    try {
      const blob = await exportNoteFlashcards()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'praxis-flashcards.txt'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  const grade = async (remembered: boolean) => {
    setBusy(true)
    try {
      await noteRequest(`/${card.page_id}/review`, { card_id: card.card_id, remembered })
      setCards(c => c.slice(1))
      setRevealed(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  if (!cards.length && !open) return null
  return (
    <>
      <button
        className="dt-notes-review-trigger"
        onClick={() => {
          setRevealed(false)
          setOpen(true)
        }}
      >
        <Layers size={14} strokeWidth={1.7} />
        {"Review flashcards"}
        <span className="dt-notes-review-count">{cards.length}</span>
      </button>
      <PickerShell open={open} onClose={() => setOpen(false)} ariaLabel={"Review flashcards"}>
        <div className="dt-notes-review">
          <header>
            <span className="dt-notes-review-heading">
              {"Review flashcards"}
              <button
                type="button"
                className="dt-notes-review-export"
                disabled={busy}
                onClick={() => void exportAll()}
              >
                <FileDown size={13} strokeWidth={1.7} />
                {"Export all for Anki"}
              </button>
            </span>
            {card && <span>{(cards.length === 1 ? `${cards.length} left` : `${cards.length} left`)}</span>}
            <button className="dt-note-icon-button" aria-label={"Close"} onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </header>
          {card ? (
            <>
              <div className="dt-notes-review-card">
                <p className="is-front">{card.front}</p>
                {revealed && <p className="is-back">{card.back}</p>}
              </div>
              <Link href={`/co-writer/${card.page_id}#${card.block_id}`} className="dt-notes-review-source">
                {`From “${card.page_title || "Untitled"}”`} ↗
              </Link>
              <div className="dt-notes-review-actions">
                {revealed ? (
                  <>
                    <button disabled={busy} onClick={() => void grade(false)}>
                      {"Again"}
                    </button>
                    <button disabled={busy} className="is-primary" onClick={() => void grade(true)}>
                      {"Remembered"}
                    </button>
                  </>
                ) : (
                  <button className="is-primary" onClick={() => setRevealed(true)}>
                    {"Show answer"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="dt-notes-review-done">
              <span aria-hidden>🎉</span>
              <p>{"All caught up"}</p>
            </div>
          )}
          {error && (
            <p role="alert" className="dt-notes-review-error">
              {error}
            </p>
          )}
        </div>
      </PickerShell>
    </>
  )
}
