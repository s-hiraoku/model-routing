import { defaultDatabasePath, initializeDatabase } from "@model-routing/datastore";

const dbPath = Bun.env.DB_PATH ?? defaultDatabasePath();

initializeDatabase(dbPath);
console.info(`[db-init] initialized ${dbPath}`);
