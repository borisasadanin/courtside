import { defineConfig } from "vite";
import { resolve } from "path";

// In development the API runs on its own port.  Proxying /api keeps the page
// same-origin, so runtime-config.js can ship empty and the dev setup needs no
// per-developer edits.
const API_TARGET = process.env.COURTSIDE_API_URL || "http://localhost:8000";

export default defineConfig({
  server: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: "es2015",
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        clip: resolve(__dirname, "clip.html"),
      },
      output: {
        // Single chunk — no dynamic imports, no code splitting
        manualChunks: undefined,
      },
    },
  },
});
