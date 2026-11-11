import nodemailer from 'nodemailer';
import { prisma } from '../db.js';
import { decrypt } from './crypto.js';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

/** The saved SMTP settings (password decrypted), or null when the platform admin has not set them. */
export async function getEmailConfig() {
  const row = await prisma.emailConfig.findUnique({ where: { id: 'default' } });
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: row.passwordEnc ? decrypt(row.passwordEnc) : null,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
  };
}

export async function isEmailConfigured() {
  return (await prisma.emailConfig.count({ where: { id: 'default' } })) > 0;
}

type Cfg = NonNullable<Awaited<ReturnType<typeof getEmailConfig>>>;

function transportFor(cfg: Cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined,
    // Never let a slow mail server hold up a backup or a request for long.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Sends one email using the saved settings. Throws if mail is not set up or the server refuses. */
export async function sendMail(msg: MailMessage, override?: Cfg) {
  const cfg = override ?? (await getEmailConfig());
  if (!cfg) throw new Error('Email is not set up yet.');
  await transportFor(cfg).sendMail({
    from: { name: cfg.fromName, address: cfg.fromEmail },
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}

/** Turns a mail-server error into one plain sentence a person can act on. */
export function explainMailError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const code = err?.code ?? '';
  const text = err?.message ?? String(e);
  if (code === 'EAUTH' || err?.responseCode === 535) return 'The mail server refused the user name or password.';
  // nodemailer often reports socket problems as ESOCKET/ECONNECTION and keeps the real cause in the message.
  if (code === 'ENOTFOUND' || code === 'EDNS' || /ENOTFOUND|getaddrinfo/i.test(text)) return 'The mail server address was not found. Check the host name.';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(text)) return 'The mail server refused the connection. Check the host and port.';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timed? ?out/i.test(text)) {
    return 'Could not reach the mail server in time. Check the host and port, and that this server may connect out to it.';
  }
  if (/wrong version number|ssl|tls|certificate/i.test(text)) {
    return 'The secure connection failed. Port 465 needs "Secure connection" on; ports 587 and 25 need it off.';
  }
  if (code === 'EENVELOPE' || err?.responseCode === 550 || err?.responseCode === 553) {
    return `The mail server did not accept the sender or recipient address (${text.slice(0, 160)}).`;
  }
  return `The mail server returned an error: ${text.slice(0, 200)}`;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A simple, clean email layout shared by every message. */
export function renderEmail(args: { heading: string; lines: string[]; button?: { label: string; url: string } }) {
  const body = args.lines.map((l) => `<p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.5">${escapeHtml(l)}</p>`).join('');
  const btn = args.button
    ? `<p style="margin:20px 0"><a href="${escapeHtml(args.button.url)}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px">${escapeHtml(args.button.label)}</a></p>`
    : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px;color:#0f172a;font-size:18px">${escapeHtml(args.heading)}</h2>${body}${btn}<p style="margin:24px 0 0;color:#94a3b8;font-size:12px">MoreYeahs CloudBackup</p></div>`;
  const text = [args.heading, '', ...args.lines, ...(args.button ? ['', `${args.button.label}: ${args.button.url}`] : [])].join('\n');
  return { html, text };
}
