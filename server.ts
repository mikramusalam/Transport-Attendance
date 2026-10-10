import express from 'express';
import path from 'path';
import fs from 'fs';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import { Prisma } from '@prisma/client';

import { prisma } from './server/prisma.js';
import {
  requireAuth,
  requireRole,
  loginHandler,
  logoutHandler,
  meHandler,
  hashPassword,
} from './server/auth.js';
import { writeAuditLog } from './server/audit.js';
import {
  detectFace,
  verifyDescriptor,
  checkLivenessTurn,
  estimateHeadYawRatio,
  loadFaceModels,
} from './server/faceService.js';
import {
  getSettings,
  validateGps,
  validateTruckNumber,
  computeAttendanceStatus,
  dateStringInTimezone,
  timeStringInTimezone,
  googleMapsLink,
} from './server/attendanceLogic.js';
import {
  createSessionFromLocation,
  getActiveSession,
  updateSession,
  failSession,
  assertSessionReadyForSubmission,
} from './server/attendanceSession.js';
import { reverseGeocodeCoordinates } from './server/geocoding.js';
import { syncRecordToGoogleSheets } from './server/sheetsSync.js';
import { buildAttendanceCsv } from './server/csvExport.js';
import {
  ensurePhotoDirs,
  savePendingPhoto,
  commitPendingPhoto,
  readAttendancePhoto,
  cleanupExpiredPhotos,
} from './server/photoRetention.js';

const ENROLLMENT_PHOTO_DIR = process.env.ENROLLMENT_PHOTO_DIR || path.join(process.cwd(), 'enrollment-photos');

async function startServer() {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set. See .env.example.');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET is not set. See .env.example.');
    process.exit(1);
  }

  if (!fs.existsSync(ENROLLMENT_PHOTO_DIR)) {
    fs.mkdirSync(ENROLLMENT_PHOTO_DIR, { recursive: true });
  }
  ensurePhotoDirs();

  // Face models must be present before we accept traffic.
  await loadFaceModels();

  // Photo-retention cleanup: run once at startup, then every hour. This is
  // what actually enforces the "kept for N days, then deleted" promise —
  // as long as the app process is running (it is, via
  // `restart: unless-stopped` in docker-compose), old selfies get removed
  // automatically. No separate cron container needed at this scale.
  cleanupExpiredPhotos();
  setInterval(cleanupExpiredPhotos, 60 * 60 * 1000);

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1); // behind Caddy/Nginx

  app.use(express.json({ limit: '10mb' })); // selfies as base64; 10mb is ample
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Sessions (admin auth) — backed by Postgres, not in-memory ──────────
  const PgSession = pgSession(session);
  app.use(
    session({
      store: new PgSession({
        conString: process.env.DATABASE_URL,
        tableName: 'session',
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: 'attendance.sid',
      cookie: {
        httpOnly: true,
        secure: isProd, // requires HTTPS in production (Caddy provides this)
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
      },
    })
  );

  // ── Rate limiting ────────────────────────────────────────────────────
  app.use(
    '/api/',
    rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
  );
  app.use(
    '/api/admin/login',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
  );
  app.use(
    '/api/driver/face/verify',
    rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false })
  );

  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) console.log(`[API] ${req.method} ${req.path}`);
    next();
  });

  // ==========================================
  // HEALTH CHECK
  // ==========================================
  app.get('/api/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // ==========================================
  // DRIVER FLOW (public, session-token protected)
  // Order: LOCATION -> IDENTIFY -> FACE VERIFY -> TRUCK NUMBER -> SUBMIT
  // ==========================================

  // STEP 1: Location, captured before we know who the driver is.
  app.post('/api/driver/location', async (req, res) => {
    try {
      const { latitude, longitude, accuracy } = req.body || {};
      const settings = await getSettings();
      const gpsCheck = validateGps(latitude, longitude, accuracy, settings.gpsAccuracyThresholdMeters);
      if (!gpsCheck.ok) {
        return res.status(400).json({ error: gpsCheck.error });
      }
      const session = await createSessionFromLocation(latitude, longitude, accuracy);
      res.json({ sessionToken: session.token, accuracy });
    } catch (err: any) {
      console.error('location error:', err);
      res.status(500).json({ error: 'Could not process location. Please try again.' });
    }
  });

  // STEP 2: Employee number (CLAIMED identity only — proven in step 3)
  app.post('/api/driver/identify', async (req, res) => {
    try {
      const { sessionToken, employeeCode: rawCode } = req.body || {};
      const employeeCode = (rawCode || '').toString().trim().toUpperCase();

      const session = await getActiveSession(sessionToken);
      if (!session) {
        return res.status(410).json({ error: 'Your session has expired. Please start again.' });
      }
      if (session.status !== 'LOCATION_CAPTURED') {
        return res.status(400).json({ error: 'Please start again from the beginning.' });
      }
      if (!employeeCode) {
        return res.status(400).json({ error: 'Please enter your Employee Number.' });
      }

      const employee = await prisma.employee.findUnique({ where: { employeeCode } });
      if (!employee || employee.status !== 'ACTIVE') {
        return res.status(404).json({ error: 'Employee Number not found or inactive. Please contact your supervisor.' });
      }
      if (!employee.faceEmbedding) {
        return res.status(400).json({
          error: 'Your face has not been enrolled yet. Please contact your administrator to complete enrollment.',
        });
      }

      const settings = await getSettings();
      const todayStr = dateStringInTimezone(new Date(), settings.timezone);
      const existing = await prisma.attendance.findFirst({
        where: { employeeId: employee.id, attendanceDate: new Date(todayStr) },
      });
      if (existing) {
        return res.status(409).json({
          error: `Attendance has already been marked today at ${timeStringInTimezone(
            existing.attendanceTime,
            settings.timezone
          )}.`,
          alreadyMarked: true,
        });
      }

      const direction = Math.random() < 0.5 ? 'LEFT' : 'RIGHT';
      await updateSession(session.id, {
        employeeId: employee.id,
        claimedEmployeeCode: employeeCode,
        status: 'IDENTIFIED',
        livenessChallenge: direction,
      });

      res.json({
        employee: { fullName: employee.fullName, employeeCode: employee.employeeCode },
        challengeDirection: direction,
      });
    } catch (err: any) {
      console.error('identify error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // STEP 3: Verify face (1:1 against the CLAIMED employee's stored descriptor)
  // + liveness (head-turn between a center frame and a challenge frame).
  // On success, the center selfie is saved for the configured retention window.
  app.post('/api/driver/face/verify', async (req, res) => {
    try {
      const { sessionToken, centerPhoto, challengePhoto } = req.body || {};
      const session = await getActiveSession(sessionToken);
      if (!session) {
        return res.status(410).json({ error: 'Your session has expired. Please start again.' });
      }
      if (session.status !== 'IDENTIFIED' && session.status !== 'FACE_VERIFIED') {
        return res.status(400).json({ error: 'Please enter your Employee Number first.' });
      }
      if (!centerPhoto || !challengePhoto) {
        return res.status(400).json({ error: 'Please capture both required photos.' });
      }

      const settings = await getSettings();
      if (session.faceAttempts >= settings.maxFaceAttempts) {
        await failSession(session.id);
        return res.status(429).json({ error: 'Too many failed verification attempts. Please contact your supervisor.' });
      }

      const employee = await prisma.employee.findUnique({ where: { id: session.employeeId! } });
      if (!employee || !employee.faceEmbedding) {
        return res.status(400).json({ error: 'Face enrollment not found for this driver.' });
      }

      const centerDetection = await detectFace(centerPhoto);
      if (!centerDetection.ok || !centerDetection.descriptor || !centerDetection.landmarks) {
        await updateSession(session.id, { faceAttempts: session.faceAttempts + 1 });
        return res.status(400).json({
          error:
            centerDetection.reason === 'MULTIPLE_FACES'
              ? 'More than one face detected. Please make sure only you are in frame.'
              : 'We could not detect your face clearly. Please make sure your face is clearly visible and try again.',
        });
      }

      const challengeDetection = await detectFace(challengePhoto);
      if (!challengeDetection.ok || !challengeDetection.descriptor || !challengeDetection.landmarks) {
        await updateSession(session.id, { faceAttempts: session.faceAttempts + 1 });
        return res.status(400).json({ error: 'We could not verify your movement. Please try the head-turn step again.' });
      }

      const maxDistance = Math.max(0.3, 1.2 - settings.faceMatchThreshold);
      const matchResult = verifyDescriptor(
        centerDetection.descriptor,
        employee.faceEmbedding as unknown as number[],
        maxDistance
      );

      const centerYaw = estimateHeadYawRatio(centerDetection.landmarks);
      const challengeYaw = estimateHeadYawRatio(challengeDetection.landmarks);
      const direction = (session.livenessChallenge as 'LEFT' | 'RIGHT') || 'LEFT';
      const livenessPassed = checkLivenessTurn(centerYaw, challengeYaw, direction);

      if (!matchResult.matched || !livenessPassed) {
        await updateSession(session.id, { faceAttempts: session.faceAttempts + 1 });
        await writeAuditLog({
          adminId: null,
          action: 'DRIVER_FACE_VERIFY_FAILED',
          entityType: 'Employee',
          entityId: employee.id,
          details: { matched: matchResult.matched, livenessPassed },
        });
        return res.status(401).json({
          error: matchResult.matched
            ? 'We could not confirm liveness. Please repeat the head-turn step in good lighting.'
            : 'We could not verify your identity. Please make sure your face is clearly visible and try again.',
        });
      }

      // Save the center selfie for the configured retention window (admin review only).
      let pendingPhotoPath: string | null = null;
      try {
        pendingPhotoPath = savePendingPhoto(session.id, centerPhoto);
      } catch (err) {
        console.error('Failed to save verification photo (non-fatal):', err);
      }

      await updateSession(session.id, {
        status: 'FACE_VERIFIED',
        faceVerified: true,
        faceSimilarity: matchResult.similarity,
        livenessVerified: true,
        pendingPhotoPath,
      });

      res.json({ verified: true });
    } catch (err: any) {
      console.error('face verify error:', err);
      res.status(500).json({ error: 'Face verification failed. Please try again.' });
    }
  });

  // STEP 4: Truck / number plate — free text, typed by the driver.
  app.post('/api/driver/truck', async (req, res) => {
    try {
      const { sessionToken, truckNumber } = req.body || {};
      const session = await getActiveSession(sessionToken);
      if (!session) {
        return res.status(410).json({ error: 'Your session has expired. Please start again.' });
      }
      if (session.status !== 'FACE_VERIFIED') {
        return res.status(400).json({ error: 'Please complete face verification first.' });
      }

      const check = validateTruckNumber(truckNumber);
      if (!check.ok) {
        return res.status(400).json({ error: check.error });
      }

      await updateSession(session.id, { truckNumber: check.value, status: 'TRUCK_ENTERED' });
      res.json({ success: true, truckNumber: check.value });
    } catch (err: any) {
      res.status(500).json({ error: 'Could not save truck number. Please try again.' });
    }
  });

  // STEP 5: Final submission — server decides EVERYTHING from the session.
  app.post('/api/driver/submit', async (req, res) => {
    try {
      const { sessionToken } = req.body || {};
      const session = await getActiveSession(sessionToken);
      if (!session) {
        return res.status(410).json({ error: 'Your session has expired. Please start again.' });
      }

      const readyCheck = assertSessionReadyForSubmission(session);
      if (!readyCheck.ok) {
        return res.status(400).json({ error: readyCheck.error });
      }

      const settings = await getSettings();
      const now = new Date();
      const todayStr = dateStringInTimezone(now, settings.timezone);
      const status = computeAttendanceStatus(now, settings.timezone, settings.shiftStartTime, settings.gracePeriodMinutes);

      const employee = await prisma.employee.findUnique({ where: { id: session.employeeId! } });
      if (!employee) return res.status(404).json({ error: 'Driver record not found.' });

      let record;
      try {
        record = await prisma.attendance.create({
          data: {
            employeeId: session.employeeId!,
            truckNumber: session.truckNumber!,
            attendanceDate: new Date(todayStr),
            attendanceTime: now,
            status,
            latitude: session.latitude,
            longitude: session.longitude,
            gpsAccuracy: session.gpsAccuracy,
            faceVerified: session.faceVerified,
            faceSimilarity: session.faceSimilarity,
            livenessVerified: session.livenessVerified,
            verificationMethod: 'face_embedding_v1+liveness_headturn',
            sessionId: session.id,
          },
        });
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return res.status(409).json({ error: 'Your attendance has already been marked today.' });
        }
        throw err;
      }

      // Move the verification selfie from pending -> permanent (time-limited) storage.
      const { photoPath, photoExpiresAt } = commitPendingPhoto(
        session.pendingPhotoPath,
        record.id,
        settings.selfieRetentionDays
      );
      if (photoPath) {
        record = await prisma.attendance.update({
          where: { id: record.id },
          data: { selfiePhotoPath: photoPath, photoExpiresAt },
        });
      }

      await updateSession(session.id, { status: 'COMPLETED' });

      let city: string | null = null;
      try {
        const geo = await reverseGeocodeCoordinates(session.latitude, session.longitude);
        city = geo.city;
      } catch {
        /* optional */
      }

      // Fire-and-forget Google Sheets sync — never blocks or fails the response
      prisma.sheetsConfig
        .findUnique({ where: { id: 1 } })
        .then(async (cfg) => {
          if (cfg?.autoSync && cfg.webhookUrl) {
            await syncRecordToGoogleSheets(
              {
                attendanceId: record.id,
                employeeCode: employee.employeeCode,
                employeeName: employee.fullName,
                truckNumber: record.truckNumber,
                date: todayStr,
                time: timeStringInTimezone(now, settings.timezone),
                latitude: record.latitude,
                longitude: record.longitude,
                gpsAccuracy: record.gpsAccuracy,
                status: record.status,
                faceVerified: record.faceVerified,
                faceSimilarity: record.faceSimilarity,
                createdAt: record.createdAt.toISOString(),
              },
              { webhookUrl: cfg.webhookUrl, sheetName: cfg.sheetName, autoSync: cfg.autoSync }
            ).catch(() => {});
          }
        })
        .catch(() => {});

      res.json({
        success: true,
        message: 'Attendance marked successfully.',
        record: { status: record.status, date: todayStr, time: timeStringInTimezone(now, settings.timezone), city },
      });
    } catch (err: any) {
      console.error('submit error:', err);
      res.status(500).json({ error: 'We could not confirm your attendance. Please check your connection and try again.' });
    }
  });

  // ==========================================
  // ADMIN AUTH
  // ==========================================
  app.post('/api/admin/login', loginHandler);
  app.post('/api/admin/logout', logoutHandler);
  app.get('/api/admin/me', meHandler);

  // ==========================================
  // ADMIN: EMPLOYEES
  // ==========================================
  app.get('/api/admin/employees', requireAuth, async (_req, res) => {
    const employees = await prisma.employee.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        faceEnrolledAt: true,
        createdAt: true,
      },
    });
    res.json({ employees });
  });

  app.post('/api/admin/employees', requireAuth, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    try {
      const { employeeCode, fullName, phone, email, role } = req.body || {};
      if (!employeeCode || !fullName) {
        return res.status(400).json({ error: 'Employee Number and full name are required.' });
      }
      const employee = await prisma.employee.create({
        data: {
          employeeCode: employeeCode.toString().trim().toUpperCase(),
          fullName: fullName.trim(),
          phone: phone || null,
          email: email || null,
          role: role || 'Driver',
        },
      });
      await writeAuditLog({
        adminId: req.session.adminId!,
        action: 'EMPLOYEE_CREATED',
        entityType: 'Employee',
        entityId: employee.id,
        details: { employeeCode: employee.employeeCode },
        ipAddress: req.ip,
      });
      res.json({ success: true, employee });
    } catch (err: any) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return res.status(409).json({ error: 'An employee with this Employee Number already exists.' });
      }
      res.status(500).json({ error: 'Could not create employee.' });
    }
  });

  app.put('/api/admin/employees/:id', requireAuth, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    try {
      const { fullName, phone, email, role } = req.body || {};
      const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { fullName, phone, email, role } });
      await writeAuditLog({ adminId: req.session.adminId!, action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: employee.id, ipAddress: req.ip });
      res.json({ success: true, employee });
    } catch {
      res.status(404).json({ error: 'Employee not found.' });
    }
  });

  app.post('/api/admin/employees/:id/status', requireAuth, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    try {
      const { status } = req.body || {};
      if (status !== 'ACTIVE' && status !== 'INACTIVE') return res.status(400).json({ error: 'Invalid status.' });
      const employee = await prisma.employee.update({ where: { id: req.params.id }, data: { status } });
      await writeAuditLog({
        adminId: req.session.adminId!,
        action: status === 'ACTIVE' ? 'EMPLOYEE_REACTIVATED' : 'EMPLOYEE_DEACTIVATED',
        entityType: 'Employee',
        entityId: employee.id,
        ipAddress: req.ip,
      });
      res.json({ success: true, employee });
    } catch {
      res.status(404).json({ error: 'Employee not found.' });
    }
  });

  app.post('/api/admin/employees/:id/enroll-face', requireAuth, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    try {
      const { photoBase64 } = req.body || {};
      if (!photoBase64) return res.status(400).json({ error: 'A reference photo is required.' });

      const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
      if (!employee) return res.status(404).json({ error: 'Employee not found.' });

      const detection = await detectFace(photoBase64);
      if (!detection.ok || !detection.descriptor) {
        return res.status(400).json({
          error:
            detection.reason === 'MULTIPLE_FACES'
              ? 'More than one face detected in the photo. Please use a photo with only this employee.'
              : 'No face detected in the photo. Please use a clear, front-facing photo.',
        });
      }

      const photoFileName = `${employee.id}.jpg`;
      const photoPath = path.join(ENROLLMENT_PHOTO_DIR, photoFileName);
      const base64Data = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
      fs.writeFileSync(photoPath, Buffer.from(base64Data, 'base64'));

      const updated = await prisma.employee.update({
        where: { id: employee.id },
        data: {
          faceEmbedding: Array.from(detection.descriptor) as unknown as Prisma.InputJsonValue,
          faceEnrolledAt: new Date(),
          enrolledPhotoPath: photoFileName,
        },
      });

      await writeAuditLog({ adminId: req.session.adminId!, action: 'EMPLOYEE_FACE_ENROLLED', entityType: 'Employee', entityId: employee.id, ipAddress: req.ip });
      res.json({ success: true, employee: { id: updated.id, faceEnrolledAt: updated.faceEnrolledAt } });
    } catch (err: any) {
      console.error('enroll-face error:', err);
      res.status(500).json({ error: 'Face enrollment failed.' });
    }
  });

  app.get('/api/admin/employees/:id/photo', requireAuth, async (req, res) => {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!employee?.enrolledPhotoPath) return res.status(404).json({ error: 'No photo on file.' });
    const filePath = path.join(ENROLLMENT_PHOTO_DIR, employee.enrolledPhotoPath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Photo file missing.' });
    res.sendFile(filePath);
  });

  // ==========================================
  // ADMIN: ATTENDANCE
  // ==========================================
  app.get('/api/admin/attendance', requireAuth, async (req, res) => {
    const { date, employeeId, status } = req.query as Record<string, string>;
    const where: Prisma.AttendanceWhereInput = {};
    if (date) where.attendanceDate = new Date(date);
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;

    const records = await prisma.attendance.findMany({
      where,
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({
      records: records.map((r) => ({
        id: r.id,
        employeeCode: r.employee.employeeCode,
        employeeName: r.employee.fullName,
        truck: r.truckNumber,
        date: r.attendanceDate,
        time: r.attendanceTime,
        status: r.status,
        latitude: r.latitude,
        longitude: r.longitude,
        gpsAccuracy: r.gpsAccuracy,
        faceVerified: r.faceVerified,
        faceSimilarity: r.faceSimilarity,
        livenessVerified: r.livenessVerified,
        googleMapsLink: googleMapsLink(r.latitude, r.longitude),
        hasPhoto: !!r.selfiePhotoPath,
        photoExpiresAt: r.photoExpiresAt,
        createdAt: r.createdAt,
      })),
    });
  });

  app.get('/api/admin/attendance/today', requireAuth, async (_req, res) => {
    const settings = await getSettings();
    const todayStr = dateStringInTimezone(new Date(), settings.timezone);
    const records = await prisma.attendance.findMany({
      where: { attendanceDate: new Date(todayStr) },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    });
    const activeDrivers = await prisma.employee.count({ where: { status: 'ACTIVE' } });
    const present = records.filter((r) => r.status === 'PRESENT').length;
    const late = records.filter((r) => r.status === 'LATE').length;
    res.json({
      date: todayStr,
      totalActiveDrivers: activeDrivers,
      present,
      late,
      absent: Math.max(0, activeDrivers - records.length),
      attendancePercentage: activeDrivers ? Math.round((records.length / activeDrivers) * 100) : 0,
      records: records.map((r) => ({
        id: r.id,
        employeeCode: r.employee.employeeCode,
        employeeName: r.employee.fullName,
        truck: r.truckNumber,
        time: r.attendanceTime,
        status: r.status,
        latitude: r.latitude,
        longitude: r.longitude,
        googleMapsLink: googleMapsLink(r.latitude, r.longitude),
        hasPhoto: !!r.selfiePhotoPath,
      })),
    });
  });

  app.get('/api/admin/attendance/:id', requireAuth, async (req, res) => {
    const r = await prisma.attendance.findUnique({
      where: { id: req.params.id },
      include: { employee: true, corrections: { include: { admin: true }, orderBy: { createdAt: 'desc' } } },
    });
    if (!r) return res.status(404).json({ error: 'Record not found.' });
    res.json({
      record: {
        ...r,
        truck: r.truckNumber,
        googleMapsLink: googleMapsLink(r.latitude, r.longitude),
        hasPhoto: !!r.selfiePhotoPath,
      },
    });
  });

  // Verification selfie — auth required, only within the retention window
  app.get('/api/admin/attendance/:id/photo', requireAuth, async (req, res) => {
    const r = await prisma.attendance.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Record not found.' });
    if (!r.selfiePhotoPath) {
      return res.status(404).json({
        error: r.photoDeletedAt
          ? 'This photo has been automatically deleted (retention window expired).'
          : 'No photo was saved for this record.',
      });
    }
    const buffer = readAttendancePhoto(r.selfiePhotoPath);
    if (!buffer) return res.status(404).json({ error: 'Photo file missing.' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  });

  // Attendance correction — no silent edits/deletes
  app.post('/api/admin/attendance/:id/correct', requireAuth, requireRole('ADMIN'), async (req, res) => {
    try {
      const { newStatus, newTime, reason } = req.body || {};
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required for corrections.' });

      const existing = await prisma.attendance.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Record not found.' });

      const updated = await prisma.$transaction(async (tx) => {
        const record = await tx.attendance.update({
          where: { id: existing.id },
          data: { status: newStatus || existing.status, attendanceTime: newTime ? new Date(newTime) : existing.attendanceTime },
        });
        await tx.attendanceCorrection.create({
          data: {
            attendanceId: existing.id,
            adminId: req.session.adminId!,
            previousStatus: existing.status,
            newStatus: newStatus || existing.status,
            previousTime: existing.attendanceTime,
            newTime: newTime ? new Date(newTime) : existing.attendanceTime,
            reason: reason.trim(),
          },
        });
        return record;
      });

      await writeAuditLog({ adminId: req.session.adminId!, action: 'ATTENDANCE_CORRECTED', entityType: 'Attendance', entityId: existing.id, details: { reason }, ipAddress: req.ip });
      res.json({ success: true, record: updated });
    } catch {
      res.status(500).json({ error: 'Could not apply correction.' });
    }
  });

  app.get('/api/admin/attendance/export/csv', requireAuth, async (req, res) => {
    const { date, employeeId, status } = req.query as Record<string, string>;
    const where: Prisma.AttendanceWhereInput = {};
    if (date) where.attendanceDate = new Date(date);
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;

    const records = await prisma.attendance.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
    const settings = await getSettings();
    const csv = buildAttendanceCsv(
      records.map((r) => ({
        date: dateStringInTimezone(r.attendanceDate, settings.timezone),
        time: timeStringInTimezone(r.attendanceTime, settings.timezone),
        employeeCode: r.employee.employeeCode,
        employeeName: r.employee.fullName,
        truck: r.truckNumber,
        status: r.status,
        latitude: r.latitude,
        longitude: r.longitude,
        gpsAccuracy: r.gpsAccuracy,
        faceVerified: r.faceVerified,
        livenessVerified: r.livenessVerified,
        faceSimilarity: r.faceSimilarity,
        googleMapsLink: googleMapsLink(r.latitude, r.longitude),
      }))
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  });

  // ==========================================
  // ADMIN: SETTINGS
  // ==========================================
  app.get('/api/admin/settings', requireAuth, async (_req, res) => {
    res.json({ settings: await getSettings() });
  });

  app.put('/api/admin/settings', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const allowed: (keyof Prisma.CompanySettingsUpdateInput)[] = [
      'companyName',
      'timezone',
      'shiftStartTime',
      'gracePeriodMinutes',
      'gpsAccuracyThresholdMeters',
      'faceMatchThreshold',
      'workingDays',
      'maxFaceAttempts',
      'sessionTtlMinutes',
      'selfieRetentionDays',
    ];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) data[key] = req.body[key];
    }
    const settings = await prisma.companySettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
    await writeAuditLog({ adminId: req.session.adminId!, action: 'SETTINGS_UPDATED', entityType: 'CompanySettings', entityId: '1', details: data, ipAddress: req.ip });
    res.json({ success: true, settings });
  });

  // ==========================================
  // ADMIN: AUDIT LOGS
  // ==========================================
  app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), async (_req, res) => {
    const logs = await prisma.auditLog.findMany({ include: { admin: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ logs });
  });

  // ==========================================
  // ADMIN: GOOGLE SHEETS CONFIG
  // ==========================================
  app.get('/api/admin/sheets/config', requireAuth, async (_req, res) => {
    const config = await prisma.sheetsConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
    res.json({ config: { ...config, webhookUrl: config.webhookUrl ? '••••••• (configured)' : '' } });
  });

  app.put('/api/admin/sheets/config', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const { webhookUrl, sheetName, autoSync } = req.body || {};
    const config = await prisma.sheetsConfig.upsert({
      where: { id: 1 },
      update: { webhookUrl: webhookUrl ?? undefined, sheetName: sheetName ?? undefined, autoSync: autoSync ?? undefined },
      create: { id: 1, webhookUrl: webhookUrl || '', sheetName: sheetName || 'AttendanceLog', autoSync: !!autoSync },
    });
    await writeAuditLog({ adminId: req.session.adminId!, action: 'SHEETS_CONFIG_UPDATED', entityType: 'SheetsConfig', entityId: '1', ipAddress: req.ip });
    res.json({ success: true, config });
  });

  app.get('/api/admin/sheets/script-template', requireAuth, async (_req, res) => {
    const { getGoogleAppsScriptTemplate } = await import('./server/sheetsSync.js');
    res.json({ script: getGoogleAppsScriptTemplate() });
  });

  // ==========================================
  // ADMIN: FIRST-USER BOOTSTRAP (self-disables once any admin exists)
  // ==========================================
  app.post('/api/admin/bootstrap', async (req, res) => {
    const count = await prisma.adminUser.count();
    if (count > 0) {
      return res.status(403).json({ error: 'Setup already complete. Use the login page.' });
    }
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 10) {
      return res.status(400).json({ error: 'Name, email, and a password of at least 10 characters are required.' });
    }
    const passwordHash = await hashPassword(password);
    const admin = await prisma.adminUser.create({ data: { name, email: email.toLowerCase(), passwordHash, role: 'ADMIN', status: 'ACTIVE' } });
    await writeAuditLog({ adminId: admin.id, action: 'ADMIN_BOOTSTRAPPED', entityType: 'AdminUser', entityId: admin.id });
    res.json({ success: true });
  });

  // ==========================================
  // VITE MIDDLEWARE (dev) / STATIC (prod)
  // ==========================================
  if (!isProd) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Attendance server listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
