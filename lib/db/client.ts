import { PrismaClient } from "@prisma/client";

// SEC-9 asks this module to import `server-only` so a client import fails the build. That guard
// is meaningless without a bundler: the package's default export throws outside a Server
// Component graph, so importing it here would break the proof scripts. There is no /app in
// Task 3, and the boundary is a Next.js-build concern — flagged, not silently dropped.

const globalForPrisma = globalThis as unknown as { fixoraPrisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.fixoraPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.fixoraPrisma = db;
}
