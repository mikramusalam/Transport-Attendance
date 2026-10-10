export interface Employee {
  id: string;
  employeeCode: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  role: string;
  status: 'ACTIVE' | 'INACTIVE';
  faceEnrolledAt?: string | null;
  createdAt: string;
}

export interface AttendanceRecord {
  id: string;
  employeeCode: string;
  employeeName: string;
  truck: string;
  date: string;
  time: string;
  status: 'PRESENT' | 'LATE';
  latitude: number;
  longitude: number;
  gpsAccuracy: number;
  faceVerified: boolean;
  faceSimilarity: number | null;
  livenessVerified: boolean | null;
  googleMapsLink: string;
  hasPhoto?: boolean;
  photoExpiresAt?: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'VIEWER';
}

export interface CompanySettings {
  companyName: string;
  timezone: string;
  shiftStartTime: string;
  gracePeriodMinutes: number;
  gpsAccuracyThresholdMeters: number;
  faceMatchThreshold: number;
  workingDays: string;
  maxFaceAttempts: number;
  sessionTtlMinutes: number;
  selfieRetentionDays: number;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  createdAt: string;
  admin: { name: string; email: string } | null;
}
