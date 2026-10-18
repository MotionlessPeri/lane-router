import { defineConfig } from "vite";
export default defineConfig({ root: "src/ui/graphs", base: "/graphs/", build: { outDir: "../../../dist/ui/graphs", emptyOutDir: true } });
