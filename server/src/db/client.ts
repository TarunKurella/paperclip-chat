import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface ServerDatabase {
  db: NodePgDatabase<Record<string, never>>;
  close(): Promise<void>;
}

export function createServerDatabase(env: NodeJS.ProcessEnv = process.env): ServerDatabase {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL required");
  }

  const pool = new Pool({ connectionString });
  return {
    db: drizzle(pool),
    close: async () => {
      await pool.end();
    },
  };
}
