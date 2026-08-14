import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface Attachment {
  filename: string;
  content: string;
  contentType: string;
}
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
  // Calendar method for the alternative part, when sending an ICS invite.
  icsMethod?: 'REQUEST' | 'CANCEL';
}

let transport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

/**
 * Transactional email is always sent from a REAL domain (config.mailFrom),
 * never the personal Gmail address shown as the public contact.
 * In dry-run mode messages are written to ./outbox for inspection.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const alternatives = mail.attachments?.length
    ? mail.attachments
        .filter((a) => a.contentType.startsWith('text/calendar'))
        .map((a) => ({
          contentType: `text/calendar; method=${mail.icsMethod ?? 'REQUEST'}; charset=UTF-8`,
          content: a.content,
        }))
    : [];

  if (config.mailDryRun) {
    const dir = join(process.cwd(), 'outbox');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = mail.to.replace(/[^a-z0-9]/gi, '_');
    await writeFile(
      join(dir, `${stamp}_${safe}.txt`),
      `From: ${config.mailFrom}\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`,
      'utf8',
    );
    for (const a of mail.attachments ?? []) {
      await writeFile(join(dir, `${stamp}_${safe}_${a.filename}`), a.content, 'utf8');
    }
    return;
  }

  await getTransport().sendMail({
    from: config.mailFrom,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    alternatives,
    attachments: mail.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
}
