import { prisma } from './prisma.js';

export interface AuditEntry {
  adminId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Writes an audit log row. Never throws — a logging failure must never
 * block the underlying business operation. Never include biometric data,
 * passwords, or secrets in `details`.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        adminId: entry.adminId ?? undefined,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? undefined,
        details: entry.details ? (entry.details as any) : undefined,
        ipAddress: entry.ipAddress ?? undefined,
      },
    });
  } catch (err) {
    console.error('Failed to write audit log (non-fatal):', err);
  }
}
