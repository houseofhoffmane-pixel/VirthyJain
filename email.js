// Email delivery. SMTP if configured (recommended), otherwise the server's
// local sendmail. Never throws.

const nodemailer = require('nodemailer');

const from = process.env.MAIL_FROM || 'Virthy Jain Physiotherapy <bookings@example.com>';
const practitionerTo = process.env.PRACTITIONER_EMAIL || process.env.SMTP_USER || '';

let transport;
function getTransport() {
  if (transport !== undefined) return transport;
  if (process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    transport = nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
  }
  return transport;
}

async function send(to, subject, text, html) {
  if (!to) { console.log('[email] no recipient for:', subject); return; }
  try {
    await getTransport().sendMail({ from, to, subject, text, html });
    console.log('[email] sent to', to, '—', subject);
  } catch (e) {
    console.error('[email] failed to', to, '—', e.message);
  }
}

const when = (b) => `${b.starts_at.slice(0, 16).replace(' ', ', ')} (Irish time)`;
const first = (b) => (b.name || '').split(' ')[0];

// --- to Virthy: new request, with Accept / Reject buttons -------------------
async function practitionerRequested(b, acceptUrl, rejectUrl) {
  const text =
    `New booking request\n\n${b.serviceName} — ${b.format}\n${when(b)}\n\n` +
    `Name: ${b.name}\nEmail: ${b.email}\nPhone: ${b.phone || '-'}\nReferred by: ${b.referrer || '-'}\n\n` +
    `Notes:\n${b.notes || '(none)'}\n\n` +
    `ACCEPT: ${acceptUrl}\nREJECT: ${rejectUrl}\n`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="font-family:Georgia,serif">New booking request</h2>
      <p style="font-size:15px"><b>${esc(b.serviceName)}</b> — ${esc(b.format)}<br>${esc(when(b))}</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Name</td><td>${esc(b.name)}</td></tr>
        <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Email</td><td>${esc(b.email)}</td></tr>
        <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Phone</td><td>${esc(b.phone || '-')}</td></tr>
        <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Referred by</td><td>${esc(b.referrer || '-')}</td></tr>
      </table>
      <p style="font-size:14px;background:#F7F4EE;border:1px solid #E4DED1;padding:10px;white-space:pre-wrap">${esc(b.notes || '(none)')}</p>
      <p style="margin:24px 0">
        <a href="${acceptUrl}" style="background:#4E7A5E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;margin-right:10px">✓ Accept</a>
        <a href="${rejectUrl}" style="background:#B4562F;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px">✕ Reject</a>
      </p>
      <p style="font-size:12px;color:#8A9188">Accepting emails the patient a confirmation. Rejecting frees the slot and emails the patient that it isn't available.</p>
    </div>`;
  await send(practitionerTo, `New request: ${b.name}, ${b.serviceName}`, text, html);
}

// --- to patient: request received -------------------------------------------
async function patientRequested(b) {
  await send(
    b.email,
    'We received your booking request',
    `Hi ${first(b)},\n\nThanks — your request for ${b.serviceName} on ${when(b)} is in. ` +
      `Virthy will confirm by email within 24 hours. The slot is held for you in the meantime.\n\n` +
      `Please wear comfortable clothing you can move in, and bring any relevant scans or referral letters.\n\n— Virthy Jain Physiotherapy`,
  );
}

// --- to patient: accepted ---------------------------------------------------
async function patientConfirmed(b) {
  await send(
    b.email,
    'Your appointment is confirmed',
    `Hi ${first(b)},\n\nGood news — your appointment is confirmed:\n${b.serviceName} on ${when(b)}.\n\n` +
      `See you then.\n— Virthy Jain Physiotherapy`,
  );
}

// --- to patient: rejected ---------------------------------------------------
async function patientRejected(b) {
  await send(
    b.email,
    'About your booking request',
    `Hi ${first(b)},\n\nI'm sorry — I'm not able to take ${when(b)} for your ${b.serviceName}. ` +
      `That time is now open again, so please pick another slot on the site, or reply to this email and we'll find one.\n\n— Virthy Jain Physiotherapy`,
  );
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { practitionerRequested, patientRequested, patientConfirmed, patientRejected };
