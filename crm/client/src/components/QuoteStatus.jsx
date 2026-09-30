export const QUOTE_STATUS_META = {
  draft: { label: 'Draft', color: '#64748b', hint: 'Only you can see this.' },
  pending_approval: { label: 'Needs approval', color: '#d97706', hint: 'Waiting on an admin.' },
  rejected: { label: 'Rejected', color: '#dc2626', hint: 'Change it and submit again.' },
  approved: { label: 'Approved', color: '#0ea5e9', hint: 'Cleared to share with the client.' },
  sent: { label: 'Sent', color: '#6366f1', hint: 'With the client, awaiting a decision.' },
  accepted: { label: 'Accepted', color: '#16a34a', hint: 'The client said yes.' },
  declined: { label: 'Declined', color: '#dc2626', hint: 'The client said no.' },
  expired: { label: 'Expired', color: '#94a3b8', hint: 'Past its valid-until date.' },
  superseded: { label: 'Superseded', color: '#94a3b8', hint: 'Replaced by a newer version.' },
}

export default function QuoteStatus({ status, showHint = false }) {
  const meta = QUOTE_STATUS_META[status] || { label: status, color: '#64748b' }
  return (
    <span className="pill" style={{ color: meta.color, borderColor: `${meta.color}55` }}>
      <span className="pill-dot" />
      {meta.label}
      {showHint && meta.hint && <span className="faint" style={{ fontWeight: 400 }}> · {meta.hint}</span>}
    </span>
  )
}
