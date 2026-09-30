import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Confirm, CopyButton, Empty, Field, Loading, Modal } from '../components/ui.jsx'
import QuoteStatus, { QUOTE_STATUS_META } from '../components/QuoteStatus.jsx'
import { PRICING_LABELS } from './Products.jsx'
import { downloadFile } from '../components/downloadFile.js'
import { dateTime, fullName, money, shortDate, dateInput, relativeDate } from '../components/format.js'

export default function QuoteDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { isAdmin, currencies } = useAuth()
  const toast = useToast()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState([])
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.getQuote(id))
    } catch (err) {
      toast.error(err.message)
      navigate('/quotes')
    } finally {
      setLoading(false)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listProducts({ active: 'true' }).then((d) => setProducts(d.items)).catch(() => {})
  }, [])

  if (loading) return <Loading />
  if (!data) return null
  const { quote, versions, activities, canEdit, canApprove, editable, wouldNeedApproval, appBaseUrl } = data
  const cur = quote.currency
  const publicUrl = `${(appBaseUrl || window.location.origin).replace(/\/+$/, '')}/q/${quote.publicToken}`
  const isPublic = ['approved', 'sent', 'accepted', 'declined', 'expired'].includes(quote.status)

  async function act(fn, message) {
    setBusy(true)
    try {
      await fn()
      if (message) toast.success(message)
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function patch(body) {
    await api.updateQuote(quote._id, body)
    await load()
  }

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/quotes">←</Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">
            {quote.number}{quote.version > 1 && <span className="faint"> · v{quote.version}</span>}
          </h1>
          <div className="topbar-sub truncate">
            {quote.company ? <Link to={`/companies/${quote.company._id}`}>{quote.company.name}</Link> : '—'}
            {quote.deal && <> · <Link to={`/deals/${quote.deal._id}`}>{quote.deal.name}</Link></>}
            {' · '}{money(quote.tcv, cur)}
          </div>
        </div>
        <div className="spacer" />
        <QuoteStatus status={quote.status} />
        <button className="btn btn-sm" disabled={busy}
          onClick={() => act(
            () => downloadFile(api.quotePdfUrl(quote._id), `${quote.number}${quote.version > 1 ? `-v${quote.version}` : ''}.pdf`),
            'PDF downloaded'
          )}>
          Download PDF
        </button>
      </div>

      <div className="page">
        <StatusBanner quote={quote} canEdit={canEdit} canApprove={canApprove} busy={busy}
          onDecide={() => setDialog('decide')} onRevise={() => act(async () => {
            const { quote: copy } = await api.reviseQuote(quote._id)
            navigate(`/quotes/${copy._id}`)
          }, 'New version created')} />

        {editable && wouldNeedApproval.length > 0 && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div>
              <strong>This will need an admin's approval before you can share it:</strong>
              <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                {wouldNeedApproval.map((rule) => (
                  <li key={rule.rule} className="small">{rule.label} — {rule.detail}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {editable && wouldNeedApproval.length === 0 && quote.lineItems.length > 0 && (
          <div className="banner banner-ok">
            <span>✓</span>
            <div>This breaks no approval rule, so submitting it will approve it straight away.</div>
          </div>
        )}

        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="stat-label">Total contract value</div>
            <div className="stat-value">{money(quote.tcv, cur, { compact: true })}</div>
            <div className="stat-sub">{quote.termMonths ? `over ${quote.termMonths} months` : 'no term set'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Monthly recurring</div>
            <div className="stat-value">{money(quote.mrr, cur, { compact: true })}</div>
            <div className="stat-sub">
              {quote.oneTimeTotal > 0 ? `+ ${money(quote.oneTimeTotal, cur)} one-off` : 'no one-off fees'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Margin</div>
            <div className="stat-value" style={{ color: marginPct(quote) !== null && marginPct(quote) < 20 ? 'var(--warn)' : undefined }}>
              {marginPct(quote) === null ? '—' : `${marginPct(quote)}%`}
            </div>
            <div className="stat-sub">
              {quote.totalCost > 0 ? `${money(quote.totalCost, cur, { compact: true })} cost` : 'no costs recorded'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Valid until</div>
            <div className="stat-value" style={{ fontSize: 19 }}>{quote.validUntil ? shortDate(quote.validUntil) : '—'}</div>
            <div className="stat-sub">
              {quote.firstViewedAt
                ? `Client opened it ${relativeDate(quote.firstViewedAt)}`
                : isPublic ? 'Client has not opened it' : 'not shared yet'}
            </div>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 330px', alignItems: 'start' }}>
          <div className="col" style={{ gap: 14 }}>
            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Lines</h2>
                {editable && canEdit && (
                  <button className="btn btn-sm" onClick={() => setDialog('add-line')}>+ Add from rate card</button>
                )}
              </div>
              {quote.lineItems.length === 0 ? (
                <Empty icon="🏷" title="Nothing on this quote yet"
                  action={editable && canEdit
                    ? <button className="btn btn-primary btn-sm" onClick={() => setDialog('add-line')}>Add a product</button>
                    : null}>
                  Lines are copied from the rate card, prices and all — so a later price change
                  cannot rewrite what a client is looking at.
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Item</th><th className="right">Qty</th><th className="right">Unit price</th>
                        <th className="right">Discount</th><th className="right">Amount</th>{editable && canEdit && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {quote.lineItems.map((li, i) => (
                        <LineRow
                          key={li._id || i} line={li} currency={cur} editable={editable && canEdit}
                          onChange={(patched) => patch({
                            lineItems: quote.lineItems.map((x, j) => (j === i ? { ...x, ...patched } : x)),
                          })}
                          onRemove={() => patch({ lineItems: quote.lineItems.filter((_, j) => j !== i) })}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {quote.lineItems.length > 0 && (
                <div className="card-body" style={{ paddingTop: 12 }}>
                  <div style={{ maxWidth: 340, marginLeft: 'auto' }}>
                    {quote.mrr > 0 && (
                      <div className="row"><span className="faint small" style={{ flex: 1 }}>Monthly recurring</span>
                        <span className="strong">{money(quote.mrr, cur)}</span></div>
                    )}
                    {quote.mrr > 0 && quote.termMonths > 0 && (
                      <div className="row" style={{ marginTop: 4 }}>
                        <span className="faint small" style={{ flex: 1 }}>Over {quote.termMonths} months</span>
                        <span className="strong">{money(quote.mrr * quote.termMonths, cur)}</span></div>
                    )}
                    {quote.oneTimeTotal > 0 && (
                      <div className="row" style={{ marginTop: 4 }}><span className="faint small" style={{ flex: 1 }}>One-off fees</span>
                        <span className="strong">{money(quote.oneTimeTotal, cur)}</span></div>
                    )}
                    <div className="divider" style={{ margin: '10px 0' }} />
                    <div className="row">
                      <span className="strong" style={{ flex: 1 }}>Total contract value</span>
                      <span className="strong" style={{ fontSize: 17, color: 'var(--accent)' }}>{money(quote.tcv, cur)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head"><h2>What the client reads</h2></div>
              <div className="card-body">
                {editable && canEdit ? (
                  <>
                    <Field label="Title"><input className="input" defaultValue={quote.title}
                      onBlur={(e) => e.target.value !== quote.title && patch({ title: e.target.value })} /></Field>
                    <Field label="Opening message" hint="Sits above the pricing table. A sentence or two of context.">
                      <textarea className="textarea" defaultValue={quote.introMessage}
                        onBlur={(e) => e.target.value !== quote.introMessage && patch({ introMessage: e.target.value })} />
                    </Field>
                    <Field label="Terms">
                      <textarea className="textarea" defaultValue={quote.terms}
                        onBlur={(e) => e.target.value !== quote.terms && patch({ terms: e.target.value })} />
                    </Field>
                  </>
                ) : (
                  <>
                    <div className="strong">{quote.title || <span className="faint">No title</span>}</div>
                    {quote.introMessage && <p className="small muted" style={{ marginTop: 8 }}>{quote.introMessage}</p>}
                    {quote.terms && (
                      <>
                        <div className="label" style={{ marginTop: 14 }}>Terms</div>
                        <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{quote.terms}</div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {activities.length > 0 && (
              <div className="card">
                <div className="card-head"><h2>History</h2></div>
                <div className="card-body">
                  <div className="timeline">
                    {activities.map((a) => (
                      <div className="tl-item" key={a._id}>
                        <span className={`tl-dot ${a.type === 'quote_accepted' ? 'call' : a.type === 'quote_declined' || a.type === 'quote_rejected' ? 'alert' : ''}`} />
                        <div className="tl-title">{a.title}</div>
                        <div className="tl-meta">{dateTime(a.createdAt)}{a.user?.name && <> · {a.user.name}</>}</div>
                        {a.body && <div className="tl-body">{a.body}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="col" style={{ gap: 14 }}>
            {canEdit && editable && (
              <div className="card">
                <div className="card-body">
                  <button className="btn btn-primary btn-block" disabled={busy || quote.lineItems.length === 0}
                    onClick={() => act(async () => {
                      const res = await api.submitQuote(quote._id)
                      toast.success(res.autoApproved
                        ? 'Approved — nothing needed a sign-off'
                        : `Sent for approval — ${res.reasons.map((x) => x.label).join(', ')}`)
                    })}>
                    {wouldNeedApproval.length ? 'Submit for approval' : 'Approve and make shareable'}
                  </button>
                  <div className="hint">
                    {quote.lineItems.length === 0
                      ? 'Add at least one line first.'
                      : wouldNeedApproval.length
                        ? 'An admin has to clear this before the public link works.'
                        : 'This breaks no rule, so it becomes shareable immediately.'}
                  </div>
                </div>
              </div>
            )}

            {isPublic && (
              <div className="card">
                <div className="card-head"><h2>Share with the client</h2></div>
                <div className="card-body">
                  <p className="small muted">
                    Send this link yourself — by email, WhatsApp, however you normally reach them.
                    The CRM does not send it for you.
                  </p>
                  <div className="script-box mono" style={{ fontSize: 12, wordBreak: 'break-all', maxHeight: 'none' }}>
                    {publicUrl}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <CopyButton text={publicUrl} label="Copy link" className="btn btn-primary btn-sm" />
                    <a className="btn btn-sm" href={publicUrl} target="_blank" rel="noreferrer noopener">Preview ↗</a>
                  </div>
                  {quote.status === 'approved' && canEdit && (
                    <button className="btn btn-block btn-sm" style={{ marginTop: 10 }} disabled={busy}
                      onClick={() => act(() => api.markQuoteSent(quote._id), 'Marked as sent')}>
                      I've sent it
                    </button>
                  )}
                  {!appBaseUrl && (
                    <div className="hint" style={{ color: 'var(--warn)' }}>
                      No app base URL is set in Settings, so this link only works on your own machine.
                      Set one before sending it to anyone.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head"><h2>Details</h2></div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <Row label="Status"><QuoteStatus status={quote.status} /></Row>
                <Row label="Contact">
                  {quote.contact ? (
                    <Link to={`/contacts/${quote.contact._id}`}>{fullName(quote.contact)}</Link>
                  ) : <span className="faint">Nobody named</span>}
                </Row>
                <Row label="Currency">{cur}</Row>
                <Row label="Term">
                  {editable && canEdit ? (
                    <input className="input" type="number" min="0" defaultValue={quote.termMonths}
                      style={{ maxWidth: 110 }}
                      onBlur={(e) => Number(e.target.value) !== quote.termMonths && patch({ termMonths: Number(e.target.value) })} />
                  ) : `${quote.termMonths} months`}
                </Row>
                <Row label="Valid until">
                  {editable && canEdit ? (
                    <input className="input" type="date" defaultValue={dateInput(quote.validUntil)}
                      onBlur={(e) => patch({ validUntil: e.target.value || null })} />
                  ) : shortDate(quote.validUntil)}
                </Row>
                <Row label="Owner">{quote.owner?.name}</Row>
                <Row label="Created">{dateTime(quote.createdAt)}</Row>
                {quote.sentAt && <Row label="Sent">{dateTime(quote.sentAt)}</Row>}
                {quote.firstViewedAt && (
                  <Row label="Client opened">
                    {dateTime(quote.firstViewedAt)}
                    {quote.viewCount > 1 && <span className="small faint"> · {quote.viewCount} times</span>}
                  </Row>
                )}
                {quote.acceptedAt && <Row label="Accepted">{dateTime(quote.acceptedAt)} by {quote.acceptedName}</Row>}
                {quote.declinedAt && <Row label="Declined">{dateTime(quote.declinedAt)}</Row>}
              </div>
            </div>

            {versions.length > 1 && (
              <div className="card">
                <div className="card-head"><h2>Versions</h2></div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  {versions.map((v) => (
                    <div className="row small" key={v._id} style={{ padding: '4px 0' }}>
                      <span style={{ flex: 1 }}>
                        {v._id === quote._id ? <strong>v{v.version} (this one)</strong> : <Link to={`/quotes/${v._id}`}>v{v.version}</Link>}
                      </span>
                      <span className="faint">{money(v.tcv, v.currency, { compact: true })}</span>
                      <QuoteStatus status={v.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {canEdit && editable && (
              <div className="card">
                <div className="card-body">
                  <button className="btn btn-danger btn-block btn-sm" onClick={() => setDialog('delete')}>
                    Delete draft
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {dialog === 'add-line' && (
        <AddLineDialog
          products={products.filter((p) => p.currency === cur)}
          currency={cur}
          otherCurrencyCount={products.filter((p) => p.currency !== cur).length}
          onClose={() => setDialog(null)}
          onAdd={async (body) => {
            await api.addQuoteLine(quote._id, body)
            setDialog(null)
            load()
          }}
        />
      )}

      {dialog === 'decide' && (
        <DecideDialog quote={quote} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); load() }} />
      )}

      {dialog === 'delete' && (
        <Confirm
          danger title="Delete this draft" confirmLabel="Delete"
          message="Only a draft can be deleted. Anything the client may have seen stays on the record."
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteQuote(quote._id)
            toast.success('Draft deleted')
            navigate(quote.deal ? `/deals/${quote.deal._id}` : '/quotes')
          }}
        />
      )}
    </>
  )
}

function marginPct(quote) {
  if (!quote.totalCost || !quote.tcv) return null
  return Math.round(((quote.tcv - quote.totalCost) / quote.tcv) * 1000) / 10
}

function Row({ label, children }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: 13, alignItems: 'center' }}>
      <div className="faint" style={{ width: 118, flex: '0 0 118px' }}>{label}</div>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  )
}

function LineRow({ line, currency, editable, onChange, onRemove }) {
  const belowFloor = line.floorPrice > 0 && line.unitPrice < line.floorPrice
  return (
    <tr>
      <td>
        <span className="strong">{line.name}</span>
        {line.description && <div className="small faint">{line.description}</div>}
        <div className="small faint">{PRICING_LABELS[line.pricingModel] || line.pricingModel}</div>
      </td>
      <td className="right" style={{ width: 90 }}>
        {editable ? (
          <input className="input" type="number" min="0" defaultValue={line.quantity} style={{ textAlign: 'right' }}
            onBlur={(e) => Number(e.target.value) !== line.quantity && onChange({ quantity: Number(e.target.value) })} />
        ) : line.quantity}
      </td>
      <td className="right" style={{ width: 130 }}>
        {editable ? (
          <input className="input" type="number" min="0" step="0.01" defaultValue={line.unitPrice} style={{ textAlign: 'right' }}
            onBlur={(e) => Number(e.target.value) !== line.unitPrice && onChange({ unitPrice: Number(e.target.value) })} />
        ) : money(line.unitPrice, currency)}
        {line.floorPrice > 0 && (
          <div className="small" style={{ color: belowFloor ? 'var(--danger)' : 'var(--text-faint)' }}>
            floor {money(line.floorPrice, currency)}
          </div>
        )}
      </td>
      <td className="right small" style={{ color: line.discountPercent > 0 ? 'var(--warn)' : undefined }}>
        {line.discountPercent > 0 ? `−${line.discountPercent}%` : '—'}
        {line.listPrice > 0 && <div className="faint" style={{ fontSize: 11 }}>list {money(line.listPrice, currency)}</div>}
      </td>
      <td className="right strong">{money(line.quantity * line.unitPrice, currency)}</td>
      {editable && (
        <td className="right">
          <button className="btn btn-ghost btn-sm" onClick={onRemove}>✕</button>
        </td>
      )}
    </tr>
  )
}

function StatusBanner({ quote, canEdit, canApprove, busy, onDecide, onRevise }) {
  const meta = QUOTE_STATUS_META[quote.status]
  if (quote.status === 'pending_approval') {
    return (
      <div className="banner banner-warn">
        <span>⏳</span>
        <div style={{ flex: 1 }}>
          <strong>Waiting for approval.</strong>
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {(quote.approvalReasons || []).map((r) => (
              <li key={r.rule} className="small">{r.label} — {r.detail}</li>
            ))}
          </ul>
        </div>
        {canApprove && <button className="btn btn-sm" onClick={onDecide}>Review it</button>}
      </div>
    )
  }
  if (quote.status === 'rejected') {
    return (
      <div className="banner banner-danger">
        <span>✕</span>
        <div>
          <strong>Rejected{quote.decidedBy?.name ? ` by ${quote.decidedBy.name}` : ''}.</strong>{' '}
          {quote.decisionNote}
          <div className="small" style={{ marginTop: 4 }}>Editing it puts it back into draft so you can resubmit.</div>
        </div>
      </div>
    )
  }
  if (quote.status === 'accepted') {
    return (
      <div className="banner banner-ok">
        <span>🎉</span>
        <div>
          <strong>Accepted</strong> by {quote.acceptedName} on {shortDate(quote.acceptedAt)}. The deal has been
          updated to match exactly what they agreed to.
        </div>
      </div>
    )
  }
  if (quote.status === 'declined') {
    return (
      <div className="banner banner-danger">
        <span>✕</span>
        <div style={{ flex: 1 }}>
          <strong>Declined</strong> on {shortDate(quote.declinedAt)}.
          {quote.declineReason && <div className="small" style={{ marginTop: 4 }}>“{quote.declineReason}”</div>}
        </div>
        {canEdit && <button className="btn btn-sm" disabled={busy} onClick={onRevise}>New version</button>}
      </div>
    )
  }
  if (quote.status === 'sent' && canEdit) {
    return (
      <div className="banner banner-info">
        <span>📤</span>
        <div style={{ flex: 1 }}>
          Sent {relativeDate(quote.sentAt)}.{' '}
          {quote.firstViewedAt
            ? `The client opened it ${relativeDate(quote.firstViewedAt)}.`
            : 'They have not opened it yet.'}{' '}
          To change anything now, create a new version — what they are looking at must not move underneath them.
        </div>
        <button className="btn btn-sm" disabled={busy} onClick={onRevise}>New version</button>
      </div>
    )
  }
  if (quote.status === 'superseded') {
    return (
      <div className="banner banner-warn">
        <span>ℹ</span>
        <div>This version was replaced by a newer one. Its public link no longer works.</div>
      </div>
    )
  }
  if (quote.status === 'expired' && canEdit) {
    return (
      <div className="banner banner-warn">
        <span>⏰</span>
        <div style={{ flex: 1 }}>This quote passed its valid-until date. {meta?.hint}</div>
        <button className="btn btn-sm" disabled={busy} onClick={onRevise}>New version</button>
      </div>
    )
  }
  return null
}

function AddLineDialog({ products, currency, otherCurrencyCount, onClose, onAdd }) {
  const toast = useToast()
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [unitPrice, setUnitPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const product = products.find((p) => p._id === productId)
  const price = unitPrice === '' ? product?.listPrice ?? 0 : Number(unitPrice)
  const belowFloor = product && product.floorPrice > 0 && price < product.floorPrice
  const discount = product && product.listPrice > 0 && price < product.listPrice
    ? Math.round(((product.listPrice - price) / product.listPrice) * 1000) / 10
    : 0

  return (
    <Modal
      title="Add a line" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!productId || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onAdd({
                  productId, quantity: Number(quantity) || 1,
                  unitPrice: unitPrice === '' ? undefined : Number(unitPrice),
                })
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Add line
          </button>
        </>
      }
    >
      {products.length === 0 ? (
        <Empty icon="🏷" title={`No products priced in ${currency}`}>
          {otherCurrencyCount > 0
            ? `${otherCurrencyCount} product${otherCurrencyCount === 1 ? ' is' : 's are'} priced in another currency. A quote can only carry one currency, or the total would be meaningless.`
            : 'Add something to the rate card first.'}
        </Empty>
      ) : (
        <>
          <Field label="Product">
            <select className="select" value={productId} onChange={(e) => { setProductId(e.target.value); setUnitPrice('') }} autoFocus>
              <option value="">Choose…</option>
              {products.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name} — {money(p.listPrice, p.currency)} {PRICING_LABELS[p.pricingModel]?.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          {product && (
            <>
              <div className="grid grid-2">
                <Field label={product.pricingModel === 'per_seat_monthly' ? 'Seats'
                  : product.pricingModel === 'one_time' ? 'Quantity'
                  : product.pricingModel === 'hourly' ? 'Hours per month' : 'Units per month'}>
                  <input className="input" type="number" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </Field>
                <Field label="Unit price" hint={`List is ${money(product.listPrice, product.currency)}. Leave blank to use it.`}>
                  <input className="input" type="number" min="0" step="0.01" value={unitPrice}
                    placeholder={String(product.listPrice)} onChange={(e) => setUnitPrice(e.target.value)} />
                </Field>
              </div>
              <div className={`banner ${belowFloor ? 'banner-danger' : discount > 0 ? 'banner-warn' : 'banner-info'}`}>
                <span>{belowFloor ? '⛔' : discount > 0 ? '⚠' : 'ℹ'}</span>
                <div>
                  Line total <strong>{money((Number(quantity) || 0) * price, currency)}</strong>
                  {discount > 0 && <> · {discount}% below list</>}
                  {belowFloor && (
                    <div className="small" style={{ marginTop: 4 }}>
                      Below the {money(product.floorPrice, currency)} floor — this quote will need admin approval.
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

function DecideDialog({ quote, onClose, onDone }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function decide(decision) {
    setBusy(true)
    try {
      await api.decideQuote(quote._id, decision, note)
      toast.success(decision === 'approve' ? 'Approved' : 'Rejected')
      onDone()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Review ${quote.number}`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || !note.trim()} onClick={() => decide('reject')}>
            Reject
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => decide('approve')}>
            Approve
          </button>
        </>
      }
    >
      <div className="banner banner-warn">
        <span>⚠</span>
        <div>
          <strong>Why this needs you:</strong>
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {(quote.approvalReasons || []).map((r) => (
              <li key={r.rule} className="small">{r.label} — {r.detail}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="stat-label">Total contract value</div>
          <div className="strong" style={{ fontSize: 18 }}>{money(quote.tcv, quote.currency)}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="stat-label">Margin</div>
          <div className="strong" style={{ fontSize: 18 }}>
            {marginPct(quote) === null ? '—' : `${marginPct(quote)}%`}
          </div>
        </div>
      </div>

      <Field label="Note" hint="Required to reject — the rep needs to know what to change.">
        <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Approved on the volume. / Bring the setup fee back to list and resubmit." />
      </Field>
    </Modal>
  )
}
