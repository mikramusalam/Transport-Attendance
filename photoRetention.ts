import fs from 'fs';
import path from 'path';
import { prisma } from './prisma.js';

const PENDING_PHOTO_DIR = process.env.PENDING_PHOTO_DIR || path.join(process.cwd(), 'pending-photos');
const ATTENDANCE_PHOTO_DIR = process.env.ATTENDANCE_PHOTO_DIR || path.join(process.cwd(), 'attendance-photos');

export function ensurePhotoDirs() {
  for (const dir of [PENDING_PHOTO_DIR, ATTENDANCE_PHOTO_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function pendingPhotoPathFor(sessionId: string): string {
  return path.join(PENDING_PHOTO_DIR, `${sessionId}.jpg`);
}

export function attendancePhotoPathFor(attendanceId: string): string {
  return path.join(ATTENDANCE_PHOTO_DIR, `${attendanceId}.jpg`);
}

export function savePendingPhoto(sessionId: string, base64OrDataUrl: string): string {
  ensurePhotoDirs();
  const base64 = base64OrDataUrl.includes(',') ? base64OrDataUrl.split(',')[1] : base64OrDataUrl;
  const filePath = pendingPhotoPathFor(sessionId);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

/**
 * Moves a session's pending verification photo into permanent (but still
 * time-limited) storage under the Attendance record, and returns the
 * expiry timestamp to store alongside it. Never throws — a photo-move
 * failure must never block attendance submission itself.
 */
export function commitPendingPhoto(
  pendingPath: string | null,
  attendanceId: string,
  retentionDays: number
): { photoPath: string | null; photoExpiresAt: Date | null } {
  if (!pendingPath) return { photoPath: null, photoExpiresAt: null };
  try {
    ensurePhotoDirs();
    if (!fs.existsSync(pendingPath)) return { photoPath: null, photoExpiresAt: null };
    const destPath = attendancePhotoPathFor(attendanceId);
    fs.renameSync(pendingPath, destPath);
    const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    return { photoPath: `${attendanceId}.jpg`, photoExpiresAt: expiresAt };
  } catch (err) {
    console.error('Failed to commit verification photo (non-fatal):', err);
    return { photoPath: null, photoExpiresAt: null };
  }
}

export function readAttendancePhoto(fileName: string): Buffer | null {
  const filePath = path.join(ATTENDANCE_PHOTO_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

/**
 * Background cleanup: permanently deletes verification selfies whose
 * retention window has passed, and cleans up orphaned pending photos from
 * sessions that never completed. Runs on a timer from server.ts — never
 * keeps biometric photos beyond the configured retention window.
 */
export async function cleanupExpiredPhotos(): Promise<void> {
  try {
    const now = new Date();

    const expired = await prisma.attendance.findMany({
      where: { photoExpiresAt: { lt: now }, selfiePhotoPath: { not: null } },
      select: { id: true, selfiePhotoPath: true },
    });

    for (const record of expired) {
      if (record.selfiePhotoPath) {
        const filePath = path.join(ATTENDANCE_PHOTO_DIR, record.selfiePhotoPath);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete expired photo for attendance ${record.id}:`, err);
        }
      }
      await prisma.attendance.update({
        where: { id: record.id },
        data: { selfiePhotoPath: null, photoDeletedAt: now },
      });
    }

    if (expired.length > 0) {
      console.log(`Photo retention cleanup: deleted ${expired.length} expired verification photo(s).`);
    }

    // Orphaned pending photos (session abandoned mid-flow) older than 1 day
    if (fs.existsSync(PENDING_PHOTO_DIR)) {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      for (const file of fs.readdirSync(PENDING_PHOTO_DIR)) {
        const filePath = path.join(PENDING_PHOTO_DIR, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < oneDayAgo) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch (err) {
    console.error('Photo cleanup job failed (non-fatal):', err);
  }
}
