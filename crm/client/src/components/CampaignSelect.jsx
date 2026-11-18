import { useAuth } from '../contexts/AuthContext.jsx'

/* One campaign picker for every "add / move / enroll" dialog, so all of them
 * list the same campaigns the same way. Every campaign is shown:
 *   - running campaigns first,
 *   - paused ones marked "(paused)" — they can be picked; the contact waits
 *     there, with their tasks hidden, until the campaign is switched back on,
 *   - campaigns with no stages, or that this person may not use, are shown
 *     greyed out with the reason, so nothing silently disappears. */

export function campaignChoice(c) {
  if (!(c.stages || []).length) return { disabled: true, note: 'no stages yet' }
  if (c.canEnroll === false) return { disabled: true, note: 'no access' }
  if (c.active === false) return { disabled: false, note: 'paused' }
  return { disabled: false, note: '' }
}

function rank(c) {
  const { disabled, note } = campaignChoice(c)
  if (disabled) return 2
  return note === 'paused' ? 1 : 0
}

export default function CampaignSelect({ campaigns, value, onChange, autoFocus = false, emptyLabel = 'Choose…' }) {
  const sorted = [...campaigns].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
      <option value="">{emptyLabel}</option>
      {sorted.map((c) => {
        const { disabled, note } = campaignChoice(c)
        const stages = (c.stages || []).length
        const channels = (c.channels || []).length ? `, ${c.channels.join(' + ')}` : ''
        return (
          <option key={c._id} value={c._id} disabled={disabled}>
            {c.name}
            {stages ? ` (${stages} stage${stages === 1 ? '' : 's'}${channels})` : ''}
            {note ? ` — ${note}` : ''}
          </option>
        )
      })}
    </select>
  )
}

/* What will happen with the chosen campaign, shown under the picker. */
export function CampaignChoiceHint({ campaign }) {
  const { outreachRules } = useAuth()
  if (!campaign) return null
  const notes = []
  if (campaign.active === false) {
    notes.push(`"${campaign.name}" is paused. The contact is added now, but their tasks stay hidden and nothing moves until the campaign is switched back on.`)
  }
  if (campaign.cold && !outreachRules?.complianceSignedOffAt) {
    notes.push('This is a cold flow and the compliance sign-off is not recorded yet, so email and call steps reached before the sign-off are skipped.')
  }
  if (!notes.length) return null
  return (
    <div className="banner banner-warn" style={{ marginTop: 10 }}>
      <span>!</span>
      <div>{notes.map((n, i) => <div key={i}>{n}</div>)}</div>
    </div>
  )
}
