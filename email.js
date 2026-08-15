// Email delivery for booking requests.
// Priority: SMTP if configured (recommended), otherwise the server's local
// sendmail (works on many shared hosts with no config). Never throws.

const nodemailer = require('nodemailer');

const from = process.env.MAIL_FROM || 'Virthy Jain Physiotherapy <bookings@example.com>';
// Where booking requests are delivered. Falls back to the SMTP user, then to a
// PRACTITIONER_EMAIL you can set to your own address (e.g. your Gmail).
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
    // Zero-config fallback: hand off to the host's local mail transfer agent.
    transport = nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
  }
  return transport;
}

async function send(to, subject, text) {
  if (!to) { console.log('[email] no recipient for:', subject); return; }
  try {
    await getTransport().sendMail({ from, to, subject, text });
    console.log('[email] sent to', to, '—', subject);
  } catch (e) {
    console.error('[email] failed to', to, '—', e.message);
  }
}

const when = (b) => `${b.starts_at.slice(0, 16).replace(' ', ', ')} (Irish time)`;

async function practitionerRequested(b) {
  await send(
    practitionerTo,
    `New booking request: ${b.name}, ${b.serviceName}`,
    `New booking request\n\n` +
      `${b.serviceName} — ${b.format}\n${when(b)}\n\n` +
      `Name: ${b.name}\nEmail: ${b.email}\nPhone: ${b.phone || '-'}\nReferred by: ${b.referrer || '-'}\n\n` +
      `Notes:\n${b.notes || '(none)'}\n\n` +
      `Reply to the patient to confirm or offer another time.`,
  );
}
async function patientRequested(b) {
  await send(
    b.email,
    'We received your booking request',
    `Hi ${b.name.split(' ')[0]},\n\n` +
      `Thanks — your request for ${b.serviceName} on ${when(b)} is in. ` +
      `Virthy will confirm by email within 24 hours.\n\n` +
      `Please wear comfortable clothing you can move in, and bring any relevant scans or referral letters.\n\n` +
      `— Virthy Jain Physiotherapy`,
  );
}

module.exports = { practitionerRequested, patientRequested };
