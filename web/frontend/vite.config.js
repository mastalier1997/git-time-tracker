import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built assets are served by the Express backend from ./public.
// During `npm run dev`, /api is proxied to the backend on :8787.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
