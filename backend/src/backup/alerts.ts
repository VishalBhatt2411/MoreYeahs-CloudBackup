import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { explainMailError, isEmailConfigured, renderEmail, sendMail } from '../lib/mail.js';

function formatIn(zone: string, d: Date) {
  try {
    return d.toLocaleString('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }) + ` (${zone})`;
  } catch {
    return d.toISOString();
  }
}

/** Who gets the alert: the company's alert address, or else every active owner. */
export async function alertRecipients(tenantId: string, alertEmail: string | null) {
  if (alertEmail) return [alertEmail];
  const owners = await prisma.user.findMany({ where: { tenantId, role: 'OWNER', active: true }, select: { email: true } });
  return owners.map((o) => o.email);
}

/**
 * Emails the company when a backup run FAILED (this includes "reconnect needed").
 * Safe to call any time: it never throws, and it sends at most one email per run.
 */
export async function sendRunAlert(runId: string): Promise<void> {
  try {
    const run = await prisma.backupRun.findUnique({ where: { id: runId }, include: { connection: true } });
    if (!run || run.status !== 'FAILED') return;
    const tenant = await prisma.tenant.findUnique({ where: { id: run.tenantId } });
    if (!tenant || !tenant.alertOnFailure) return;
    if (!(await isEmailConfigured())) return;

    const to = await alertRecipients(tenant.id, tenant.alertEmail);
    if (to.length === 0) return;

    // The unique runId makes this the "claim": a second call for the same run stops here.
    try {
      await prisma.alertLog.create({ data: { tenantId: tenant.id, runId, toEmail: to.join(', '), status: 'PENDING' } });
    } catch {
      return;
    }

    const org = run.connection.label;
    const needsReconnect = run.connection.status === 'NEEDS_RECONNECT';
    const lines = [
      `The backup of "${org}" (${run.connection.username}) did not finish.`,
      `Reason: ${run.message ?? 'Unknown'}`,
      `Time: ${formatIn(tenant.timeZone, run.finishedAt ?? new Date())}`,
      needsReconnect ? 'Salesforce no longer accepts the saved login. Open the org in CloudBackup and click Reconnect.' : 'Open the backup to see which items failed.',
    ];
    const url = needsReconnect ? `${config.appUrl}/orgs/${run.connectionId}` : `${config.appUrl}/runs/${runId}`;
    const mail = renderEmail({
      heading: needsReconnect ? `Reconnect needed: ${org}` : `Backup failed: ${org}`,
      lines,
      button: { label: needsReconnect ? 'Open the org' : 'View the backup', url },
    });

    try {
      await sendMail({ to, subject: `[CloudBackup] ${needsReconnect ? 'Reconnect needed' : 'Backup failed'}: ${org}`, ...mail });
      await prisma.alertLog.update({ where: { runId }, data: { status: 'SENT' } });
      await audit(tenant.id, null, 'alert.sent', runId, to.join(', '));
    } catch (e) {
      const why = explainMailError(e);
      await prisma.alertLog.update({ where: { runId }, data: { status: 'FAILED', detail: why } });
      await audit(tenant.id, null, 'alert.failed', runId, why);
    }
  } catch (e) {
    console.error('Alert error:', e instanceof Error ? e.message : e);
  }
}
