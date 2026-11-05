import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client is a static Vite app. It makes no model or API calls; in Stage 3 it will talk to the
// station server over WebSocket. Keep provider keys and server code out of it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The station server (npm run server) serves the API and the event stream.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    target: "es2023",
    // Phaser alone is about 1.2 MB minified; one chunk is fine for a local app.
    chunkSizeWarningLimit: 2500,
  },
});
