import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI lives in web/ and is served by the API process in production (npm run build && npm start).
// In development, `npm run dev:web` serves it with hot reload and proxies API calls to `npm run dev`.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/v1": "http://127.0.0.1:8787" } },
});
