import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { EXPIRY_PRESETS, expiryIn, expiryOnDate, shareState, shareUrl } from '@/lib/shares'
import type { Share, ShareKind } from '@/types'

const chip = 'rounded-md border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const chipClass = (on: boolean) => `${chip} ${on ? 'border-foreground bg-secondary font-medium' : 'border-border hover:bg-secondary'}`

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function splitEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean)
}

/** Copy button with a short "Copied" confirmation; falls back to selecting the field. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      field.current?.select()
    }
  }
  return (
    <div className="flex gap-2">
      <input ref={field} readOnly value={url} aria-label="Share link" onFocus={(e) => e.target.select()}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs" />
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** Expiry chips (presets + a date); reports an ISO time or null for never. */
function ExpiryPicker({ onChange }: { onChange: (expiresAt: string | null) => void }) {
  const [choice, setChoice] = useState<number | 'date'>(7)
  const [date, setDate] = useState('')
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="mb-1 text-xs text-muted-foreground">Expires</legend>
      {EXPIRY_PRESETS.map((p) => (
        <button key={p.label} type="button" aria-pressed={choice === p.days} className={chipClass(choice === p.days)}
          onClick={() => { setChoice(p.days); onChange(expiryIn(p.days)) }}>{p.label}</button>
      ))}
      <button type="button" aria-pressed={choice === 'date'} className={chipClass(choice === 'date')} onClick={() => { setChoice('date'); onChange(expiryOnDate(date)) }}>On a date</button>
      {choice === 'date' && (
        <input type="date" aria-label="Expiry date" value={date} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
          onChange={(e) => { setDate(e.target.value); onChange(expiryOnDate(e.target.value)) }}
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs" />
      )}
    </fieldset>
  )
}

function ShareRow({ share, tab, onChange }: { share: Share; tab: string; onChange: (s: Share | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [emails, setEmails] = useState(share.recipients.join(', '))
  const [error, setError] = useState('')
  const state = shareState(share)
  const patch = async (body: Record<string, unknown>) => {
    setError('')
    try {
      onChange(await apiFetch<Share>(`/shares/${share.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, origin: window.location.origin }) }))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the link')
      return false
    }
  }
  const remove = async () => {
    try {
      await apiFetch(`/shares/${share.id}`, { method: 'DELETE' })
      onChange(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the link')
    }
  }
  const status = state === 'revoked' ? 'Revoked' : state === 'expired' ? `Expired ${formatDate(share.expires_at!)}`
    : share.expires_at ? `Expires ${formatDate(share.expires_at)}` : 'Never expires'
  return (
    <li className="space-y-2 rounded-md border border-border p-2.5 text-xs" data-testid="share-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-full border border-border px-1.5 font-medium">{share.kind === 'public' ? 'Public' : 'Private'}</span>
        <span className="font-mono text-muted-foreground">/s/{share.token.slice(0, 6)}…</span>
        <span className={state === 'active' ? '' : 'text-muted-foreground'}>{status}</span>
      </div>
      {share.kind === 'private' && !editing && <p className="text-muted-foreground break-words">For {share.recipients.join(', ') || 'nobody'}</p>}
      {editing && (
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await patch({ emails: splitEmails(emails) })) setEditing(false) }}>
          <input aria-label="Recipients" value={emails} onChange={(e) => setEmails(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs" />
          <Button type="submit" size="sm" variant="outline">Save</Button>
        </form>
      )}
      {state === 'active' && <CopyLink url={shareUrl(share.token, tab)} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label="Change expiry" value="" className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
          onChange={(e) => { if (e.target.value !== '') patch({ expires_at: expiryIn(Number(e.target.value)) }) }}>
          <option value="">{state === 'active' ? 'Change expiry…' : 'Extend…'}</option>
          {EXPIRY_PRESETS.map((p) => <option key={p.label} value={p.days}>{p.days ? `${p.label} from now` : 'Never'}</option>)}
        </select>
        {share.kind === 'private' && <button type="button" className={chipClass(editing)} onClick={() => setEditing(!editing)}>Recipients</button>}
        {state === 'revoked'
          ? <button type="button" className={chipClass(false)} onClick={() => patch({ revoked: false })}>Restore</button>
          : <button type="button" className={chipClass(false)} onClick={() => patch({ revoked: true })}>{share.kind === 'public' ? 'Stop sharing' : 'Revoke'}</button>}
        <button type="button" className={`${chip} border-border text-destructive hover:bg-secondary`} onClick={remove}>Delete</button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </li>
  )
}

/**
 * Creates and manages read-only links to the benchmarks on the results page:
 * private links for named BitBench accounts, or one stable public link.
 */
export default function ShareDialog({ benchmarkIds, title, tab, onClose }: {
  benchmarkIds: string[]
  title: string
  tab: string
  onClose: () => void
}) {
  const [kind, setKind] = useState<ShareKind>('private')
  const [recipients, setRecipients] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [expiresAt, setExpiresAt] = useState<string | null>(() => expiryIn(7))
  const [publicExpiresAt, setPublicExpiresAt] = useState<string | null>(() => expiryIn(7))
  const [shares, setShares] = useState<Share[] | null>(null)
  const [created, setCreated] = useState<Share | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const key = benchmarkIds.join(',')

  const loadShares = useCallback(() => {
    apiFetch<{ shares: Share[] }>(`/shares?benchmark_ids=${key}`)
      .then((d) => setShares(d?.shares ?? []))
      .catch(() => setShares([]))
  }, [key])
  useEffect(() => { loadShares() }, [loadShares])
  useEffect(() => {
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addDraft = () => {
    const more = splitEmails(draft).filter((e) => !recipients.some((r) => r.toLowerCase() === e.toLowerCase()))
    if (more.length) setRecipients([...recipients, ...more])
    setDraft('')
  }
  const activePublic = shares?.find((s) => s.kind === 'public' && shareState(s) === 'active')

  const create = async () => {
    setError('')
    const emails = kind === 'private' ? [...recipients, ...splitEmails(draft)] : []
    if (kind === 'private' && emails.length === 0) {
      setError('Add at least one BitBench account by email.')
      return
    }
    setBusy(true)
    try {
      const share = await apiFetch<Share>('/shares', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          benchmark_ids: benchmarkIds,
          emails,
          expires_at: kind === 'private' ? expiresAt : publicExpiresAt,
          origin: window.location.origin,
        }),
      })
      setCreated(share)
      setRecipients([])
      setDraft('')
      loadShares()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the link')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="share-title"
        className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-5 shadow-lg outline-none">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="share-title" className="truncate text-lg font-semibold">Share “{title}”</h2>
            <p className="text-xs text-muted-foreground">
              Read-only: viewers can browse and restyle the charts for themselves, and hide benchmarks, but change nothing.
              {benchmarkIds.length > 1 && ` ${benchmarkIds.length} benchmarks.`}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Who can open the link">
          {(['private', 'public'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k}
              onClick={() => { setKind(k); setError(''); setCreated(null) }}
              className={`rounded px-3 py-1 text-sm ${kind === k ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}>
              {k === 'private' ? 'Private' : 'Public'}
            </button>
          ))}
        </div>

        {kind === 'private' ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="share-recipients" className="mb-1 block text-xs text-muted-foreground">BitBench accounts that can open the link</label>
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5">
                {recipients.map((r) => (
                  <span key={r} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
                    {r}
                    <button type="button" aria-label={`Remove ${r}`} onClick={() => setRecipients(recipients.filter((x) => x !== r))}><X className="h-3 w-3" /></button>
                  </span>
                ))}
                <input id="share-recipients" type="email" value={draft} placeholder={recipients.length ? '' : 'name@lab.org, press Enter'}
                  onChange={(e) => setDraft(e.target.value)} onBlur={addDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDraft() }
                    if (e.key === 'Backspace' && !draft && recipients.length) setRecipients(recipients.slice(0, -1))
                  }}
                  className="h-6 min-w-[10rem] flex-1 bg-transparent text-sm outline-none" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">They log in to open it; they also find it under “Shared with me” on their Experiments page.</p>
            </div>
            <ExpiryPicker onChange={setExpiresAt} />
            <div className="flex justify-end"><Button type="button" size="sm" disabled={busy} onClick={create}>Create link</Button></div>
          </div>
        ) : (
          <div className="space-y-3">
            <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              No login needed: anyone who gets the link sees these results. The link stays the same whenever you share these benchmarks publicly.
            </p>
            {activePublic ? (
              <p className="text-xs text-muted-foreground">These benchmarks are public; the link is listed below.</p>
            ) : (
              <>
                <ExpiryPicker onChange={setPublicExpiresAt} />
                <div className="flex justify-end"><Button type="button" size="sm" disabled={busy} onClick={create}>Create public link</Button></div>
              </>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {created && (
          <div className="space-y-1.5" data-testid="share-created">
            <p className="text-xs font-medium">Link created. Send it to the people it is for:</p>
            <CopyLink url={shareUrl(created.token, tab)} />
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Links to these benchmarks</h3>
          {shares === null ? <p className="text-xs text-muted-foreground">Loading…</p>
            : shares.length === 0 ? <p className="text-xs text-muted-foreground">None yet.</p>
              : (
                <ul className="space-y-2">
                  {shares.map((s) => (
                    <ShareRow key={s.id} share={s} tab={tab}
                      onChange={(next) => setShares((prev) => (prev ?? []).flatMap((x) => (x.id === s.id ? (next ? [next] : []) : [x])))} />
                  ))}
                </ul>
              )}
        </div>
      </div>
    </div>
  )
}
