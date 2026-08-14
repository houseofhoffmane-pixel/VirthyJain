// Optional email. If SMTP isn't configured, these quietly do nothing so the
// app still works — you can add SMTP later without touching anything else.

const nodemailer = require('nodemailer');

const enabled = !!process.env.SMTP_HOST;
const from = process.env.MAIL_FROM || 'Virthy Jain Physiotherapy <bookings@example.com>';
const practitionerTo = process.env.PRACTITIONER_EMAIL || process.env.SMTP_USER;

const transport = enabled
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

async function send(to, subject, text) {
  if (!transport || !to) {
    console.log(`[email skipped] to=${to} subject="${subject}"`);
    return;
  }
  try {
    await transport.sendMail({ from, to, subject, text });
  } catch (e) {
    console.error('email failed:', e.message);
  }
}

const when = (b) => `${b.starts_at.slice(0, 16).replace(' ', ', ')} (Irish time)`;

async function patientRequested(b, manageUrl) {
  await send(
    b.email,
    'We received your booking request',
    `Hi ${b.name.split(' ')[0]},\n\nThanks — your request for ${b.serviceName} on ${when(b)} is in. ` +
      `Virthy will confirm by email within 24 hours.\n\nWear comfortable clothing you can move in, and bring any relevant scans or referral letters.\n\n` +
      `Need to change or cancel? ${manageUrl}\n\n— Virthy Jain Physiotherapy`,
  );
}
async function practitionerRequested(b) {
  await send(
    practitionerTo,
    `New request: ${b.name}, ${b.serviceName}`,
    `New booking request:\n\n${b.serviceName} — ${b.format}\n${when(b)}\n\n` +
      `Name: ${b.name}\nEmail: ${b.email}\nPhone: ${b.phone || '-'}\nReferred by: ${b.referrer || '-'}\n\n` +
      `Notes:\n${b.notes || '(none)'}\n`,
  );
}
async function patientConfirmed(b, manageUrl) {
  await send(
    b.email,
    'Your appointment is confirmed',
    `Hi ${b.name.split(' ')[0]},\n\nYour appointment is confirmed: ${b.serviceName} on ${when(b)}.\n\n` +
      `Manage it here: ${manageUrl}\n\n— Virthy Jain Physiotherapy`,
  );
}
async function patientCancelled(b) {
  await send(
    b.email,
    'Your appointment has been cancelled',
    `Hi ${b.name.split(' ')[0]},\n\nYour appointment on ${when(b)} has been cancelled. ` +
      `You're welcome to book again any time.\n\n— Virthy Jain Physiotherapy`,
  );
}

module.exports = { patientRequested, practitionerRequested, patientConfirmed, patientCancelled };
