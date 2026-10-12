#!/usr/bin/env node
// Rasterize SVG icons to the PNG set required by the PWA manifest.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'public', 'icons');
mkdirSync(icons, { recursive: true });

const magick = existsSync('/usr/bin/magick') ? 'magick' : 'convert';
const run = (args) => execFileSync(magick, args, { stdio: 'inherit' });

copyFileSync(join(icons, 'icon.svg'), join(icons, 'favicon.svg'));

run([join(icons, 'icon.svg'), '-resize', '512x512', '-background', 'none', join(icons, 'icon-512.png')]);
run([join(icons, 'icon.svg'), '-resize', '192x192', '-background', 'none', join(icons, 'icon-192.png')]);
run([join(icons, 'icon-maskable.svg'), '-resize', '512x512', join(icons, 'icon-maskable-512.png')]);
run([join(icons, 'icon.svg'), '-resize', '180x180', '-background', '#0B0F17', '-flatten', join(icons, 'apple-touch-icon.png')]);

console.log('icons generated:', icons);
