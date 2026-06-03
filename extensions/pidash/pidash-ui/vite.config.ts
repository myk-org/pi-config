import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Shared UI files live outside this project tree, so Rolldown can't
// walk up to our node_modules from their directory. Re-root bare
// imports via a plugin that fires before the default resolver.
const sharedDir = path.resolve(__dirname, "../../shared/ui");
const fakeImporter = path.resolve(__dirname, "src/__shared_proxy__.ts");

export default defineConfig({
  plugins: [
    {
      name: "resolve-shared-deps",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (
          importer &&
          importer.startsWith(sharedDir) &&
          !source.startsWith(".") &&
          !source.startsWith("/") &&
          !source.startsWith("@/") &&
          !source.startsWith("@ui")
        ) {
          // Re-resolve as if imported from inside this project
          return this.resolve(source, fakeImporter, {
            ...options,
            skipSelf: true,
          });
        }
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ui": path.resolve(__dirname, "../../shared/ui"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:19190",
      "/ws": { target: "ws://localhost:19190", ws: true },
    },
  },
});
