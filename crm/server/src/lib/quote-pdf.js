const PDFDocument = require('pdfkit')

/* Branded quote PDF.
 *
 * pdfkit's built-in fonts use WinAnsi encoding, which has no glyph for ₱ (and
 * several other currency symbols). Rendering one produces a blank box on a
 * document going to a client, so anything outside the safe set falls back to
 * the ISO code — "PHP 9,000,000.00" rather than a broken character.
 */
const WINANSI_SAFE_SYMBOLS = new Set(['$', '£', '€', '¥', '¢', 'A$', 'C$', 'S$', 'HK$', 'NZ$', 'R$'])

function makeFormatter(currency, symbol) {
  const safe = symbol && [...symbol].every((ch) => WINANSI_SAFE_SYMBOLS.has(ch) || WINANSI_SAFE_SYMBOLS.has(symbol))
  return (n) => {
    const value = (Number(n) || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    return safe ? `${symbol}${value}` : `${currency} ${value}`
  }
}

const PRICING_LABEL = {
  per_seat_monthly: 'per seat / month',
  one_time: 'one-off',
  hourly: 'per hour',
  per_unit: 'per unit',
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/* Returns a Buffer. Kept as a buffer rather than a stream so the caller can
 * set Content-Length and the browser shows a real download progress bar. */
function renderQuotePdf({ quote, company, contact, settings, owner }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const brand = settings.brandColor || '#2563eb'
    const ink = '#12161c'
    const muted = '#626c7a'
    const line = '#e3e6ea'
    const currencies = settings.currencies || []
    const symbol = currencies.find((c) => c.code === quote.currency)?.symbol || ''
    const money = makeFormatter(quote.currency, symbol)

    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right
    const width = right - left

    /* ---- Header ---- */
    doc.rect(0, 0, doc.page.width, 6).fill(brand)

    doc.fillColor(ink).font('Helvetica-Bold').fontSize(18)
      .text(settings.companyName || 'Quote', left, 58)
    if (settings.physicalAddress) {
      doc.font('Helvetica').fontSize(9).fillColor(muted)
        .text(settings.physicalAddress.replace(/\n+/g, ', '), left, doc.y + 2, { width: width * 0.55 })
    }

    const headerTop = 58
    doc.font('Helvetica-Bold').fontSize(22).fillColor(brand)
      .text('QUOTE', left, headerTop, { width, align: 'right' })
    doc.font('Helvetica').fontSize(10).fillColor(muted)
      .text(
        `${quote.number}${quote.version > 1 ? `  ·  version ${quote.version}` : ''}`,
        left, headerTop + 28, { width, align: 'right' }
      )
      .text(`Issued ${fmtDate(quote.sentAt || quote.createdAt)}`, left, doc.y + 2, { width, align: 'right' })
      .text(`Valid until ${fmtDate(quote.validUntil)}`, left, doc.y + 2, { width, align: 'right' })

    let y = Math.max(doc.y, 150) + 18
    doc.moveTo(left, y).lineTo(right, y).strokeColor(line).lineWidth(1).stroke()
    y += 22

    /* ---- Prepared for ---- */
    doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text('PREPARED FOR', left, y)
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(company?.name || '—', left, y + 14)
    let subY = y + 32
    if (contact) {
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
      doc.font('Helvetica').fontSize(10).fillColor(muted)
        .text([name, contact.title].filter(Boolean).join(' · '), left, subY)
      subY = doc.y
      if (contact.email) { doc.text(contact.email, left, subY); subY = doc.y }
    }
    if (company?.address) {
      doc.font('Helvetica').fontSize(9).fillColor(muted)
        .text(company.address.replace(/\n+/g, ', '), left, subY, { width: width * 0.45 })
    }

    if (owner) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(muted)
        .text('PREPARED BY', left, y, { width, align: 'right' })
      doc.font('Helvetica').fontSize(10).fillColor(ink)
        .text(owner.name || '', left, y + 14, { width, align: 'right' })
      if (owner.email) {
        doc.fontSize(9).fillColor(muted).text(owner.email, left, doc.y + 1, { width, align: 'right' })
      }
    }

    y = Math.max(doc.y, subY) + 24

    if (quote.title) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(quote.title, left, y, { width })
      y = doc.y + 6
    }
    if (quote.introMessage) {
      doc.font('Helvetica').fontSize(10).fillColor(muted)
        .text(quote.introMessage, left, y, { width, lineGap: 2 })
      y = doc.y + 10
    }

    /* ---- Line items ----
     * Four columns, no BASIS column: the pricing basis sits under the unit
     * price where it reads as "1,000.00 / per seat / month". A fifth column
     * squeezes the description to the point of wrapping every row. */
    const descX = left
    const descW = width * 0.48
    const qtyX = left + width * 0.48
    const qtyW = width * 0.10
    const unitX = left + width * 0.58
    const unitW = width * 0.20
    const amtX = left + width * 0.78
    const amtW = width * 0.22

    const headerRow = (top) => {
      doc.rect(left, top, width, 22).fill('#f5f6f8')
      doc.font('Helvetica-Bold').fontSize(8).fillColor(muted)
      doc.text('DESCRIPTION', descX + 8, top + 7, { width: descW })
      doc.text('QTY', qtyX, top + 7, { width: qtyW, align: 'right' })
      doc.text('UNIT PRICE', unitX, top + 7, { width: unitW, align: 'right' })
      doc.text('AMOUNT', amtX, top + 7, { width: amtW - 8, align: 'right' })
      return top + 22
    }

    y = headerRow(y)

    for (const item of quote.lineItems || []) {
      // Start a new page before a row would be split across the break.
      if (y > doc.page.height - 190) {
        doc.addPage()
        y = 60
        y = headerRow(y)
      }
      const rowTop = y + 9

      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink)
        .text(item.name, descX + 8, rowTop, { width: descW })
      let descBottom = doc.y
      if (item.description) {
        doc.font('Helvetica').fontSize(8.5).fillColor(muted)
          .text(item.description, descX + 8, descBottom + 1, { width: descW })
        descBottom = doc.y
      }
      if (item.discountPercent > 0) {
        doc.font('Helvetica').fontSize(8.5).fillColor('#d97706')
          .text(`List ${money(item.listPrice)} — ${item.discountPercent}% discount applied`,
            descX + 8, descBottom + 1, { width: descW })
        descBottom = doc.y
      }

      doc.font('Helvetica').fontSize(10).fillColor(ink)
        .text(String(item.quantity), qtyX, rowTop, { width: qtyW, align: 'right' })
      doc.text(money(item.unitPrice), unitX, rowTop, { width: unitW, align: 'right' })
      doc.font('Helvetica').fontSize(8).fillColor(muted)
        .text(PRICING_LABEL[item.pricingModel] || item.pricingModel,
          unitX - 20, doc.y + 1, { width: unitW + 20, align: 'right' })
      const unitBottom = doc.y

      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink)
        .text(money(item.quantity * item.unitPrice), amtX, rowTop, { width: amtW - 8, align: 'right' })

      y = Math.max(descBottom, unitBottom, rowTop + 14) + 9
      doc.moveTo(left, y).lineTo(right, y).strokeColor(line).lineWidth(0.5).stroke()
    }

    /* ---- Totals ---- */
    if (y > doc.page.height - 220) { doc.addPage(); y = 60 }
    y += 16

    const boxLeft = left + width * 0.45
    const boxWidth = right - boxLeft
    const totalRow = (label, value, { bold = false, big = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 12 : 10)
        .fillColor(bold ? ink : muted)
        .text(label, boxLeft, y, { width: boxWidth * 0.55 })
      doc.font('Helvetica-Bold').fontSize(big ? 13 : 10).fillColor(bold ? brand : ink)
        .text(value, boxLeft, y, { width: boxWidth, align: 'right' })
      y = doc.y + 7
    }

    if (quote.mrr > 0) {
      totalRow('Monthly recurring', money(quote.mrr))
      if (quote.termMonths > 0) {
        totalRow(`Over ${quote.termMonths} months`, money(quote.mrr * quote.termMonths))
      }
    }
    if (quote.oneTimeTotal > 0) totalRow('One-off fees', money(quote.oneTimeTotal))

    doc.moveTo(boxLeft, y).lineTo(right, y).strokeColor(line).lineWidth(1).stroke()
    y += 10
    totalRow('Total contract value', money(quote.tcv), { bold: true, big: true })

    /* ---- Terms ---- */
    if (quote.terms) {
      if (y > doc.page.height - 150) { doc.addPage(); y = 60 }
      y += 18
      doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text('TERMS', left, y)
      doc.font('Helvetica').fontSize(9).fillColor(muted)
        .text(quote.terms, left, doc.y + 4, { width: width * 0.75, lineGap: 1.5 })
    }

    /* ---- Footer on every page ---- */
    const range = doc.bufferedPageRange()
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i)
      const footY = doc.page.height - 42
      doc.moveTo(left, footY - 8).lineTo(right, footY - 8).strokeColor(line).lineWidth(0.5).stroke()
      doc.font('Helvetica').fontSize(8).fillColor(muted)
        .text(`${settings.companyName || ''}  ·  ${quote.number}${quote.version > 1 ? ` v${quote.version}` : ''}`,
          left, footY, { width: width * 0.7, lineBreak: false })
        .text(`Page ${i + 1} of ${range.count}`, left, footY, { width, align: 'right', lineBreak: false })
    }

    doc.end()
  })
}

module.exports = { renderQuotePdf }
