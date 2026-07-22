import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // standalone: bundle minimal server.js pour le Docker du VPS (cf. Dockerfile)
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname),
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
