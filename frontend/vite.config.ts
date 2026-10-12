import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

const consoleAssetHeaders: Plugin = {
  name: 'console-asset-headers',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: '_headers', source: '/_ui/*\n  Cache-Control: no-cache\n' });
  },
};

export default defineConfig({
  plugins: [solid(), tailwindcss(), consoleAssetHeaders],
  publicDir: '../assets',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: {
        entryFileNames: '_ui/console.js',
        chunkFileNames: '_ui/[name]-[hash].js',
        assetFileNames: asset => asset.names?.some(name => name.endsWith('.css')) ? '_ui/console.css' : '_ui/[name]-[hash][extname]',
      },
    },
  },
});
