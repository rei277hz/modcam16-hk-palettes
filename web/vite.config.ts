import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Keep production assets usable when the site is hosted in a subfolder.
  base: "./",
  server: {
    host: "10.42.0.144",
    port: 5173,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        picker: resolve(__dirname, "index.html"),
        decompose: resolve(__dirname, "decompose.html"),
      },
    },
  },
});
