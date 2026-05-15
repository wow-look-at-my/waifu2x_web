import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const isDev = process.argv.includes('--dev');

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });

await esbuild.build({
    entryPoints: ['src/app.ts'],
    bundle: true,
    outfile: 'build/js/app.js',
    format: 'esm',
    target: 'es2020',
    minify: !isDev,
    sourcemap: isDev,
});

cpSync('index.html', 'build/index.html');
cpSync('css', 'build/css', { recursive: true });
cpSync('shaders', 'build/shaders', { recursive: true });
cpSync('models', 'build/models', { recursive: true });
