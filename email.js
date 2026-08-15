// Email delivery + branded HTML templates.
// SMTP if configured (recommended), otherwise the server's local sendmail.
// Never throws.

const nodemailer = require('nodemailer');

const from = process.env.MAIL_FROM || 'Virthy Jain Physiotherapy <bookings@example.com>';
const practitionerTo = process.env.PRACTITIONER_EMAIL || process.env.SMTP_USER || '';
const SITE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

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

// --- helpers ----------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const first = (b) => (b.name || '').split(' ')[0] || 'there';
function prettyWhen(b) {
  const d = new Date(b.starts_at.slice(0, 10) + 'T12:00:00');
  const day = d.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${day} · ${b.starts_at.slice(11, 16)}`;
}
function textWhen(b) { return `${b.starts_at.slice(0, 16).replace(' ', ', ')} (Irish time)`; }

// Branded shell (table-based for email-client compatibility, all inline CSS).
function shell({ accent, badge, badgeColor, heading, bodyHtml, preheader }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EFEAE0">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EFEAE0">${esc(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEAE0;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFDF8;border:1px solid #E4DED1;border-radius:16px;overflow:hidden">
        <tr><td style="height:6px;background:${accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:28px 34px 6px">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;color:#16201C">Virthy&nbsp;Jain<span style="color:#B4562F">.</span></div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6C7A70;margin-top:3px">Physiotherapy · Dublin</div>
        </td></tr>
        ${badge ? `<tr><td style="padding:16px 34px 0"><span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;background:${badgeColor || accent};padding:6px 13px;border-radius:999px">${esc(badge)}</span></td></tr>` : ''}
        <tr><td style="padding:14px 34px 0">
          <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:27px;line-height:1.15;letter-spacing:-0.01em;color:#16201C;margin:0">${heading}</h1>
        </td></tr>
        <tr><td style="padding:14px 34px 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#3D4A42">${bodyHtml}</td></tr>
        <tr><td style="padding:22px 34px 30px">
          <div style="border-top:1px solid #E4DED1;padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.65;color:#8A9188">
            <strong style="color:#6C7A70">Virthy Jain</strong> · Physiotherapist registered with CORU · Dublin<br>
            Just reply to this email if anything changes. Your records are kept in line with GDPR.
          </div>
        </td></tr>
      </table>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#A9AFA6;margin-top:14px;max-width:560px">You're receiving this because you requested a session on the Virthy Jain website.</div>
    </td></tr>
  </table></body></html>`;
}

function detailsCard(b) {
  const rows = [
    ['Service', `${esc(b.serviceName)}${b.durationMinutes ? ` · ${b.durationMinutes} min` : ''}`],
    ['Format', esc(b.formatName || b.format)],
    ['When', `${esc(prettyWhen(b))} <span style="color:#8A9188">(Irish time)</span>`],
  ];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border:1px solid #E4DED1;border-radius:12px;margin:6px 0 4px">
    ${rows.map((r, i) => `<tr>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#6C7A70;padding:${i === 0 ? '16px' : '8px'} 8px 8px 18px;vertical-align:top;white-space:nowrap">${r[0]}</td>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#16201C;padding:${i === 0 ? '16px' : '8px'} 18px 8px 8px;text-align:right">${r[1]}</td>
    </tr>`).join('')}
    <tr><td colspan="2" style="height:8px;font-size:0;line-height:0">&nbsp;</td></tr>
  </table>`;
}
function button(url, label, color) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 4px"><tr>
    <td style="border-radius:999px;background:${color}"><a href="${url}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFF8F0;text-decoration:none;padding:13px 28px;border-radius:999px">${esc(label)}</a></td>
  </tr></table>`;
}
const bringNote =
  `<p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#4A574F">Please wear comfortable clothing you can move in, and bring any relevant scans, referral letters or a list of current medication.</p>`;

// --- to patient: request received (pending) ---------------------------------
async function patientRequested(b) {
  const body =
    `<p style="margin:0 0 14px">Thanks, ${esc(first(b))} — your request is in. I'll confirm it by email within 24 hours, and the slot is held for you until then.</p>` +
    detailsCard(b) + bringNote;
  await send(
    b.email,
    'We received your booking request',
    `Hi ${first(b)},\n\nThanks — your request for ${b.serviceName} on ${textWhen(b)} is in. I'll confirm within 24 hours; the slot is held for you.\n\nWear comfortable clothing you can move in, and bring any relevant scans or referral letters.\n\n— Virthy Jain Physiotherapy`,
    shell({ accent: '#B4562F', badge: 'Request received', heading: `Thanks, ${esc(first(b))} — your request is in`, bodyHtml: body, preheader: `Your ${b.serviceName} on ${prettyWhen(b)} — confirming within 24 hours.` }),
  );
}

// --- to patient: accepted ---------------------------------------------------
async function patientConfirmed(b) {
  const body =
    `<p style="margin:0 0 14px">Good news — your appointment is <strong style="color:#4E7A5E">confirmed</strong>. I look forward to seeing you.</p>` +
    detailsCard(b) + bringNote +
    (SITE ? `<p style="margin:16px 0 0;font-size:13.5px;color:#6C7A70">Need to change something? Just reply to this email.</p>` : '');
  await send(
    b.email,
    `Confirmed — your appointment on ${prettyWhen(b)}`,
    `Hi ${first(b)},\n\nGood news — your appointment is confirmed:\n${b.serviceName} on ${textWhen(b)}.\n\nSee you then.\n— Virthy Jain Physiotherapy`,
    shell({ accent: '#4E7A5E', badge: 'Confirmed', badgeColor: '#4E7A5E', heading: `You're booked in, ${esc(first(b))}`, bodyHtml: body, preheader: `Confirmed: ${b.serviceName} on ${prettyWhen(b)}.` }),
  );
}

// --- to patient: rejected ---------------------------------------------------
async function patientRejected(b) {
  const body =
    `<p style="margin:0 0 14px">I'm sorry, ${esc(first(b))} — I'm not able to take the time you requested. That slot is open again, so you're very welcome to pick another that suits you.</p>` +
    detailsCard(b) +
    (SITE ? button(`${SITE}/#book`, 'Choose another time', '#B4562F') : '') +
    `<p style="margin:14px 0 0;font-size:13.5px;color:#6C7A70">Or just reply to this email and we'll find one together.</p>`;
  await send(
    b.email,
    'About your booking request',
    `Hi ${first(b)},\n\nI'm sorry — I'm not able to take ${textWhen(b)} for your ${b.serviceName}. That time is open again, so please pick another slot on the site${SITE ? ' (' + SITE + '/#book)' : ''}, or reply to this email.\n\n— Virthy Jain Physiotherapy`,
    shell({ accent: '#B4562F', badge: 'Update', heading: 'About your requested time', bodyHtml: body, preheader: 'That time isn\'t available — here\'s how to pick another.' }),
  );
}

// --- to patient: cancelled (after it was confirmed) -------------------------
async function patientCancelled(b) {
  const body =
    `<p style="margin:0 0 14px">I'm sorry, ${esc(first(b))} — I've had to cancel this appointment. That time is open again, and I'd be glad to help you find another that suits you.</p>` +
    detailsCard(b) +
    (SITE ? button(`${SITE}/#book`, 'Book another time', '#B4562F') : '') +
    `<p style="margin:14px 0 0;font-size:13.5px;color:#6C7A70">My apologies for the change — just reply to this email if you'd like a hand.</p>`;
  await send(
    b.email,
    'Your appointment has been cancelled',
    `Hi ${first(b)},\n\nI'm sorry — I've had to cancel your appointment (${b.serviceName} on ${textWhen(b)}). ` +
      `That time is open again, so please rebook on the site${SITE ? ' (' + SITE + '/#book)' : ''} or reply to this email.\n\n— Virthy Jain Physiotherapy`,
    shell({ accent: '#B4562F', badge: 'Cancelled', heading: 'Your appointment has been cancelled', bodyHtml: body, preheader: 'Your appointment was cancelled — here\'s how to rebook.' }),
  );
}

// --- to Virthy: new request with Accept / Reject ----------------------------
async function practitionerRequested(b, acceptUrl, rejectUrl) {
  const text =
    `New booking request\n\n${b.serviceName} — ${b.formatName || b.format}\n${textWhen(b)}\n\n` +
    `Name: ${b.name}\nEmail: ${b.email}\nPhone: ${b.phone || '-'}\nReferred by: ${b.referrer || '-'}\n\nNotes:\n${b.notes || '(none)'}\n\n` +
    `ACCEPT: ${acceptUrl}\nREJECT: ${rejectUrl}\n`;
  const body =
    detailsCard(b) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16201C;margin:2px 0 6px">
      <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Name</td><td>${esc(b.name)}</td></tr>
      <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Email</td><td>${esc(b.email)}</td></tr>
      <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Phone</td><td>${esc(b.phone || '-')}</td></tr>
      <tr><td style="color:#6C7A70;padding:3px 12px 3px 0">Referred by</td><td>${esc(b.referrer || '-')}</td></tr>
    </table>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6C7A70;margin:2px 0 4px">Notes</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#16201C;background:#F7F4EE;border:1px solid #E4DED1;border-radius:10px;padding:12px;white-space:pre-wrap">${esc(b.notes || '(none)')}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 6px"><tr>
      <td style="border-radius:999px;background:#4E7A5E"><a href="${acceptUrl}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px">✓ Accept</a></td>
      <td style="width:12px"></td>
      <td style="border-radius:999px;background:#B4562F"><a href="${rejectUrl}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px">✕ Reject</a></td>
    </tr></table>
    <p style="font-size:12px;color:#8A9188;margin:8px 0 0">Accepting emails the patient a confirmation. Rejecting frees the slot and lets them know.</p>`;
  await send(practitionerTo, `New request — ${b.name}, ${b.serviceName}`, text,
    shell({ accent: '#16201C', badge: 'New request', badgeColor: '#B4562F', heading: 'New booking request', bodyHtml: body, preheader: `${b.name} — ${b.serviceName} on ${prettyWhen(b)}` }));
}

module.exports = { practitionerRequested, patientRequested, patientConfirmed, patientRejected, patientCancelled };
