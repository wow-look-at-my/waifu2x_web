import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const isDev = process.argv.includes('--dev');

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });

const shared = {
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: !isDev,
    sourcemap: isDev,
};

await Promise.all([
    esbuild.build({ ...shared, entryPoints: ['src/app.ts'], outfile: 'build/js/app.js' }),
    esbuild.build({ ...shared, entryPoints: ['src/worker.ts'], outfile: 'build/js/worker.js' }),
]);

cpSync('index.html', 'build/index.html');
cpSync('css', 'build/css', { recursive: true });
cpSync('shaders', 'build/shaders', { recursive: true });
cpSync('models', 'build/models', { recursive: true });
