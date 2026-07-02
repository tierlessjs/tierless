import react from "@vitejs/plugin-react";
import tierless from "tierless/vite";

export default {
  plugins: [
    react(),
    tierless({
      api: "./src/api.server.mjs",              // the trusted service — forked as a reference-monitor sidecar
      login: { user: "ana", pass: "demo" },     // demo session: one login per connection, token carried per call
    }),
  ],
};
