import { PrismaClient } from '@prisma/client';

// Reuse a single PrismaClient instance (important with tsx/nodemon hot-reload
// in dev, and generally good practice in production too).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}
