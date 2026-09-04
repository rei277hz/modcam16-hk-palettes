import { defineConfig } from "vite";

export default defineConfig({
  // Keep production assets usable when the site is hosted in a subfolder.
  base: "./",
  server: {
    host: "10.42.0.144",
    port: 5173,
  },
  build: {
    target: "es2022",
  },
});
