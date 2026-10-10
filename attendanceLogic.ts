import { prisma } from './prisma.js';

// All business-rule reads go through this so we never hard-code values.
export async function getSettings() {
  let settings = await prisma.companySettings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.companySettings.create({ data: { id: 1 } });
  }
  return settings;
}

/**
 * Returns the current date/time expressed in the company's configured
 * timezone (Asia/Karachi by default), NOT the server's or the driver's
 * device clock — the device clock is never trusted for business logic.
 */
export function nowInTimezone(timezone: string): Date {
  // Server clock (assumed NTP-synced) is authoritative; we only use the
  // timezone to format/interpret it, via Intl below where needed.
  return new Date();
}

export function dateStringInTimezone(date: Date, timezone: string): string {
  // en-CA gives YYYY-MM-DD directly
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export function timeStringInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Determines PRESENT vs LATE based on company_settings.shiftStartTime +
 * gracePeriodMinutes, evaluated in the company's timezone.
 */
export function computeAttendanceStatus(
  now: Date,
  timezone: string,
  shiftStartTime: string, // "HH:mm" 24h
  gracePeriodMinutes: number
): 'PRESENT' | 'LATE' {
  const nowMinutes = timeStringToMinutes(timeStringInTimezone(now, timezone));
  const shiftMinutes = timeStringToMinutes(shiftStartTime);
  const cutoff = shiftMinutes + gracePeriodMinutes;
  return nowMinutes <= cutoff ? 'PRESENT' : 'LATE';
}

function timeStringToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/**
 * GPS validation. Rejects missing/invalid coordinates and accuracy worse
 * than the configured threshold. Never falls back to a fake location.
 */
export interface GpsValidationResult {
  ok: boolean;
  error?: string;
}

export function validateGps(
  latitude: unknown,
  longitude: unknown,
  accuracy: unknown,
  maxAccuracyMeters: number
): GpsValidationResult {
  if (typeof latitude !== 'number' || Number.isNaN(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, error: 'Invalid latitude received from device.' };
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: 'Invalid longitude received from device.' };
  }
  if (typeof accuracy !== 'number' || Number.isNaN(accuracy) || accuracy <= 0) {
    return { ok: false, error: 'Invalid GPS accuracy reported by device.' };
  }
  if (accuracy > maxAccuracyMeters) {
    return {
      ok: false,
      error: `Your location accuracy is currently too low (±${Math.round(
        accuracy
      )}m). Please move to an area with a stronger GPS signal and try again.`,
    };
  }
  return { ok: true };
}

export function googleMapsLink(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

/**
 * Free-text truck / number-plate validation. The driver types this
 * themselves — no dropdown, no truck registry to maintain. We just guard
 * against empty submissions and obviously-wrong input (too long, control
 * characters), and normalize casing/whitespace for consistent display.
 */
export interface TruckNumberValidation {
  ok: boolean;
  error?: string;
  value?: string;
}

export function validateTruckNumber(raw: unknown): TruckNumberValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Please enter your truck / number plate.' };
  }
  const value = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!value) {
    return { ok: false, error: 'Please enter your truck / number plate.' };
  }
  if (value.length > 20) {
    return { ok: false, error: 'Truck number looks too long. Please check and re-enter.' };
  }
  if (!/^[A-Z0-9\- ]+$/.test(value)) {
    return { ok: false, error: 'Truck number should only contain letters, numbers, and dashes.' };
  }
  return { ok: true, value };
}
