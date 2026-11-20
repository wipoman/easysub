// Use the upstream local-first Vue client on the web and keep its offline shell.
import preview from './vite.android-preview.config.js'
export default {
  ...preview,
  define: { 'import.meta.env.VITE_WORKER_WEB': 'true' },
  build: { ...preview.build, rollupOptions: { input: ['index.html', 'android-app.html'] } },
}
