try { process.loadEnvFile("../backend/.env"); } catch {}
try { process.loadEnvFile("../backend/.env.local"); } catch {}

export default { serverExternalPackages: ["pg", "bcryptjs"], reactStrictMode: true };
