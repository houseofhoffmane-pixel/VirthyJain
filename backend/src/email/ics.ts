import { DateTime } from 'luxon';
import { config } from '../config.js';

function icsTime(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'");
}
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export interface IcsInput {
  uid: string; // stable per booking
  sequence: number; // bump on reschedule/cancel
  startUtc: string;
  endUtc: string;
  summary: string;
  description: string;
  location: string;
  method: 'REQUEST' | 'CANCEL';
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  organizerName: string;
  organizerEmail: string;
  attendeeEmail: string;
}

export function buildIcs(i: IcsInput): string {
  const now = icsTime(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Virthy Jain Physiotherapy//Booking//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${i.method}`,
    'BEGIN:VEVENT',
    `UID:${i.uid}`,
    `SEQUENCE:${i.sequence}`,
    `DTSTAMP:${now}`,
    `DTSTART:${icsTime(i.startUtc)}`,
    `DTEND:${icsTime(i.endUtc)}`,
    `SUMMARY:${esc(i.summary)}`,
    `DESCRIPTION:${esc(i.description)}`,
    `LOCATION:${esc(i.location)}`,
    `STATUS:${i.status}`,
    `ORGANIZER;CN=${esc(i.organizerName)}:mailto:${i.organizerEmail}`,
    `ATTENDEE;CN=Patient;RSVP=TRUE:mailto:${i.attendeeEmail}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Physiotherapy appointment reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // Fold long lines at 75 octets per RFC 5545.
  return lines
    .map((l) => (l.length <= 75 ? l : l.match(/.{1,73}/g)!.join('\r\n ')))
    .join('\r\n');
}

export function bookingUid(bookingId: number): string {
  return `booking-${bookingId}@${new URL(config.publicBaseUrl).hostname}`;
}
