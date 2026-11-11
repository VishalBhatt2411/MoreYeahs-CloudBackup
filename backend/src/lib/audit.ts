import { prisma } from '../db.js';

/** Writes one line to the audit log. Never throws (logging must not break the real action). */
export async function audit(
  tenantId: string | null,
  userId: string | null,
  action: string,
  target?: string | null,
  detail?: string | null,
) {
  try {
    await prisma.auditLog.create({
      data: { tenantId, userId, action, target: target ?? null, detail: detail ? detail.slice(0, 500) : null },
    });
  } catch (e) {
    console.error('Could not write audit log:', e instanceof Error ? e.message : e);
  }
}
