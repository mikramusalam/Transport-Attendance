import crypto from 'crypto';
import { prisma } from './prisma.js';
import { getSettings } from './attendanceLogic.js';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * STEP 1 of the driver flow: location is captured before we even know who
 * the driver is. This creates an anonymous session tied only to a GPS fix.
 */
export async function createSessionFromLocation(latitude: number, longitude: number, gpsAccuracy: number) {
  const settings = await getSettings();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + settings.sessionTtlMinutes * 60 * 1000);

  return prisma.attendanceSession.create({
    data: {
      token,
      latitude,
      longitude,
      gpsAccuracy,
      status: 'LOCATION_CAPTURED',
      expiresAt,
    },
  });
}

export async function getActiveSession(token: string) {
  const session = await prisma.attendanceSession.findUnique({ where: { token } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    if (session.status !== 'EXPIRED' && session.status !== 'COMPLETED') {
      await prisma.attendanceSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
    }
    return null;
  }
  if (session.status === 'COMPLETED' || session.status === 'FAILED' || session.status === 'EXPIRED') {
    return null;
  }
  return session;
}

export async function updateSession(id: string, data: Record<string, unknown>) {
  return prisma.attendanceSession.update({ where: { id }, data: data as any });
}

export async function failSession(id: string) {
  return prisma.attendanceSession.update({ where: { id }, data: { status: 'FAILED' } });
}

/**
 * Validates that a session has progressed through every required step, in
 * order, before allowing final submission. This is what prevents a forged
 * POST straight to /attendance/submit — the server, not the browser,
 * decides whether GPS/identity/face/truck were actually completed.
 */
export function assertSessionReadyForSubmission(session: {
  status: string;
  latitude: number;
  longitude: number;
  gpsAccuracy: number;
  faceVerified: boolean;
  livenessVerified: boolean;
  truckNumber: string | null;
  employeeId: string | null;
}): { ok: boolean; error?: string } {
  if (session.latitude === null || session.longitude === null || session.gpsAccuracy === null) {
    return { ok: false, error: 'Location has not been captured for this session.' };
  }
  if (!session.employeeId) return { ok: false, error: 'Employee has not been identified for this session.' };
  if (!session.faceVerified) return { ok: false, error: 'Face has not been verified for this session.' };
  if (!session.livenessVerified) return { ok: false, error: 'Liveness check has not been completed.' };
  if (!session.truckNumber || !session.truckNumber.trim()) {
    return { ok: false, error: 'Truck number has not been entered for this session.' };
  }
  if (session.status !== 'TRUCK_ENTERED') {
    return { ok: false, error: 'Session is not in a valid state for submission.' };
  }
  return { ok: true };
}
