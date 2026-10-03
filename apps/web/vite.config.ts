import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server config.
 *
 * `/api` is proxied to the API process so the browser only ever makes same-origin relative
 * requests. That is a hard requirement in hosted preview environments (the browser is not on the
 * same host as the backend), and it also means no build-time API URL is needed for local work.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: false,
    // The preview host is not localhost, so host checking has to be off for the sandbox/proxy case.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  preview: { host: "0.0.0.0", port: Number(process.env.WEB_PORT ?? 4173), allowedHosts: true },
  build: { outDir: "dist", sourcemap: false },
});
