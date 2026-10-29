/* RELAY design-system contract: semantic tokens, appearance modes, contrast and touch targets.
 * Run: npm run test:design
 * This checks authored CSS and token maths; it does not replace the real-browser layout test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const cssFiles = readdirSync(join(root, 'src')).filter((file) => file.endsWith('.css'));
const theme = read('src/theme.css');
const styles = read('src/styles.css');
const checks = [];
let failures = 0;
const check = (name, fn) => {
  try { fn(); checks.push(`PASS ${name}`); } catch (error) { failures += 1; checks.push(`FAIL ${name}: ${error.message}`); }
};
const assert = (value, message) => { if (!value) throw new Error(message); };

const tokenSets = {};
for (const match of theme.matchAll(/(?::root|\[data-theme='([a-z-]+)'\])\s*\{([\s\S]*?)\}/g)) {
  const selector = match[1] || 'dark';
  if (!tokenSets[selector]) tokenSets[selector] = {};
  for (const declaration of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) tokenSets[selector][declaration[1]] = declaration[2].trim();
}
const mode = (name, token) => {
  for (const key of [name, 'dark']) if (tokenSets[key]?.[token]) return tokenSets[key][token];
  throw new Error(`${token} is not defined for ${name}`);
};
const rgb = (hex) => {
  const value = hex.replace('#', '');
  assert(/^[\da-f]{6}$/i.test(value), `not a six-digit hex token: ${hex}`);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
};
const luminance = (hex) => rgb(hex)
  .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};
const mix = (foreground, background, amount) => `#${rgb(foreground)
  .map((channel, index) => Math.round((channel * amount + rgb(background)[index] * (1 - amount)) * 255).toString(16).padStart(2, '0'))
  .join('')}`;

const required = ['bg-base', 'bg-surface', 'bg-elevated', 'text-primary', 'text-muted', 'accent-primary',
  'accent-hover', 'accent-pressed', 'text-on-accent', 'border-default', 'border-subtle',
  'state-success', 'state-warning', 'state-error', 'state-error-strong', 'font-sans', 'font-mono'];

check('all four appearance modes define the semantic tokens, dark by default', () => {
  for (const name of ['dark', 'light', 'oled', 'high-contrast']) {
    for (const token of required) assert(mode(name, token), `${name} is missing --${token}`);
  }
  assert(/<html lang="en" data-theme="dark">/.test(read('index.html')), 'dark is not the server-rendered default');
});

check('the default dark tokens match the RELAY palette', () => {
  const expected = { 'bg-base': '#0B0F17', 'bg-surface': '#111827', 'bg-elevated': '#1F2937',
    'text-primary': '#F9FAFB', 'text-muted': '#9CA3AF', 'accent-primary': '#3B82F6',
    'accent-hover': '#2563EB', 'accent-pressed': '#1D4ED8', 'text-on-accent': '#FFFFFF',
    'border-default': '#374151', 'border-subtle': '#1F2937', 'state-success': '#10B981',
    'state-warning': '#F59E0B', 'state-error': '#EF4444', 'state-error-strong': '#B91C1C' };
  for (const [token, value] of Object.entries(expected)) {
    assert(mode('dark', token).toUpperCase() === value, `--${token} is ${mode('dark', token)}, expected ${value}`);
  }
});

check('every text token meets WCAG AA (4.5:1) on the surfaces it is specified for', () => {
  const failures = [];
  // Spec §Contrast: body text on all surfaces; accent and status text on base/surface.
  const pairs = {
    'text-primary': ['bg-base', 'bg-surface', 'bg-elevated'],
    'text-muted': ['bg-base', 'bg-surface', 'bg-elevated'],
    'accent-primary': ['bg-base', 'bg-surface'],
    'state-success': ['bg-base', 'bg-surface'],
    'state-warning': ['bg-base', 'bg-surface'],
    'state-error': ['bg-base', 'bg-surface'],
  };
  for (const name of ['dark', 'light', 'oled', 'high-contrast']) {
    for (const [foreground, surfaces] of Object.entries(pairs)) {
      for (const background of surfaces) {
        const ratio = contrast(mode(name, foreground), mode(name, background));
        if (Math.round(ratio * 100) / 100 < 4.5) failures.push(`${name}: --${foreground} on --${background} = ${ratio.toFixed(2)}:1`);
      }
    }
    for (const [foreground, background] of [['text-on-accent', 'accent-hover'], ['text-on-accent', 'accent-pressed'], ['text-on-accent', 'state-error-strong']]) {
      const ratio = contrast(mode(name, foreground), mode(name, background));
      if (ratio < 4.5) failures.push(`${name}: --${foreground} on --${background} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert(!failures.length, failures.join('; '));
});

check('status badges use a 5% tint and keep status text readable', () => {
  assert(/\.chip\.bad \{[^}]*var\(--(?:state-error|danger)\) 5%, var\(--surface\)/.test(styles), 'error chip is not a 5% tint');
  assert(!/color-mix\(in srgb, var\(--(danger|state-error)\) 10%/.test(styles), 'a 10% error tint is still present');
  for (const name of ['dark', 'light', 'oled', 'high-contrast']) {
    for (const state of ['state-success', 'state-warning', 'state-error']) {
      const tint = mix(mode(name, state), mode(name, 'bg-surface'), 0.05);
      const ratio = contrast(mode(name, state), tint);
      assert(ratio >= 4.5, `${name}: --${state} on its 5% tint is ${ratio.toFixed(2)}:1`);
    }
  }
});

check('--accent-primary is never used as a solid action or badge fill', () => {
  const offenders = [];
  for (const file of cssFiles) {
    for (const rule of read(`src/${file}`).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = rule[1].trim().replace(/\s+/g, ' ');
      const body = rule[2];
      if (/\.(btn|chip|toast|banner|seg button)[\w.-]*/.test(selector) && /(?:^|;)\s*background(?:-color)?:\s*var\(--(?:brand|accent-primary)\)/.test(body)) offenders.push(`${file}: ${selector}`);
    }
  }
  assert(!offenders.length, offenders.join('; '));
});

check('solid primary actions rest on --accent-hover and press to --accent-pressed', () => {
  assert(/\.btn\.primary \{ background: var\(--accent-hover\);/.test(styles), '.btn.primary does not use --accent-hover');
  assert(/\.btn\.primary:hover[^{]*\{ background: var\(--accent-pressed\);/.test(styles), '.btn.primary has no pressed state');
});

check('hard-coded colours live only in the token sheet', () => {
  const offenders = [];
  for (const file of [...cssFiles.map((name) => `src/${name}`), 'tailwind.config.js']) {
    if (file === 'src/theme.css') continue;
    const matches = [...read(file).matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
    if (matches.length) offenders.push(`${file}: ${[...new Set(matches)].join(', ')}`);
  }
  for (const file of readdirSync(join(root, 'src'))) {
    if (!file.endsWith('.js')) continue;
    const source = read(`src/${file}`).replace(/var\([^)]*\)/g, '');
    const matches = [...source.matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0]);
    if (matches.length) offenders.push(`src/${file}: ${[...new Set(matches)].join(', ')}`);
  }
  assert(!offenders.length, offenders.join('; '));
});

check('semantic Tailwind utilities resolve to theme tokens', () => {
  const config = read('tailwind.config.js');
  for (const token of ['bg-base', 'bg-surface', 'text-muted', 'accent-hover', 'state-error']) {
    assert(config.includes(`var(--${token})`), `tailwind.config.js does not map var(--${token})`);
  }
  assert(/@tailwind utilities;/.test(styles), 'the Tailwind utilities layer is not imported');
});

check('navigation and primary controls keep 44px touch targets', () => {
  assert(/\.btn \{[^}]*min-height: 44px/.test(styles), '.btn has no 44px minimum height');
  assert(/\.btn\.sm \{[^}]*min-height: 44px/.test(styles), '.btn.sm shrinks below 44px');
  assert(/\.iconbtn \{\s*width: 44px; height: 44px/.test(styles), '.iconbtn is smaller than 44px');
  assert(/\.side-link \{[^}]*min-height: 44px/.test(styles), 'desktop sidebar links are smaller than 44px');
  assert(/\.deck-link \{[^}]*min-height: 44px/.test(styles), 'deck links are smaller than 44px');
});

check('sheet switches expose role, state and keyboard operation', () => {
  const shell = read('src/shell.js');
  assert(/export function enhanceSwitches/.test(shell), 'switch enhancement helper is missing');
  assert(/setAttribute\('role', 'switch'\)/.test(shell), 'switches are not exposed as a switch');
  assert(/aria-checked/.test(shell), 'switches do not expose their checked state');
  assert(/e\.key === 'Enter' \|\| e\.key === ' '/.test(shell), 'switches do not respond to Enter/Space');
  assert(/enhanceSwitches\(viewEl\)/.test(read('src/main.js')), 'views are not enhanced after render');
  assert(/enhanceSwitches\(sheet\)/.test(shell), 'sheets are not enhanced after opening');
});

check('desktop shell adds a sidebar while mobile keeps bottom navigation', () => {
  assert(/\.sidebar \{ display: none; \}/.test(styles), 'the sidebar is not hidden by default');
  assert(/@media \(min-width: 1100px\) \{\s*\.app \{ padding-left: 232px; \}/.test(styles), 'the desktop shell is not a min-width enhancement');
  assert(/id="tabbar"/.test(read('src/shell.js')), 'the mobile bottom navigation was removed');
});

check('the radius scale matches the RELAY component table', () => {
  assert(/\.chip \{[^}]*border-radius: var\(--radius-s\)/.test(styles), 'chips are not on the 6px badge radius');
  assert(/\.chip\.tiny \{[^}]*border-radius: var\(--radius-xs\)/.test(styles), 'small chips are not on the 4px radius');
  assert(/\.avatar \{[^}]*border-radius: 9999px/.test(styles), 'avatars are not circular');
  assert(/\.sheet \{[^}]*var\(--radius-xl\) var\(--radius-xl\) 0 0/.test(styles), 'sheets are not 16px');
  assert(/\.cp-fab-ico \{[^}]*border-radius: 9999px/.test(read('src/copilot.css')), 'the Copilot launcher is not circular');
});

check('the stage microphone stays small and beside the type-instead link', () => {
  const copilot = read('src/copilot.css');
  const base = copilot.match(/\.cp-mic \{([\s\S]*?)\}/);
  assert(base, 'the stage microphone rule is missing');
  const width = Number((base[1].match(/width:\s*(\d+)px/) || [])[1]);
  assert(width >= 44, `the mic must stay a 44px touch target, got ${width}px`);
  assert(width <= 64, `the mic is too large for the stage again (${width}px); it covers the hologram`);
  const row = copilot.match(/\.cp-voice-row \{([\s\S]*?)\}/);
  assert(row, 'the mic no longer shares a row with the type-instead link');
  assert(/display:\s*flex/.test(row[1]), 'the voice row is not a flex row');
  assert(!/flex-direction:\s*column/.test(row[1]), 'the voice row must be horizontal');
  const large = copilot.match(/@media \(min-width: 720px\)[\s\S]*?\.cp-mic \{ width: (\d+)px/);
  assert(!large || Number(large[1]) <= 72, `the wide-screen mic must not grow past 72px, got ${large && large[1]}px`);
});

check('motion and focus affordances are honoured', () => {
  assert(/:focus-visible \{ outline: 2px solid/.test(styles), 'no global focus ring');
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(styles), 'no reduced-motion support');
});

console.log(checks.join('\n'));
console.log(`\nDESIGN SYSTEM: ${checks.length - failures}/${checks.length} PASSED`);
if (failures) process.exitCode = 1;
