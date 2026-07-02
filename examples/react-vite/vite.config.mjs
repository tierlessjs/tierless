import react from "@vitejs/plugin-react";
import stackmix from "stackmix/vite";

export default {
  plugins: [
    react(),
    stackmix({
      api: "./src/api.server.mjs",              // the trusted service — forked as a reference-monitor sidecar
      login: { user: "ana", pass: "demo" },     // demo session: one login per connection, token carried per call
    }),
  ],
};
