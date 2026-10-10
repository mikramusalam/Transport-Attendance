/**
 * Seed script — creates the FIRST admin account and default company settings.
 * Run once after migrating: `npm run db:seed`
 *
 * Reads credentials from env vars so no password is ever hard-coded:
 *   SEED_ADMIN_NAME
 *   SEED_ADMIN_EMAIL
 *   SEED_ADMIN_PASSWORD
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const name = process.env.SEED_ADMIN_NAME || 'Fleet Administrator';
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      '\nERROR: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set as environment variables.\n' +
        'Example:\n' +
        '  SEED_ADMIN_EMAIL=owner@yourcompany.com SEED_ADMIN_PASSWORD="Choose-A-Strong-Password-1!" npm run db:seed\n'
    );
    process.exit(1);
  }

  if (password.length < 10) {
    console.error('ERROR: SEED_ADMIN_PASSWORD must be at least 10 characters.');
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.log(`Admin ${email} already exists. Skipping admin creation.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    console.log(`Created admin user: ${email} (role: ADMIN)`);
  }

  const existingSettings = await prisma.companySettings.findUnique({ where: { id: 1 } });
  if (!existingSettings) {
    await prisma.companySettings.create({
      data: {
        id: 1,
        companyName: process.env.SEED_COMPANY_NAME || 'Company',
        timezone: 'Asia/Karachi',
        shiftStartTime: '08:00',
        gracePeriodMinutes: 15,
        gpsAccuracyThresholdMeters: 100,
        faceMatchThreshold: 0.55,
        workingDays: 'Mon,Tue,Wed,Thu,Fri,Sat',
        maxFaceAttempts: 5,
        sessionTtlMinutes: 10,
      },
    });
    console.log('Created default company_settings row.');
  } else {
    console.log('company_settings already exists. Skipping.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
