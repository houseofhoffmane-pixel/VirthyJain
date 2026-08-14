import { config } from '../config.js';
import { localFullLabel, localTimeLabel } from '../lib/time.js';
import { CreatedBooking } from '../lib/bookings.js';
import { buildIcs, bookingUid } from './ics.js';
import { sendMail } from './mailer.js';
import { logNotesAccess } from '../lib/audit.js';

function money(cents: number): string {
  return '€' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}
function manageUrl(token: string): string {
  return `${config.publicBaseUrl}/manage?token=${encodeURIComponent(token)}`;
}
function locationFor(formatName: string): string {
  if (/home/i.test(formatName)) return 'Your home address (confirmed on booking)';
  if (/tele/i.test(formatName)) return 'Online — a video link follows before the session';
  return 'Clinic, Dublin';
}

const WHAT_TO_BRING = [
  'Wear comfortable, loose clothing you can move in — shorts or a vest are ideal so the area can be assessed.',
  'Bring any relevant scans, referral letters or a list of your current medication.',
  'For telehealth, find a quiet space with room to move and prop your camera so I can see you standing.',
];

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16201C;background:#F2EEE6;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#FFFDF8;border:1px solid #DCD5C7;padding:28px">
    <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:16px">Virthy Jain<span style="color:#B4562F">.</span> Physiotherapy</div>
    <h1 style="font-size:20px;margin:0 0 14px">${title}</h1>
    ${bodyHtml}
    <p style="font-size:12px;color:#8A9188;margin-top:24px;border-top:1px solid #E4DED1;padding-top:14px">
      Virthy Jain · Physiotherapist registered with CORU · Dublin.<br>
      Your records are kept in line with GDPR and never shared without your consent.
    </p>
  </div></body></html>`;
}

function detailsTable(b: CreatedBooking): string {
  const rows: [string, string][] = [
    ['Service', `${b.serviceName} · ${b.durationMinutes} min · ${money(b.priceCents)}`],
    ['Format', b.formatName],
    ['When', `${localFullLabel(b.startUtc)}, ${localTimeLabel(b.startUtc)} (Irish time)`],
    ['Where', locationFor(b.formatName)],
  ];
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#6C7A70;font-size:13px">${k}</td><td style="padding:6px 0;text-align:right">${v}</td></tr>`,
    )
    .join('')}</table>`;
}

function icsAttachment(b: CreatedBooking, sequence: number, cancel = false) {
  const ics = buildIcs({
    uid: bookingUid(b.id),
    sequence,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    summary: `Physiotherapy — ${b.serviceName}`,
    description: `${b.serviceName} with Virthy Jain. ${WHAT_TO_BRING[0]}`,
    location: locationFor(b.formatName),
    method: cancel ? 'CANCEL' : 'REQUEST',
    status: cancel ? 'CANCELLED' : b.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE',
    organizerName: 'Virthy Jain',
    organizerEmail: extractEmail(config.mailFrom),
    attendeeEmail: b.patientEmail,
  });
  return {
    attachment: { filename: 'appointment.ics', content: ics, contentType: 'text/calendar; charset=UTF-8' },
    method: (cancel ? 'CANCEL' : 'REQUEST') as 'REQUEST' | 'CANCEL',
  };
}
function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

// --- Patient: request received (pending) ------------------------------------
export async function emailRequestReceived(b: CreatedBooking): Promise<void> {
  const ics = icsAttachment(b, 0);
  const bring = `<ul style="font-size:14px;line-height:1.6;color:#3D4A42;padding-left:18px">${WHAT_TO_BRING.map(
    (x) => `<li>${x}</li>`,
  ).join('')}</ul>`;
  const body = `
    <p style="font-size:15px;line-height:1.6">Thank you, ${b.patientName.split(' ')[0]}. Your request is in and I will confirm it by email within 24 hours.</p>
    ${detailsTable(b)}
    <p style="font-size:14px;color:#6C7A70">This slot is held for you while your request is pending.</p>
    <h2 style="font-size:15px;margin:18px 0 6px">What to wear and bring</h2>
    ${bring}
    <p style="margin-top:20px"><a href="${manageUrl(b.token)}" style="display:inline-block;background:#B4562F;color:#FFF8F0;padding:12px 20px;border-radius:999px;text-decoration:none">Change or cancel this request</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `Request received — ${b.serviceName}, ${localFullLabel(b.startUtc)}`,
    text: `Your request for ${b.serviceName} on ${localFullLabel(b.startUtc)} at ${localTimeLabel(
      b.startUtc,
    )} is in. I will confirm within 24 hours. Manage: ${manageUrl(b.token)}`,
    html: shell('Your request is in', body),
    attachments: [ics.attachment],
    icsMethod: ics.method,
  });
}

// --- Practitioner: new request (carries the patient's notes) -----------------
export async function emailPractitionerNewRequest(b: CreatedBooking): Promise<void> {
  await logNotesAccess('system', 'email_to_practitioner', b.id, b.patientEmail);
  const body = `
    <p style="font-size:15px">New booking request — please confirm or decline in the admin panel.</p>
    ${detailsTable(b)}
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="color:#6C7A70;padding:4px 0">Name</td><td style="text-align:right">${b.patientName}</td></tr>
      <tr><td style="color:#6C7A70;padding:4px 0">Email</td><td style="text-align:right">${b.patientEmail}</td></tr>
      <tr><td style="color:#6C7A70;padding:4px 0">Phone</td><td style="text-align:right">${b.patientPhone ?? '—'}</td></tr>
      <tr><td style="color:#6C7A70;padding:4px 0">Referred by</td><td style="text-align:right">${b.referrer ?? '—'}</td></tr>
    </table>
    <h2 style="font-size:15px;margin:16px 0 6px">Notes from the patient</h2>
    <p style="font-size:14px;line-height:1.6;background:#F7F4EE;border:1px solid #E4DED1;padding:12px;white-space:pre-wrap">${
      b.notes ? escapeHtml(b.notes) : '(none provided)'
    }</p>
    <p style="margin-top:18px"><a href="${config.publicBaseUrl}/admin" style="color:#B4562F">Open the admin panel →</a></p>`;
  await sendMail({
    to: config.practitionerNotifyEmail,
    subject: `New request — ${b.patientName}, ${b.serviceName}, ${localFullLabel(b.startUtc)}`,
    text: `New request from ${b.patientName} (${b.patientEmail}) for ${b.serviceName} on ${localFullLabel(
      b.startUtc,
    )} ${localTimeLabel(b.startUtc)}.\n\nNotes: ${b.notes ?? '(none)'}\n\nAdmin: ${config.publicBaseUrl}/admin`,
    html: shell('New booking request', body),
  });
}

// --- Patient: confirmed ------------------------------------------------------
export async function emailConfirmed(b: CreatedBooking, note?: string): Promise<void> {
  const ics = icsAttachment({ ...b, status: 'confirmed' }, 1);
  const body = `
    <p style="font-size:15px">Good news — your appointment is confirmed.</p>
    ${note ? `<p style="font-size:14px;background:#EDF1E9;border:1px solid #C4D0BE;padding:12px">${escapeHtml(note)}</p>` : ''}
    ${detailsTable({ ...b, status: 'confirmed' })}
    <p style="margin-top:18px"><a href="${manageUrl(b.token)}" style="color:#B4562F">Need to change or cancel?</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `Confirmed — ${b.serviceName}, ${localFullLabel(b.startUtc)}`,
    text: `Your appointment is confirmed: ${b.serviceName}, ${localFullLabel(b.startUtc)} at ${localTimeLabel(
      b.startUtc,
    )}. ${note ?? ''} Manage: ${manageUrl(b.token)}`,
    html: shell('Appointment confirmed', body),
    attachments: [ics.attachment],
    icsMethod: ics.method,
  });
}

// --- Patient: declined -------------------------------------------------------
export async function emailDeclined(b: CreatedBooking, reason?: string): Promise<void> {
  const body = `
    <p style="font-size:15px">I'm sorry — I'm not able to take the time you requested.</p>
    ${reason ? `<p style="font-size:14px;background:#F7F4EE;border:1px solid #E4DED1;padding:12px">${escapeHtml(reason)}</p>` : ''}
    ${detailsTable(b)}
    <p style="font-size:14px">Please pick another time on the site, or reply to arrange one.</p>
    <p><a href="${config.publicBaseUrl}/#book" style="color:#B4562F">Choose another time →</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `About your request — ${b.serviceName}`,
    text: `I'm not able to take ${localFullLabel(b.startUtc)} ${localTimeLabel(b.startUtc)}. ${
      reason ?? ''
    } Please choose another time: ${config.publicBaseUrl}/#book`,
    html: shell('About your request', body),
  });
}

// --- Patient: cancelled ------------------------------------------------------
export async function emailCancelled(b: CreatedBooking, byWhom: 'you' | 'the practice'): Promise<void> {
  const ics = icsAttachment(b, 2, true);
  const body = `
    <p style="font-size:15px">This appointment has been cancelled${byWhom === 'you' ? ' at your request' : ''}.</p>
    ${detailsTable(b)}
    <p><a href="${config.publicBaseUrl}/#book" style="color:#B4562F">Book another time →</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `Cancelled — ${b.serviceName}, ${localFullLabel(b.startUtc)}`,
    text: `Your appointment on ${localFullLabel(b.startUtc)} ${localTimeLabel(b.startUtc)} is cancelled. Book again: ${config.publicBaseUrl}/#book`,
    html: shell('Appointment cancelled', body),
    attachments: [ics.attachment],
    icsMethod: ics.method,
  });
}

// --- Patient: rescheduled ----------------------------------------------------
export async function emailRescheduled(b: CreatedBooking): Promise<void> {
  const ics = icsAttachment(b, 3);
  const body = `
    <p style="font-size:15px">Your appointment has been moved. Here are the new details:</p>
    ${detailsTable(b)}
    <p style="margin-top:18px"><a href="${manageUrl(b.token)}" style="color:#B4562F">Change or cancel</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `Updated time — ${b.serviceName}, ${localFullLabel(b.startUtc)}`,
    text: `Your appointment is now ${localFullLabel(b.startUtc)} at ${localTimeLabel(b.startUtc)}. Manage: ${manageUrl(
      b.token,
    )}`,
    html: shell('Your appointment was moved', body),
    attachments: [ics.attachment],
    icsMethod: ics.method,
  });
}

// --- Patient: pending expired ------------------------------------------------
export async function emailPendingExpired(b: CreatedBooking): Promise<void> {
  const body = `
    <p style="font-size:15px">Your request has expired because it wasn't confirmed in time, and the slot has been released.</p>
    ${detailsTable(b)}
    <p style="font-size:14px">You're very welcome to book again whenever suits.</p>
    <p><a href="${config.publicBaseUrl}/#book" style="color:#B4562F">Book a session →</a></p>`;
  await sendMail({
    to: b.patientEmail,
    subject: `Your request has expired — ${b.serviceName}`,
    text: `Your request for ${localFullLabel(b.startUtc)} ${localTimeLabel(b.startUtc)} expired and the slot was released. Book again: ${config.publicBaseUrl}/#book`,
    html: shell('Request expired', body),
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
