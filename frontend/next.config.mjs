/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: import.meta.dirname,
  },
  // The browser only talks to this app; /api is proxied to the backend so the session cookie stays same-origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.BACKEND_URL ?? "http://localhost:3001"}/api/:path*` }];
  },
};

export default nextConfig;
