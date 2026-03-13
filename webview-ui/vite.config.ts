import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: {
      host: '127.0.0.1',
      port: 5173,
      protocol: 'ws',
    },
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (assetInfo) => {
          const fileName = assetInfo.name || '';
          if (fileName.endsWith('.css')) {
            return 'assets/style.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
