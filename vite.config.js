import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiHandler } from "./server/api.js";

// In dev, the API runs inside the Vite server process: `npm run dev` is all you need.
const api = () => ({
  name: "whiteboard-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => apiHandler(req, res, next));
  },
});

export default defineConfig({
  plugins: [react(), api()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  server: { port: 5173, host: "127.0.0.1" },
});
