import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const isDev = process.argv.includes('--dev');

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });

const shared = {
    bundle: true,
    target: 'es2020',
    minify: !isDev,
    sourcemap: isDev,
    loader: { '.glsl': 'text' },
};

await Promise.all([
    esbuild.build({ ...shared, format: 'esm', entryPoints: ['src/app.ts'], outfile: 'build/js/app.js' }),
    esbuild.build({ ...shared, format: 'iife', entryPoints: ['src/worker.ts'], outfile: 'build/js/worker.js' }),
]);

cpSync('index.html', 'build/index.html');
cpSync('css', 'build/css', { recursive: true });
cpSync('models', 'build/models', { recursive: true });
