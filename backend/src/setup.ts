/** Deploy-time database setup: `npm run db:setup`. Safe to run repeatedly. */
import { pool, setupDatabase } from "./db";

setupDatabase()
  .then(() => console.log("Database ready."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
