import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * NEONFALL single-file plugin (writeBundle post-process).
 * Inlines the IIFE JS bundle into index.html so dist/index.html is fully
 * self-contained: it runs from file://, any static server, Electron and Android WebView.
 */
function inlineSingleFile(): Plugin {
  return {
    name: 'neonfall-inline-single-file',
    apply: 'build',
    writeBundle() {
      const outDir = resolve(projectRoot, 'dist');
      const htmlFile = join(outDir, 'index.html');
      if (!existsSync(htmlFile)) return;
      let html = readFileSync(htmlFile, 'utf8');

      const collect = (dir: string, out: string[] = []): string[] => {
        if (!existsSync(dir)) return out;
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) collect(p, out);
          else out.push(p);
        }
        return out;
      };
      const all = collect(outDir).filter((p) => p !== htmlFile);
      const jsFiles = all.filter((p) => p.endsWith('.js'));
      const cssFiles = all.filter((p) => p.endsWith('.css'));

      html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/g, '');
      html = html.replace(/<script[^>]*src=["'][^"']*["'][^>]*><\/script>/g, '');

      let css = '';
      for (const f of cssFiles) css += readFileSync(f, 'utf8');
      let js = '';
      for (const f of jsFiles) js += readFileSync(f, 'utf8') + '\n';
      const inlineJs = `<script>${js.replace(/<\/script>/gi, '<\\/script>')}</script>`;
      const styleTag = css ? `<style>${css}</style>` : '';
      html = html.replace('</head>', `${styleTag}</head>`);
      html = html.replace('</body>', `${inlineJs}</body>`);
      writeFileSync(htmlFile, html);
      for (const f of [...jsFiles, ...cssFiles]) {
        try {
          unlinkSync(f);
        } catch {
          /* keep going */
        }
      }
      console.log(`[neonfall] single-file build: ${html.length} bytes inline`);
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: resolve(projectRoot, 'index.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'neonfall.js',
      },
    },
  },
  plugins: [inlineSingleFile()],
  server: {
    port: 5173,
    host: true,
  },
});
