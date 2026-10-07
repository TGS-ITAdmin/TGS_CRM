const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { ROLES, permissionMap, effectivePermissions } = require('./lib/permissions')

const { Schema, model } = mongoose

/* ------------------------------------------------------------------ */
/* Shared vocabularies                                                  */
/* ------------------------------------------------------------------ */

const CHANNELS = ['linkedin', 'email', 'call']

// Default contact lifecycle list. Editable by an admin in Settings — the values
// are stored as free strings on the contact, so renaming a status never breaks
// an existing record.
/* Contact lifecycle. Deliberately has no Won or Lost — those belong to the
   Deal. Two objects both claiming to say whether you won will disagree, and
   then no report can be trusted. Winning a deal sets its contacts to Customer. */
const DEFAULT_STATUSES = [
  { value: 'new', label: 'New', color: '#64748b', funnelOrder: 0 },
  { value: 'contacted', label: 'Contacted', color: '#0ea5e9', funnelOrder: 1 },
  { value: 'engaged', label: 'Engaged / Replied', color: '#6366f1', funnelOrder: 2 },
  { value: 'meeting_booked', label: 'Meeting Booked', color: '#8b5cf6', funnelOrder: 3 },
  { value: 'qualified', label: 'Qualified', color: '#f59e0b', funnelOrder: 4 },
  { value: 'customer', label: 'Customer', color: '#16a34a', funnelOrder: 5 },
  { value: 'nurture', label: 'Nurture', color: '#0d9488', funnelOrder: 6 },
  { value: 'dnc', label: 'Do Not Contact', color: '#334155', funnelOrder: 7 },
]

// Cold-call dispositions. `bookedMeeting` / `positive` drive the channel report.
const CALL_OUTCOMES = [
  { value: 'connected', label: 'Connected', positive: true },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'gatekeeper', label: 'Gatekeeper' },
  { value: 'wrong_number', label: 'Wrong Number' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'callback_requested', label: 'Callback Requested', positive: true },
  { value: 'meeting_booked', label: 'Meeting Booked', positive: true, bookedMeeting: true },
]

/* ------------------------------------------------------------------ */
/* User                                                                 */
/* ------------------------------------------------------------------ */

const smtpSchema = new Schema(
  {
    host: String,
    port: { type: Number, default: 587 },
    secure: { type: Boolean, default: false },
    user: String,
    pass: String, // stored as given; see README for the credential-handling note
    fromName: String,
    fromEmail: String,
  },
  { _id: false }
)

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: 'rep', index: true },
    /* Sparse per-user overrides on top of the role preset: { key: true|false }.
       Only entries that differ from the role default are stored, so changing a
       preset later still reaches everyone who was left on it. */
    permissions: { type: Object, default: {} },
    /* Which campaigns this person may add or move contacts into. Empty means
       all of them — the default, so nothing changes for existing users. */
    allowedCampaigns: [{ type: Schema.Types.ObjectId, ref: 'Campaign' }],
    // Per-user timezone. No app-wide default: a distributed team each sets
    // their own, and the call list renders contact-local times against it.
    timezone: { type: String, default: 'Asia/Manila' },
    notificationsEnabled: { type: Boolean, default: true },
    smtp: { type: smtpSchema, default: () => ({}) },
    active: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: Date,

    /* Home dashboard: an ordered list of { widget, size }. Empty means "use
       whatever the admin set as the default", so a new joiner gets a sensible
       screen without configuring anything. */
    dashboard: { type: [Object], default: [] },
    /* A Google or Outlook calendar embed URL the user pastes in themselves.
       Read-only and iframed — no OAuth, and the CRM never sees the events. */
    calendarEmbedUrl: { type: String, default: '' },
  },
  { timestamps: true }
)

userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    timezone: this.timezone,
    notificationsEnabled: this.notificationsEnabled,
    active: this.active,
    mustChangePassword: this.mustChangePassword,
    smtpConfigured: !!(this.smtp && this.smtp.host && this.smtp.user),
    // What this person can actually do, already resolved — the client should
    // never have to re-derive it from role plus overrides and risk disagreeing
    // with the server.
    can: permissionMap(this),
    permissions: this.permissions || {},
    permissionDetail: effectivePermissions(this),
    allowedCampaigns: (this.allowedCampaigns || []).map(String),
    dashboard: this.dashboard || [],
    calendarEmbedUrl: this.calendarEmbedUrl || '',
    smtp: this.smtp
      ? {
          host: this.smtp.host || '',
          port: this.smtp.port || 587,
          secure: !!this.smtp.secure,
          user: this.smtp.user || '',
          fromName: this.smtp.fromName || '',
          fromEmail: this.smtp.fromEmail || '',
          hasPassword: !!this.smtp.pass,
        }
      : null,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  }
}

/* ------------------------------------------------------------------ */
/* Settings (singleton)                                                 */
/* ------------------------------------------------------------------ */

/* Quote approval defaults. Exported so callers can fall back to them rather
   than to {} — an approval control that silently defaults to "off" on an
   existing install is the wrong way round to fail. */
const DEFAULT_QUOTE_APPROVAL = {
  anyDiscount: { enabled: true },
  valueOver: { enabled: true, amount: 250000 },
  discountOver: { enabled: true, percent: 15 },
  rateFloor: { enabled: true },
  minTerm: { enabled: true, months: 12 },
}

const settingsSchema = new Schema(
  {
    key: { type: String, default: 'global', unique: true },
    companyName: { type: String, default: 'TGS BPO' },
    // CAN-SPAM requires a valid physical postal address in every commercial
    // email. Sends are blocked until this is filled in.
    physicalAddress: { type: String, default: '' },
    unsubscribeText: {
      type: String,
      default: 'If you would rather not hear from us, you can opt out here:',
    },
    appBaseUrl: { type: String, default: '' },
    contactStatuses: { type: [Object], default: DEFAULT_STATUSES },
    dealStages: { type: [Object], default: () => DEFAULT_DEAL_STAGES },
    currencies: { type: [Object], default: () => DEFAULT_CURRENCIES },
    reportingCurrency: { type: String, default: 'USD' },
    lostReasons: {
      type: [String],
      default: () => [
        'Price too high', 'Went with a competitor', 'No budget', 'Timing — revisit later',
        'Kept it in-house', 'No decision made', 'Unresponsive', 'Not a fit',
      ],
    },
    /* Quote approval rules. Each is independently switchable — a shop that
       only cares about the rate floor should not have to accept a value
       threshold it does not want. */
    quoteApproval: { type: Object, default: () => ({ ...DEFAULT_QUOTE_APPROVAL }) },
    quoteValidDays: { type: Number, default: 30 },
    quoteTerms: {
      type: String,
      default:
        'This quote is valid until the date shown above. Rates are exclusive of applicable taxes. ' +
        'Service commences once a signed agreement and the initial invoice are settled.',
    },
    quoteNumberPrefix: { type: String, default: 'Q' },
    // Used on the quote PDF and the public quote page.
    brandColor: { type: String, default: '#2563eb' },
    defaultDashboard: {
      type: [Object],
      default: () => [
        { widget: 'my_work', size: 'md' },
        { widget: 'forecast_summary', size: 'md' },
        { widget: 'pipeline_by_stage', size: 'lg' },
        { widget: 'my_deals', size: 'md' },
        { widget: 'stale_deals', size: 'md' },
      ],
    },
    defaultSmtp: { type: smtpSchema, default: () => ({}) },
    publicFormEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
)

/* ------------------------------------------------------------------ */
/* Company — the buying organisation                                    */
/* ------------------------------------------------------------------ */
/* Qualification lives here, not on the person: seats, target roles and
   contract timing describe the organisation, and every contact there shares
   them. A new deal prefills from the company. */

const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Normalised email domain — the dedupe key that actually works.
    domain: { type: String, trim: true, lowercase: true, default: '' },
    website: { type: String, trim: true, default: '' },
    industry: { type: String, trim: true, default: '' },
    employeeCount: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    linkedinUrl: { type: String, trim: true, default: '' },
    location: { type: String, trim: true, default: '' },
    timezone: { type: String, default: '' },
    address: { type: String, default: '' },
    description: { type: String, default: '' },

    // BPO qualification
    currentProvider: { type: String, trim: true, default: '' },
    seatsNeeded: { type: Number, default: null },
    targetRoles: { type: String, trim: true, default: '' },
    contractTiming: { type: String, trim: true, default: '' },
    budgetRange: { type: String, trim: true, default: '' },

    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    tags: { type: [String], default: [], index: true },
    notes: { type: String, default: '' },
    source: { type: String, trim: true, default: 'manual' },
    customFields: { type: Object, default: {} },

    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
)

companySchema.index(
  { domain: 1 },
  { unique: true, partialFilterExpression: { domain: { $gt: '' } } }
)
companySchema.index({ name: 1 })
companySchema.index({ name: 'text', domain: 'text' })

/* ------------------------------------------------------------------ */
/* Contact — a person                                                   */
/* ------------------------------------------------------------------ */
/* Formerly "Lead". Status here is a lifecycle only: won and lost belong to
   the Deal, so there is exactly one source of truth for whether you won. */

const contactSchema = new Schema(
  {
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    title: { type: String, trim: true, default: '' },
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true, default: null },
    // Kept for imports and orphan contacts that have no company record yet.
    companyName: { type: String, trim: true, default: '' },

    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    mobile: { type: String, trim: true, default: '' },
    linkedinUrl: { type: String, trim: true, default: '' },
    location: { type: String, trim: true, default: '' },
    timezone: { type: String, default: '' },

    source: { type: String, trim: true, default: 'manual' },
    status: { type: String, default: 'new', index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    tags: { type: [String], default: [], index: true },
    notes: { type: String, default: '' },
    customFields: { type: Object, default: {} },

    doNotContact: { type: Boolean, default: false, index: true },
    unsubscribedAt: { type: Date, default: null },
    unsubscribeToken: {
      type: String,
      default: () => crypto.randomBytes(24).toString('hex'),
      index: true,
    },

    lastActivityAt: { type: Date, default: Date.now, index: true },
    lastContactedAt: { type: Date, default: null },
  },
  { timestamps: true }
)

// Dedupe keys. Partial so the many contacts with no email (call-only lists)
// don't collide on empty string.
contactSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: '' } } }
)
contactSchema.index(
  { linkedinUrl: 1 },
  { unique: true, partialFilterExpression: { linkedinUrl: { $gt: '' } } }
)
contactSchema.index({ firstName: 'text', lastName: 'text', companyName: 'text', email: 'text' })
contactSchema.index({ owner: 1, status: 1 })
contactSchema.index({ company: 1, status: 1 })
contactSchema.index({ createdAt: -1 })

contactSchema.virtual('fullName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ').trim()
})
contactSchema.set('toJSON', { virtuals: true })
contactSchema.set('toObject', { virtuals: true })

// True when this contact must not be emailed, for any reason.
contactSchema.methods.isSuppressed = function () {
  return !!(this.doNotContact || this.unsubscribedAt || this.status === 'dnc')
}

/* ------------------------------------------------------------------ */
/* Suppression list (global DNC)                                        */
/* ------------------------------------------------------------------ */

const suppressionSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true, default: '' },
    linkedinUrl: { type: String, trim: true, default: '' },
    domain: { type: String, lowercase: true, trim: true, default: '' },
    reason: { type: String, default: 'manual' },
    note: { type: String, default: '' },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)
suppressionSchema.index({ email: 1 })
suppressionSchema.index({ domain: 1 })
suppressionSchema.index({ linkedinUrl: 1 })

/* ------------------------------------------------------------------ */
/* Campaign                                                             */
/* ------------------------------------------------------------------ */

const stageSchema = new Schema({
  name: { type: String, required: true },
  channel: { type: String, enum: CHANNELS, required: true },
  // Email only
  subject: { type: String, default: '' },
  // The message (LinkedIn / email) or the call script. Supports {{merge|fallback}}.
  body: { type: String, default: '' },
  // Days to wait after entering this stage before the contact is due to move on.
  waitDays: { type: Number, default: 3, min: 0 },
})

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    stages: { type: [stageSchema], default: [] },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

campaignSchema.virtual('channels').get(function () {
  return [...new Set((this.stages || []).map((s) => s.channel))]
})
campaignSchema.set('toJSON', { virtuals: true })
campaignSchema.set('toObject', { virtuals: true })

/* ------------------------------------------------------------------ */
/* Enrollment — one contact's run through one campaign                  */
/* ------------------------------------------------------------------ */
/* A contact may hold several ACTIVE enrollments at once (LinkedIn campaign
   and email campaign in parallel). Moving between campaigns exits the old
   enrollment and cancels its pending work, but the enrollment row and every
   activity it produced stay on the timeline forever.                    */

const enrollmentSchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    currentStageIndex: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'completed', 'exited'],
      default: 'active',
      index: true,
    },
    enteredStageAt: { type: Date, default: Date.now },
    // When the stage engine should advance this contact. Null = waiting on a human.
    dueAt: { type: Date, default: null, index: true },
    history: {
      type: [
        {
          stageIndex: Number,
          stageName: String,
          channel: String,
          enteredAt: Date,
          leftAt: Date,
          _id: false,
        },
      ],
      default: [],
    },
    exitReason: { type: String, default: '' },
    exitedAt: { type: Date, default: null },
    enrolledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

enrollmentSchema.index({ contact: 1, campaign: 1, status: 1 })
enrollmentSchema.index({ status: 1, dueAt: 1 })

/* ------------------------------------------------------------------ */
/* Task — a LinkedIn or call action a human must perform                */
/* ------------------------------------------------------------------ */

const taskSchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    enrollment: { type: Schema.Types.ObjectId, ref: 'Enrollment', index: true },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    stageIndex: { type: Number, default: 0 },
    stageName: { type: String, default: '' },
    channel: { type: String, enum: CHANNELS, required: true },
    title: { type: String, required: true },
    // The stage script with merge fields already resolved, ready to use.
    scriptBody: { type: String, default: '' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    dueAt: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ['pending', 'done', 'cancelled', 'skipped'],
      default: 'pending',
      index: true,
    },
    outcome: { type: String, default: '' }, // call disposition
    notes: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // Manual reminders (callbacks) are not tied to a campaign stage.
    isManual: { type: Boolean, default: false },
  },
  { timestamps: true }
)

taskSchema.index({ assignedTo: 1, status: 1, dueAt: 1 })
taskSchema.index({ status: 1, dueAt: 1 })

/* ------------------------------------------------------------------ */
/* OutboxMessage — the Ready-to-Send approval queue                     */
/* ------------------------------------------------------------------ */

const outboxSchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    enrollment: { type: Schema.Types.ObjectId, ref: 'Enrollment', index: true },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    stageIndex: { type: Number, default: 0 },
    stageName: { type: String, default: '' },
    to: { type: String, required: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' }, // merged, editable before send
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed', 'cancelled', 'suppressed'],
      default: 'queued',
      index: true,
    },
    // Exact bytes that left the building, footer and all.
    sentBody: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
    error: { type: String, default: '' },
    dueAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
)

outboxSchema.index({ assignedTo: 1, status: 1, dueAt: 1 })
outboxSchema.index({ status: 1, createdAt: -1 })

/* ------------------------------------------------------------------ */
/* Deal — revenue, and the only thing that owns Won and Lost            */
/* ------------------------------------------------------------------ */

/* Pipeline stages live in Settings so an admin can rename them without a
   deploy. Won and Lost are stages with a terminal `type`, not a separate
   field — a deal is in exactly one place at a time. */
const DEFAULT_DEAL_STAGES = [
  { key: 'discovery', name: 'Discovery', probability: 10, type: 'open', color: '#64748b', order: 0 },
  { key: 'scoping', name: 'Scoping / Requirements', probability: 25, type: 'open', color: '#0ea5e9', order: 1 },
  { key: 'proposal', name: 'Proposal Sent', probability: 50, type: 'open', color: '#6366f1', order: 2 },
  { key: 'pilot', name: 'Pilot / Trial', probability: 70, type: 'open', color: '#8b5cf6', order: 3 },
  { key: 'contract', name: 'Contract', probability: 90, type: 'open', color: '#f59e0b', order: 4 },
  { key: 'won', name: 'Won', probability: 100, type: 'won', color: '#16a34a', order: 5 },
  { key: 'lost', name: 'Lost', probability: 0, type: 'lost', color: '#dc2626', order: 6 },
]

/* Rates are "one unit of this currency, in USD". Admin-maintained: there is
   no live FX feed, and pretending otherwise would be worse than being explicit. */
const DEFAULT_CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'PHP', symbol: '₱', rate: 0.0175 },
  { code: 'GBP', symbol: '£', rate: 1.27 },
  { code: 'AUD', symbol: 'A$', rate: 0.66 },
  { code: 'EUR', symbol: '€', rate: 1.08 },
  { code: 'CAD', symbol: 'C$', rate: 0.73 },
]

/* What a rep is willing to stand behind, separate from the statistical
   weighting. Stage probability alone is reliably optimistic. */
const FORECAST_CATEGORIES = [
  { value: 'commit', label: 'Commit', description: 'You are confident this closes this period', color: '#16a34a' },
  { value: 'best_case', label: 'Best case', description: 'Realistic upside if things go well', color: '#0ea5e9' },
  { value: 'pipeline', label: 'Pipeline', description: 'Live, but not yet forecastable', color: '#64748b' },
  { value: 'omitted', label: 'Omitted', description: 'Excluded from the forecast entirely', color: '#94a3b8' },
]

const PRICING_MODELS = ['per_seat_monthly', 'one_time', 'hourly', 'per_unit']

const lineItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    pricingModel: { type: String, enum: PRICING_MODELS, default: 'per_seat_monthly' },
    // Seats, hours per month, or units per month depending on the model.
    quantity: { type: Number, default: 1, min: 0 },
    listPrice: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    order: { type: Number, default: 0 },
  },
  { _id: true }
)

const dealSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    primaryContact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null, index: true },
    contacts: [{ type: Schema.Types.ObjectId, ref: 'Contact' }],

    stage: { type: String, required: true, index: true },
    // Copied from the stage on entry, then overridable per deal.
    probability: { type: Number, default: 10, min: 0, max: 100 },
    status: { type: String, enum: ['open', 'won', 'lost'], default: 'open', index: true },
    forecastCategory: {
      type: String,
      enum: ['commit', 'best_case', 'pipeline', 'omitted'],
      default: 'pipeline',
      index: true,
    },

    // ---- Money ----
    currency: { type: String, default: 'USD' },
    // Stamped when the deal is saved so historical reports don't shift when an
    // admin later updates the rate table.
    fxRate: { type: Number, default: 1 },
    pricingMode: { type: String, enum: ['manual', 'line_items'], default: 'manual' },
    // Manual mode: the total contract value the rep typed.
    amount: { type: Number, default: 0, min: 0 },
    lineItems: { type: [lineItemSchema], default: [] },
    termMonths: { type: Number, default: 12, min: 0 },

    // Derived on every save — never set these by hand.
    mrr: { type: Number, default: 0 },
    oneTimeTotal: { type: Number, default: 0 },
    tcv: { type: Number, default: 0 },
    mrrUsd: { type: Number, default: 0 },
    tcvUsd: { type: Number, default: 0 },

    expectedCloseDate: { type: Date, default: null, index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    source: { type: String, default: 'manual' },
    // Which outreach campaign produced this, when it came from one.
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },

    stageEnteredAt: { type: Date, default: Date.now },
    stageHistory: {
      type: [
        {
          stage: String,
          stageName: String,
          enteredAt: Date,
          leftAt: Date,
          probability: Number,
          _id: false,
        },
      ],
      default: [],
    },

    wonAt: { type: Date, default: null },
    lostAt: { type: Date, default: null },
    lostReason: { type: String, default: '' },
    closedNotes: { type: String, default: '' },

    tags: { type: [String], default: [] },
    notes: { type: String, default: '' },
    customFields: { type: Object, default: {} },
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
)

dealSchema.index({ status: 1, expectedCloseDate: 1 })
dealSchema.index({ owner: 1, status: 1 })
dealSchema.index({ company: 1, status: 1 })
dealSchema.index({ stage: 1, status: 1 })
dealSchema.index({ name: 'text' })

/* ------------------------------------------------------------------ */
/* Product — the rate card                                              */
/* ------------------------------------------------------------------ */

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, default: '' },
    description: { type: String, default: '' },
    category: { type: String, trim: true, default: '' },
    pricingModel: { type: String, enum: PRICING_MODELS, default: 'per_seat_monthly' },
    currency: { type: String, default: 'USD' },
    listPrice: { type: Number, default: 0, min: 0 },
    /* The lowest price a rep may quote without an admin signing off. This is
       the guard that actually protects margin — a discount percentage alone
       says nothing about whether the resulting rate is still viable. */
    floorPrice: { type: Number, default: 0, min: 0 },
    // Optional unit cost, so a quote can show the margin it leaves.
    unitCost: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

productSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $gt: '' } } }
)
productSchema.index({ name: 1 })

/* ------------------------------------------------------------------ */
/* Quote                                                                */
/* ------------------------------------------------------------------ */

const QUOTE_STATUSES = [
  'draft',             // being built, nobody outside has seen it
  'pending_approval',  // breached an approval rule, waiting on an admin
  'rejected',          // an admin said no
  'approved',          // cleared to share
  'sent',              // the rep marked it as sent to the client
  'accepted',          // the client accepted it on the public link
  'declined',          // the client declined it on the public link
  'expired',           // valid-until passed without a decision
  'superseded',        // a newer version replaced it
]

/* Quote lines are a SNAPSHOT, not a reference. If a product's rate changes
   next month, the quote a client is looking at must not change underneath
   them — so name, price and floor are all copied at build time, and `product`
   is kept only for reporting. */
const quoteLineSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    pricingModel: { type: String, enum: PRICING_MODELS, default: 'per_seat_monthly' },
    quantity: { type: Number, default: 1, min: 0 },
    listPrice: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    floorPrice: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    order: { type: Number, default: 0 },
  },
  { _id: true }
)

const quoteSchema = new Schema(
  {
    number: { type: String, required: true, index: true },
    version: { type: Number, default: 1 },
    // A sent quote is never edited in place; a new version supersedes it, so
    // what the client accepted stays exactly what the client saw.
    supersedes: { type: Schema.Types.ObjectId, ref: 'Quote', default: null },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'Quote', default: null },

    deal: { type: Schema.Types.ObjectId, ref: 'Deal', required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },

    status: { type: String, enum: QUOTE_STATUSES, default: 'draft', index: true },
    title: { type: String, default: '' },
    introMessage: { type: String, default: '' },
    terms: { type: String, default: '' },

    lineItems: { type: [quoteLineSchema], default: [] },
    currency: { type: String, default: 'USD' },
    fxRate: { type: Number, default: 1 },
    termMonths: { type: Number, default: 12, min: 0 },
    mrr: { type: Number, default: 0 },
    oneTimeTotal: { type: Number, default: 0 },
    tcv: { type: Number, default: 0 },
    mrrUsd: { type: Number, default: 0 },
    tcvUsd: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },

    validUntil: { type: Date, default: null },

    /* Approval. `reasons` is the list of rules the quote breached, recorded at
       submit time so the admin sees why it landed on their desk. */
    approvalReasons: { type: [Object], default: [] },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decisionNote: { type: String, default: '' },

    // The rep sends the quote themselves; this records that they say they did.
    sentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User' },

    /* Public accept/decline. The token is the only thing standing between a
       stranger and a signature, so it is long and random. */
    publicToken: {
      type: String,
      default: () => crypto.randomBytes(24).toString('hex'),
      index: true,
    },
    firstViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    acceptedAt: { type: Date, default: null },
    acceptedName: { type: String, default: '' },
    acceptedIp: { type: String, default: '' },
    declinedAt: { type: Date, default: null },
    declineReason: { type: String, default: '' },

    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
)

quoteSchema.index({ deal: 1, version: -1 })
quoteSchema.index({ status: 1, createdAt: -1 })
quoteSchema.index({ number: 1, version: 1 }, { unique: true })

// Counter used to hand out sequential quote numbers without a race.
const counterSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
})

/* ------------------------------------------------------------------ */
/* CustomField — fields an admin adds without a deploy                  */
/* ------------------------------------------------------------------ */

const CUSTOM_FIELD_OBJECTS = ['company', 'contact', 'deal']

const CUSTOM_FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date',
  'select', 'multiselect', 'checkbox', 'url', 'formula',
]

const customFieldSchema = new Schema(
  {
    object: { type: String, enum: CUSTOM_FIELD_OBJECTS, required: true, index: true },
    // Stable storage key. Renaming the label is safe; renaming the key orphans
    // every value already stored under the old one, so the API refuses it.
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: CUSTOM_FIELD_TYPES, default: 'text' },
    options: { type: [String], default: [] },
    helpText: { type: String, default: '' },

    // formula only — arithmetic over other numeric fields, never JavaScript.
    formula: { type: String, default: '' },

    required: { type: Boolean, default: false },
    /* Deal only. A deal cannot move past this stage until the field is filled.
       Enforced server-side on the stage change, not just hidden in the UI. */
    requiredAtStage: { type: String, default: '' },

    showInTable: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

customFieldSchema.index({ object: 1, key: 1 }, { unique: true })
customFieldSchema.index({ object: 1, order: 1 })

/* ------------------------------------------------------------------ */
/* SavedView — a named filter set                                       */
/* ------------------------------------------------------------------ */

const SAVED_VIEW_OBJECTS = ['contact', 'company', 'deal', 'quote']

const savedViewSchema = new Schema(
  {
    object: { type: String, enum: SAVED_VIEW_OBJECTS, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // The query string params the list page was showing when it was saved.
    filters: { type: Object, default: {} },
    columns: { type: [String], default: [] },
    sort: { type: String, default: '' },
    dir: { type: String, default: 'desc' },

    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Shared views are visible to everyone but still only editable by the owner
    // (or an admin) — otherwise one person's tidy-up breaks the team's tabs.
    shared: { type: Boolean, default: false, index: true },
    // Pinning is per user, so sharing a view never forces it into a colleague's tabs.
    pinnedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
)

savedViewSchema.index({ object: 1, owner: 1 })
savedViewSchema.index({ object: 1, shared: 1 })

/* ------------------------------------------------------------------ */
/* Activity — the immutable timeline                                    */
/* ------------------------------------------------------------------ */

const ACTIVITY_TYPES = [
  'contact_created',
  'contact_imported',
  'contact_merged',
  'company_created',
  'note',
  'status_change',
  'owner_change',
  'campaign_enrolled',
  'campaign_exited',
  'campaign_completed',
  'stage_advanced',
  'email_sent',
  'email_failed',
  'email_suppressed',
  'email_opened',
  'email_clicked',
  'linkedin_action',
  'call_logged',
  'meeting_logged',
  'task_cancelled',
  'unsubscribed',
  'dnc_added',
  'reply_logged',
  'deal_created',
  'deal_stage_changed',
  'deal_won',
  'deal_lost',
  'quote_created',
  'quote_submitted',
  'quote_approved',
  'quote_rejected',
  'quote_sent',
  'quote_viewed',
  'quote_accepted',
  'quote_declined',
  'quote_superseded',
  'automation_ran',
  'file_attached',
  'records_merged',
]

/* An activity hangs off whichever records it concerns. A call is logged on a
   contact; a deal stage change on a deal and its company. Denormalising all
   three keeps the company timeline — "everything that ever happened with
   Acme" — a single indexed query rather than a fan-out. */
const activitySchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', index: true, default: null },
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true, default: null },
    deal: { type: Schema.Types.ObjectId, ref: 'Deal', index: true, default: null },
    type: { type: String, enum: ACTIVITY_TYPES, required: true, index: true },
    channel: { type: String, enum: [...CHANNELS, ''], default: '' },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    stageIndex: { type: Number, default: null },
    outcome: { type: String, default: '' },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
)

activitySchema.index({ contact: 1, createdAt: -1 })
activitySchema.index({ company: 1, createdAt: -1 })
activitySchema.index({ deal: 1, createdAt: -1 })
activitySchema.index({ createdAt: -1, type: 1 })
activitySchema.index({ campaign: 1, type: 1, createdAt: -1 })
activitySchema.index({ user: 1, type: 1, createdAt: -1 })

/* ------------------------------------------------------------------ */

const User = model('User', userSchema)
const Settings = model('Settings', settingsSchema)
const Company = model('Company', companySchema)
const Contact = model('Contact', contactSchema)
const Suppression = model('Suppression', suppressionSchema)
const Campaign = model('Campaign', campaignSchema)
const Deal = model('Deal', dealSchema)
const Product = model('Product', productSchema)
const Quote = model('Quote', quoteSchema)
const CustomField = model('CustomField', customFieldSchema)
const SavedView = model('SavedView', savedViewSchema)
const Counter = model('Counter', counterSchema)
const Enrollment = model('Enrollment', enrollmentSchema)
const Task = model('Task', taskSchema)
const OutboxMessage = model('OutboxMessage', outboxSchema)
const Activity = model('Activity', activitySchema)

async function connect() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/tgs_crm'
  await mongoose.connect(uri)
  console.log('[db] connected to', uri.replace(/\/\/[^@]*@/, '//***@'))

  await Settings.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global', appBaseUrl: process.env.APP_BASE_URL || '' } },
    { upsert: true, new: true }
  )

  /* Mongoose applies schema defaults when a document is created, never to one
     that already exists. Without this, every settings field added in a later
     release would read as undefined on an upgraded install — which for an
     approval rule means it silently stops applying. */
  const stored = await Settings.findOne({ key: 'global' }).lean()
  const backfill = {}
  for (const [path, type] of Object.entries(Settings.schema.paths)) {
    if (path === '_id' || path === '__v' || path.includes('.')) continue
    if (stored[path] !== undefined) continue
    if (type.defaultValue === undefined) continue
    backfill[path] = typeof type.defaultValue === 'function'
      ? type.defaultValue.call(null)
      : type.defaultValue
  }
  if (Object.keys(backfill).length) {
    await Settings.updateOne({ key: 'global' }, { $set: backfill })
    console.log(`[db] backfilled new settings defaults: ${Object.keys(backfill).join(', ')}`)
  }

  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@tgsbpo.com').toLowerCase()
  const existing = await User.findOne({ email })
  if (!existing) {
    const { resolveSeedPassword } = require('./lib/preflight')
    const { password, generated } = resolveSeedPassword()
    await User.create({
      name: 'Administrator',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'admin',
      mustChangePassword: true,
    })
    if (generated) {
      // Printed once, and only once — the hash is all that is stored.
      console.log(
        `\n[db] Created the first admin account:\n` +
        `       email:    ${email}\n` +
        `       password: ${password}\n` +
        `     This is shown once. Sign in and change it.\n`
      )
    } else {
      console.log(`[db] seeded admin ${email} — change this password on first login`)
    }
  }
}

module.exports = {
  connect,
  mongoose,
  User,
  Settings,
  Company,
  Contact,
  Suppression,
  Campaign,
  Deal,
  Product,
  Quote,
  Counter,
  CustomField,
  SavedView,
  Enrollment,
  Task,
  OutboxMessage,
  Activity,
  CHANNELS,
  CALL_OUTCOMES,
  DEFAULT_STATUSES,
  DEFAULT_DEAL_STAGES,
  DEFAULT_CURRENCIES,
  DEFAULT_QUOTE_APPROVAL,
  FORECAST_CATEGORIES,
  PRICING_MODELS,
  QUOTE_STATUSES,
  CUSTOM_FIELD_OBJECTS,
  CUSTOM_FIELD_TYPES,
  SAVED_VIEW_OBJECTS,
  ACTIVITY_TYPES,
}
