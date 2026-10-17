import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
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
