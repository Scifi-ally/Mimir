import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "framer-motion", "lightweight-charts", "@tanstack/react-query", "zustand", "lucide-react"],
  },
  server: {
    port: 3000,
    host: "127.0.0.1",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:5000",
        ws: true,
      },
    },
  },
  preview: {
    port: 3000,
    host: "127.0.0.1",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:5000",
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          motion: ["framer-motion"],
          charts: ["lightweight-charts"],
          vendor: ["@tanstack/react-query", "zustand"],
        },
      },
    },
  },
});
