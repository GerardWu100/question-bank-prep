import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  // fileURLToPath, not URL.pathname: on Windows the pathname is "/D:/...", which is not a path.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        // Keep the browser's Host header so the server's Origin == Host check passes.
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
});
