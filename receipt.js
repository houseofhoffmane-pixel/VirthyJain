// PDF receipt generation (pdfkit — pure JS, no native build).
const PDFDocument = require('pdfkit');
const config = require('./config');

function money(n) { return '€' + Number(n).toFixed(2); }

function buildReceipt(b, amount) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const p = config.practice;
    // Header
    doc.fillColor('#16201C').font('Helvetica-Bold').fontSize(20).text(p.name);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#6C7A70').text('Physiotherapist registered with CORU');
    if (p.coruReg) doc.text('CORU registration: ' + p.coruReg);
    if (p.address) doc.text(p.address);
    if (p.phone) doc.text(p.phone);
    if (p.email) doc.text(p.email);

    // Accent rule
    doc.moveDown(0.8);
    const y = doc.y;
    doc.moveTo(56, y).lineTo(539, y).lineWidth(2).strokeColor('#B4562F').stroke();
    doc.moveDown(0.8);

    doc.fillColor('#16201C').font('Helvetica-Bold').fontSize(16).text('Receipt');
    doc.moveDown(0.6);

    const receiptNo = 'R-' + (b.token ? b.token.slice(0, 8).toUpperCase() : Date.now().toString(36).toUpperCase());
    const issued = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
    const rows = [
      ['Receipt no.', receiptNo],
      ['Date issued', issued],
      ['Patient', b.name || ''],
      ['Service', b.serviceName || ''],
      ['Appointment', (b.starts_at || '').slice(0, 16)],
      ['Amount paid', money(amount)],
    ];
    doc.fontSize(11);
    rows.forEach(([k, v]) => {
      doc.font('Helvetica-Bold').fillColor('#6C7A70').text(k, { continued: true, width: 460 });
      doc.font('Helvetica').fillColor('#16201C').text('   ' + v);
      doc.moveDown(0.35);
    });

    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#16201C').text('Total paid: ' + money(amount));

    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(9).fillColor('#8A9188').text(
      'This receipt is provided for your records and for private health insurance or Revenue medical-expense claims where applicable. Please retain it. Thank you.',
      { width: 483 },
    );

    doc.end();
  });
}

module.exports = { buildReceipt };
