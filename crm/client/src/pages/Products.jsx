import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Confirm, Empty, Field, Loading, Modal } from '../components/ui.jsx'
import { money } from '../components/format.js'

export const PRICING_LABELS = {
  per_seat_monthly: 'Per seat / month',
  one_time: 'One-off fee',
  hourly: 'Per hour',
  per_unit: 'Per unit',
}
const PRICING_HINTS = {
  per_seat_monthly: 'Quoted quantity is a number of seats. Counts toward MRR.',
  one_time: 'Charged once. Counts toward contract value but never toward MRR.',
  hourly: 'Quoted quantity is estimated hours per month. Counts toward MRR.',
  per_unit: 'Quoted quantity is estimated units per month. Counts toward MRR.',
}

export default function Products() {
  const { can, currencies, reportingCurrency } = useAuth()
  const isAdmin = can('products.manage')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.listProducts({ active: showInactive ? 'all' : 'true' }))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [showInactive]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const items = data?.items || []

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Rate card</h1>
          <div className="topbar-sub">
            What you sell and what it costs. Quotes are built from this — and the floor price is
            what stops a discount going too far.
          </div>
        </div>
        <div className="spacer" />
        <label className="row small" style={{ whiteSpace: 'nowrap' }}>
          <input type="checkbox" className="checkbox" checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        {isAdmin && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New product</button>}
      </div>

      <div className="page">
        {!isAdmin && (
          <div className="banner banner-info">
            <span>ℹ</span>
            <div>You can read the rate card and quote from it. Only an admin changes prices.</div>
          </div>
        )}

        <div className="card">
          {loading ? <Loading /> : items.length === 0 ? (
            <Empty
              icon="🏷" title="No products yet"
              action={isAdmin
                ? <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>Add your first product</button>
                : <span className="small">Ask an admin to set up the rate card.</span>}
            >
              A product is a thing you sell at a price — a support seat at a monthly rate, a setup fee,
              an hourly service. Quotes pull their lines from here.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th><th>Category</th><th>Basis</th>
                    <th className="right">List price</th><th className="right">Floor price</th>
                    <th className="right">Margin</th>
                    {isAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => {
                    const margin = p.listPrice > 0 && p.unitCost > 0
                      ? Math.round(((p.listPrice - p.unitCost) / p.listPrice) * 1000) / 10
                      : null
                    const marginAtFloor = p.floorPrice > 0 && p.unitCost > 0
                      ? Math.round(((p.floorPrice - p.unitCost) / p.floorPrice) * 1000) / 10
                      : null
                    return (
                      <tr key={p._id} style={{ opacity: p.active ? 1 : 0.5 }}>
                        <td>
                          <span className="strong">{p.name}</span>
                          {!p.active && <span className="tag" style={{ marginLeft: 6 }}>inactive</span>}
                          <div className="small faint truncate" style={{ maxWidth: 280 }}>
                            {p.sku ? `${p.sku} · ` : ''}{p.description || '—'}
                          </div>
                        </td>
                        <td className="small">{p.category || <span className="faint">—</span>}</td>
                        <td className="small nowrap">{PRICING_LABELS[p.pricingModel] || p.pricingModel}</td>
                        <td className="right strong">{money(p.listPrice, p.currency)}</td>
                        <td className="right small">
                          {p.floorPrice > 0 ? money(p.floorPrice, p.currency) : <span className="faint">none</span>}
                          {p.unitCost > 0 && (
                            <div className="faint" style={{ fontSize: 11 }}>{money(p.unitCost, p.currency)} cost</div>
                          )}
                        </td>
                        <td className="right small" style={{ color: margin !== null && margin < 20 ? 'var(--warn)' : undefined }}>
                          {margin === null ? '—' : `${margin}% at list`}
                          {marginAtFloor !== null && (
                            <div className="faint" style={{ fontSize: 11 }}>{marginAtFloor}% at floor</div>
                          )}
                          {margin === null && p.unitCost === 0 && (
                            <div className="faint" style={{ fontSize: 11 }}>no cost set</div>
                          )}
                        </td>
                        {isAdmin && (
                          <td className="right nowrap">
                            <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(p)}>✕</button>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {(creating || editing) && (
        <ProductModal
          product={editing}
          currencies={currencies}
          defaultCurrency={reportingCurrency}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}

      {deleting && (
        <Confirm
          danger title={`Delete ${deleting.name}`} confirmLabel="Delete"
          message="Quotes snapshot their prices, so existing quotes keep working either way. If it has ever been quoted, deactivating is better — it disappears from the picker while the history stays readable."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteProduct(deleting._id)
              toast.success('Product deleted')
              setDeleting(null)
              load()
            } catch (err) {
              // The server refuses when it is in use and tells us to deactivate.
              if (err.payload?.canDeactivate) {
                await api.updateProduct(deleting._id, { active: false })
                toast.success('Deactivated instead — it is used on existing quotes')
                setDeleting(null)
                load()
              } else {
                toast.error(err.message)
              }
            }
          }}
        />
      )}
    </>
  )
}

function ProductModal({ product, currencies, defaultCurrency, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    name: '', sku: '', description: '', category: '',
    pricingModel: 'per_seat_monthly', currency: defaultCurrency || 'USD',
    listPrice: 0, floorPrice: 0, unitCost: 0, active: true,
    ...(product || {}),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const margin = form.listPrice > 0 && form.unitCost > 0
    ? Math.round(((form.listPrice - form.unitCost) / form.listPrice) * 1000) / 10
    : null
  const floorMargin = form.floorPrice > 0 && form.unitCost > 0
    ? Math.round(((form.floorPrice - form.unitCost) / form.floorPrice) * 1000) / 10
    : null

  async function save() {
    setBusy(true)
    setError('')
    try {
      const body = {
        ...form,
        listPrice: Number(form.listPrice) || 0,
        floorPrice: Number(form.floorPrice) || 0,
        unitCost: Number(form.unitCost) || 0,
      }
      if (product) await api.updateProduct(product._id, body)
      else await api.createProduct(body)
      toast.success(product ? 'Product updated' : 'Product created')
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={product ? `Edit ${product.name}` : 'New product'} width="wide" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? 'Saving…' : product ? 'Save' : 'Create product'}
          </button>
        </>
      }
    >
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="grid grid-2">
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} autoFocus
          placeholder="Customer Support Agent — Tier 1" /></Field>
        <Field label="SKU" hint="Optional, must be unique."><input className="input mono" value={form.sku} onChange={set('sku')} /></Field>
      </div>
      <Field label="Description" hint="Appears on the quote under the line name.">
        <textarea className="textarea" style={{ minHeight: 60 }} value={form.description} onChange={set('description')} />
      </Field>

      <div className="grid grid-2">
        <Field label="Category"><input className="input" value={form.category} onChange={set('category')} placeholder="Support, Back office…" /></Field>
        <Field label="Currency" hint="A quote can only mix products of one currency.">
          <select className="select" value={form.currency} onChange={set('currency')}>
            {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Pricing basis" hint={PRICING_HINTS[form.pricingModel]}>
        <select className="select" value={form.pricingModel} onChange={set('pricingModel')}>
          {Object.entries(PRICING_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>

      <div className="grid grid-3">
        <Field label="List price" hint="The published rate.">
          <input className="input" type="number" min="0" step="0.01" value={form.listPrice} onChange={set('listPrice')} />
        </Field>
        <Field label="Floor price" hint="Below this, a quote needs admin approval. Leave at 0 for no floor.">
          <input className="input" type="number" min="0" step="0.01" value={form.floorPrice} onChange={set('floorPrice')} />
        </Field>
        <Field label="Your unit cost" hint="Optional. Only used to show margin — never shown to a client.">
          <input className="input" type="number" min="0" step="0.01" value={form.unitCost} onChange={set('unitCost')} />
        </Field>
      </div>

      {(margin !== null || floorMargin !== null) && (
        <div className={`banner ${margin !== null && margin < 20 ? 'banner-warn' : 'banner-info'}`}>
          <span>{margin !== null && margin < 20 ? '⚠' : 'ℹ'}</span>
          <div>
            {margin !== null && <>At list you keep <strong>{margin}%</strong>. </>}
            {floorMargin !== null && <>At the floor you keep <strong>{floorMargin}%</strong>.</>}
            {floorMargin !== null && floorMargin < 10 && ' That is very thin — consider raising the floor.'}
          </div>
        </div>
      )}

      {product && (
        <label className="row small">
          <input type="checkbox" className="checkbox" checked={form.active}
            onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
          Active — inactive products are hidden from the quote builder but stay on existing quotes
        </label>
      )}
    </Modal>
  )
}
