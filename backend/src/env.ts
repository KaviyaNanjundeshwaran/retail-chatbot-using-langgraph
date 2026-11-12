import fs from "node:fs";
import path from "node:path";

const backendRoot = path.resolve(__dirname, "..");
for (const file of [".env", ".env.local"]) {
  const fullPath = path.join(backendRoot, file);
  if (fs.existsSync(fullPath)) {
    try {
      process.loadEnvFile(fullPath);
    } catch {}
  }
}

