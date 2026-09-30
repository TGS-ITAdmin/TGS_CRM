const TOKEN_KEY = 'crm_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.status = status
    this.payload = payload || {}
  }
}

async function request(method, path, body, opts = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let payload = body
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const res = await fetch(path, { method, headers, body: payload })

  if (res.status === 401 && !opts.allowUnauthorized) {
    clearToken()
    if (!location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError('Session expired', 401)
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json')
  const data = isJson ? await res.json() : await res.text()

  if (!res.ok) {
    throw new ApiError(
      (data && data.error) || `Request failed (${res.status})`,
      res.status,
      data
    )
  }
  return data
}

const qs = (params = {}) => {
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  )
  return usable.length ? `?${new URLSearchParams(usable)}` : ''
}

export const api = {
  ApiError,

  // auth
  login: (email, password) =>
    request('POST', '/api/auth/login', { email, password }, { allowUnauthorized: true }),
  me: () => request('GET', '/api/auth/me'),
  updateMe: (body) => request('PUT', '/api/auth/me', body),
  changePassword: (body) => request('POST', '/api/auth/change-password', body),

  // bootstrap + settings
  bootstrap: () => request('GET', '/api/settings/bootstrap'),
  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (body) => request('PUT', '/api/settings', body),
  saveDealStages: (stages) => request('PUT', '/api/settings/deal-stages', { stages }),
  saveCurrencies: (currencies, reportingCurrency) =>
    request('PUT', '/api/settings/currencies', { currencies, reportingCurrency }),
  getQuoteApproval: () => request('GET', '/api/settings/quote-approval'),
  saveQuoteApproval: (body) => request('PUT', '/api/settings/quote-approval', body),
  smtpStatus: () => request('GET', '/api/settings/smtp/status'),
  saveMySmtp: (body) => request('PUT', '/api/settings/smtp/mine', body),
  saveSharedSmtp: (body) => request('PUT', '/api/settings/smtp/shared', body),
  testSmtp: (scope) => request('POST', '/api/settings/smtp/test', { scope }),
  listUsers: () => request('GET', '/api/settings/users'),
  removeUser: (id) => request('DELETE', `/api/settings/users/${id}`),
  createUser: (body) => request('POST', '/api/settings/users', body),
  updateUser: (id, body) => request('PUT', `/api/settings/users/${id}`, body),
  listSuppressions: (q) => request('GET', `/api/settings/suppressions${qs({ q })}`),
  addSuppression: (body) => request('POST', '/api/settings/suppressions', body),
  removeSuppression: (id) => request('DELETE', `/api/settings/suppressions/${id}`),

  // custom fields
  listCustomFields: (params) => request('GET', `/api/custom-fields${qs(params)}`),
  referenceableFields: (object) => request('GET', `/api/custom-fields/referenceable/${object}`),
  validateFormula: (object, formula) => request('POST', '/api/custom-fields/validate-formula', { object, formula }),
  createCustomField: (body) => request('POST', '/api/custom-fields', body),
  updateCustomField: (id, body) => request('PUT', `/api/custom-fields/${id}`, body),
  reorderCustomFields: (object, ids) => request('POST', '/api/custom-fields/reorder', { object, ids }),
  deleteCustomField: (id, force) => request('DELETE', `/api/custom-fields/${id}${qs({ force })}`),

  // saved views
  listViews: (object) => request('GET', `/api/views${qs({ object })}`),
  createView: (body) => request('POST', '/api/views', body),
  updateView: (id, body) => request('PUT', `/api/views/${id}`, body),
  duplicateView: (id) => request('POST', `/api/views/${id}/duplicate`),
  pinView: (id, pinned) => request('POST', `/api/views/${id}/pin`, { pinned }),
  deleteView: (id, force) => request('DELETE', `/api/views/${id}${qs({ force })}`),

  // duplicates and merging
  scanContactDuplicates: () => request('GET', '/api/contacts/duplicates/scan'),
  scanCompanyDuplicates: () => request('GET', '/api/companies/duplicates/scan'),
  previewContactMerge: (keepId, loseId) => request('GET', `/api/contacts/${keepId}/merge-preview/${loseId}`),
  previewCompanyMerge: (keepId, loseId) => request('GET', `/api/companies/${keepId}/merge-preview/${loseId}`),
  mergeContacts: (keepId, loserId) => request('POST', `/api/contacts/${keepId}/merge`, { loserId }),
  mergeCompanies: (keepId, loserId) => request('POST', `/api/companies/${keepId}/merge`, { loserId }),

  // dashboard
  getDashboard: () => request('GET', '/api/dashboard'),
  dashboardCatalogue: () => request('GET', '/api/dashboard/catalogue'),
  saveDashboard: (layout) => request('PUT', '/api/dashboard', { layout }),
  resetDashboard: () => request('POST', '/api/dashboard/reset'),
  saveDefaultDashboard: (layout) => request('PUT', '/api/dashboard/default', { layout }),

  // products (the rate card)
  listProducts: (params) => request('GET', `/api/products${qs(params)}`),
  createProduct: (body) => request('POST', '/api/products', body),
  updateProduct: (id, body) => request('PUT', `/api/products/${id}`, body),
  deleteProduct: (id, force) => request('DELETE', `/api/products/${id}${qs({ force })}`),

  // quotes
  listQuotes: (params) => request('GET', `/api/quotes${qs(params)}`),
  getQuote: (id) => request('GET', `/api/quotes/${id}`),
  createQuote: (body) => request('POST', '/api/quotes', body),
  updateQuote: (id, body) => request('PUT', `/api/quotes/${id}`, body),
  addQuoteLine: (id, body) => request('POST', `/api/quotes/${id}/lines`, body),
  submitQuote: (id) => request('POST', `/api/quotes/${id}/submit`),
  decideQuote: (id, decision, note) => request('POST', `/api/quotes/${id}/decide`, { decision, note }),
  markQuoteSent: (id, note) => request('POST', `/api/quotes/${id}/sent`, { note }),
  reviseQuote: (id) => request('POST', `/api/quotes/${id}/revise`),
  deleteQuote: (id) => request('DELETE', `/api/quotes/${id}`),
  quotePdfUrl: (id) => `/api/quotes/${id}/pdf`,

  // deals
  dealMeta: () => request('GET', '/api/deals/meta'),
  listDeals: (params) => request('GET', `/api/deals${qs(params)}`),
  dealBoard: (params) => request('GET', `/api/deals/board${qs(params)}`),
  getDeal: (id) => request('GET', `/api/deals/${id}`),
  createDeal: (body) => request('POST', '/api/deals', body),
  updateDeal: (id, body) => request('PUT', `/api/deals/${id}`, body),
  setDealStage: (id, body) => request('POST', `/api/deals/${id}/stage`, body),
  reopenDeal: (id, stage) => request('POST', `/api/deals/${id}/reopen`, { stage }),
  addDealContact: (id, body) => request('POST', `/api/deals/${id}/contacts`, body),
  removeDealContact: (id, contactId) => request('DELETE', `/api/deals/${id}/contacts/${contactId}`),
  deleteDeal: (id) => request('DELETE', `/api/deals/${id}`),

  // companies
  listCompanies: (params) => request('GET', `/api/companies${qs(params)}`),
  getCompany: (id) => request('GET', `/api/companies/${id}`),
  createCompany: (body) => request('POST', '/api/companies', body),
  updateCompany: (id, body) => request('PUT', `/api/companies/${id}`, body),
  deleteCompany: (id, force) => request('DELETE', `/api/companies/${id}${qs({ force })}`),
  addContactToCompany: (id, body) => request('POST', `/api/companies/${id}/contacts`, body),
  searchCompanies: (q) => request('GET', `/api/companies/search/quick${qs({ q })}`),

  // contacts
  listContacts: (params) => request('GET', `/api/contacts${qs(params)}`),
  getContact: (id) => request('GET', `/api/contacts/${id}`),
  createContact: (body) => request('POST', '/api/contacts', body),
  updateContact: (id, body) => request('PUT', `/api/contacts/${id}`, body),
  deleteContact: (id) => request('DELETE', `/api/contacts/${id}`),
  addNote: (id, body) => request('POST', `/api/contacts/${id}/notes`, body),
  bulkContacts: (body) => request('POST', '/api/contacts/bulk', body),
  importPreview: (formData) => request('POST', '/api/contacts/import/preview', formData),
  importCommit: (formData) => request('POST', '/api/contacts/import', formData),

  // campaigns
  listCampaigns: (params) => request('GET', `/api/campaigns${qs(params)}`),
  getCampaign: (id) => request('GET', `/api/campaigns/${id}`),
  createCampaign: (body) => request('POST', '/api/campaigns', body),
  updateCampaign: (id, body) => request('PUT', `/api/campaigns/${id}`, body),
  archiveCampaign: (id, force) => request('DELETE', `/api/campaigns/${id}${qs({ force })}`),
  previewStage: (id, index, contactId) =>
    request('POST', `/api/campaigns/${id}/stages/${index}/preview`, { contactId }),
  getBoard: (id) => request('GET', `/api/campaigns/${id}/board`),
  enrollContacts: (id, contactIds) => request('POST', `/api/campaigns/${id}/enroll`, { contactIds }),
  moveContacts: (body) => request('POST', '/api/campaigns/move', body),
  advanceEnrollment: (id) => request('POST', `/api/campaigns/enrollments/${id}/advance`),
  setEnrollmentStage: (id, stageIndex) =>
    request('POST', `/api/campaigns/enrollments/${id}/stage`, { stageIndex }),
  exitEnrollment: (id, reason) => request('POST', `/api/campaigns/enrollments/${id}/exit`, { reason }),
  snoozeEnrollment: (id, days) => request('POST', `/api/campaigns/enrollments/${id}/snooze`, { days }),
  regenerateStage: (id) => request('POST', `/api/campaigns/enrollments/${id}/regenerate`),

  // work
  myDay: () => request('GET', '/api/work/my-day'),
  listTasks: (params) => request('GET', `/api/work/tasks${qs(params)}`),
  callList: (params) => request('GET', `/api/work/call-list${qs(params)}`),
  completeTask: (id, body) => request('POST', `/api/work/tasks/${id}/complete`, body),
  skipTask: (id, reason) => request('POST', `/api/work/tasks/${id}/skip`, { reason }),
  snoozeTask: (id, days) => request('POST', `/api/work/tasks/${id}/snooze`, { days }),
  createTask: (body) => request('POST', '/api/work/tasks', body),
  listOutbox: (params) => request('GET', `/api/work/outbox${qs(params)}`),
  updateOutbox: (id, body) => request('PUT', `/api/work/outbox/${id}`, body),
  sendOutbox: (id, body) => request('POST', `/api/work/outbox/${id}/send`, body),
  sendBatch: (ids) => request('POST', '/api/work/outbox/send-batch', { ids }),
  cancelOutbox: (id, reason) => request('POST', `/api/work/outbox/${id}/cancel`, { reason }),
  precheckOutbox: (ids) => request('POST', '/api/work/outbox/precheck', { ids }),

  // reports
  reportSummary: (params) => request('GET', `/api/reports/summary${qs(params)}`),
  reportFunnel: (params) => request('GET', `/api/reports/funnel${qs(params)}`),
  reportChannels: (params) => request('GET', `/api/reports/channels${qs(params)}`),
  reportReps: (params) => request('GET', `/api/reports/reps${qs(params)}`),
  reportScoreboard: (params) => request('GET', `/api/reports/scoreboard${qs(params)}`),
  reportPipeline: (params) => request('GET', `/api/reports/pipeline${qs(params)}`),
  reportForecast: (params) => request('GET', `/api/reports/forecast${qs(params)}`),

  runScheduler: () => request('POST', '/api/scheduler/run'),
  schedulerStatus: () => request('GET', '/api/scheduler/status'),
}
