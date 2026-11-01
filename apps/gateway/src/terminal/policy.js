/* ============ Terminal — command policy ============
 * Everything the terminal will and will not run, decided in one place, before a process exists.
 *
 * Three rules shape this file:
 *   1. **No shell.** Commands are tokenised here and spawned with `shell: false`, so `a && b`, pipes,
 *      redirects and `$(…)` are refused with a reason instead of being silently interpreted.
 *   2. **Rarely more than node, npm and npx.** The requirement is a Node/npm terminal; a general shell
 *      is a different product with a different threat model.
 *   3. **Destructive is a decision, not a warning.** `npm ci`, `npm uninstall` and `npm publish` are
 *      classified here and the caller must route them through the approval gate.
 *
 * Honest limit, stated in the docs and in the capability payload: `npm install` and `node <script>`
 * execute project code by design. This module narrows *what* runs and *where*; it cannot make npm
 * safe. Process isolation on the gateway host is the containment, exactly as with the evolution
 * sandbox — run the gateway in a container without ambient credentials for defence in depth.
 */

import { resolve, sep } from 'node:path';

export const TERMINAL_EXECUTABLES = Object.freeze(['node', 'npm', 'npx']);

/** Characters that would require a shell to mean anything. Refused, never reinterpreted. */
const SHELL_METACHARACTERS = /[;&|`><\n\r]|\$\(|\$\{|\|\|/;

/** npm flags that reach outside the workspace, or that redirect the registry/proxy. */
const REFUSED_NPM_FLAGS = Object.freeze([
  { re: /^-g$|^--global$|^--location=global$/, reason: 'global installs write outside the workspace' },
  { re: /^--prefix(=|$)/, reason: '--prefix can retarget npm at any directory on the host' },
  { re: /^--userconfig(=|$)|^--globalconfig(=|$)/, reason: 'config files outside the workspace can redirect npm' },
  { re: /^--registry(=|$)/, reason: 'the registry is fixed by the deployment, not by a command' },
  { re: /^--(https?-)?proxy(=|$)/, reason: 'proxies can be used to reach arbitrary hosts' },
  { re: /^--cache(=|$)/, reason: '--cache can point at any directory on the host' },
  { re: /^--script-shell(=|$)/, reason: 'a custom script shell would bypass the no-shell rule' },
]);

/** Subcommands that delete, publish or overwrite something. Each one needs an approval first. */
const DESTRUCTIVE_NPM = Object.freeze([
  { re: /^(uninstall|remove|rm|un|r)$/, label: 'removes packages and rewrites the lockfile' },
  { re: /^ci$/, label: 'deletes node_modules and reinstalls from the lockfile' },
  { re: /^(publish|unpublish|deprecate|owner|dist-tag)$/, label: 'changes what other people can install' },
  { re: /^audit$/, args: /(^|\s)--force(\s|$)/, label: 'audit --force applies breaking upgrades' },
  { re: /^exec$/, label: 'npm exec can run an arbitrary binary' },
  { re: /^link$/, label: 'link writes into the global prefix' },
]);

const MAX_ARGV = 64;
const MAX_ARG = 1024;

function fail(reason, code = 'refused') {
  return { ok: false, reason, code };
}

/**
 * Split a command line into argv, honouring quotes but not shell syntax.
 * A line that *needs* a shell is refused rather than approximated.
 */
export function tokenise(line) {
  const raw = String(line ?? '');
  if (!raw.trim()) return fail('the command is empty');
  if (raw.length > 4096) return fail('the command line is too long (4096 characters max)');

  const argv = [];
  let current = '';
  let quote = '';
  let escaped = false;
  let started = false;

  for (const ch of raw) {
    if (escaped) { current += ch; escaped = false; started = true; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started) { argv.push(current); current = ''; started = false; }
      continue;
    }
    if (SHELL_METACHARACTERS.test(ch)) {
      return fail(`“${ch}” needs a shell. This terminal runs one command at a time — no pipes, redirects, chaining or substitution.`);
    }
    current += ch;
    started = true;
  }
  if (escaped) return fail('the command ends with a dangling escape');
  if (quote) return fail(`the command has an unclosed ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) argv.push(current);
  if (!argv.length) return fail('the command is empty');
  if (argv.length > MAX_ARGV) return fail(`too many arguments (${argv.length}, max ${MAX_ARGV})`);
  const tooLong = argv.find((a) => a.length > MAX_ARG);
  if (tooLong) return fail(`an argument is longer than ${MAX_ARG} characters`);
  return { ok: true, argv };
}

const isAbsolute = (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

/**
 * Decide whether this argv may run, and whether it needs an approval first.
 * @returns {{ ok: boolean, argv?: string[], executable?: string, destructive?: boolean,
 *             label?: string, reasons?: string[], risk?: 'low'|'medium'|'high', reason?: string }}
 */
export function checkCommand(line, { workspaceAbs = null } = {}) {
  const parsed = tokenise(line);
  if (!parsed.ok) return parsed;
  const [head, ...args] = parsed.argv;

  // The executable is the basename, so `/usr/bin/npm` cannot slip past the allowlist by path.
  const base = head.split(/[\\/]/).pop();
  if (!TERMINAL_EXECUTABLES.includes(base)) {
    const known = TERMINAL_EXECUTABLES.join(', ');
    return fail(`“${head}” is not an allowed executable. This terminal runs ${known} only.`, 'not-allowed');
  }
  if (isAbsolute(head) && !/^(?:.*\/)?(node|npm|npx)$/.test(head)) {
    return fail(`“${head}” resolves outside the runtime directory`, 'not-allowed');
  }

  const reasons = [];
  let risk = 'low';

  if (base === 'npm') {
    const sub = args.find((a) => !a.startsWith('-'));
    for (const arg of args) {
      const hit = REFUSED_NPM_FLAGS.find((f) => f.re.test(arg));
      if (hit) return fail(`npm ${arg}: ${hit.reason}`, 'not-allowed');
    }
    for (const d of DESTRUCTIVE_NPM) {
      if (!sub) break;
      if (d.re.test(sub) && (!d.args || d.args.test(args.join(' ') + ' '))) {
        reasons.push(`npm ${sub}: ${d.label}`);
      }
    }
    if (sub === 'install' || sub === 'i' || sub === 'add') {
      if (args.includes('--force') || args.includes('-f')) reasons.push('npm install --force rewrites the dependency tree');
      // Everything after the subcommand that is not a flag is a package name. A bare `npm install`
      // installs whatever the lockfile says and runs every postinstall script in the tree, so it is
      // the higher-risk form of the two.
      const rest = args.slice(args.indexOf(sub) + 1).filter((a) => !a.startsWith('-'));
      risk = rest.length ? 'medium' : 'high';
    }
    if (sub === 'exec') risk = 'high';
  }

  if (base === 'npx') {
    // npx downloads a package and runs its binary — arbitrary code by definition.
    risk = 'high';
    if (!args.length) return fail('npx needs a package or command', 'bad-request');
  }

  if (base === 'node' && args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
    risk = 'high'; // inline code is arbitrary code, same as a script, but worth flagging in the record
  }

  // An absolute path argument must resolve inside the workspace. Relative paths are resolved by the
  // process itself, which is already confined to the working directory by the spawn call.
  for (const arg of args) {
    if (!isAbsolute(arg)) continue;
    if (workspaceAbs) {
      const target = resolve(arg);
      const base = resolve(workspaceAbs);
      if (target !== base && !target.startsWith(base + sep)) {
        return fail(`“${arg}” is outside the workspace (${base})`, 'bad-path');
      }
    }
    risk = risk === 'low' ? 'medium' : risk;
  }

  return {
    ok: true,
    argv: [base, ...args],
    executable: base,
    destructive: reasons.length > 0,
    reasons,
    label: `${base} ${args.slice(0, 3).join(' ')}`.trim(),
    risk,
  };
}

/** The environment a terminal child may see: an allowlist, never the gateway's own surroundings. */
export const ENV_ALLOWLIST = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'COLUMNS', 'LINES']);

/** Variable names that must never be inherited from the host, even if someone adds them above. */
const SECRET_ENV = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|COOKIE|SESSION|CSRF|AUTH)/i;

export function buildEnv({ base = process.env, sessionEnv = {}, home, workspace } = {}) {
  const env = {
    // A child must never believe it is inside the gateway's own identity.
    MMM_TERMINAL: '1',
    NODE_ENV: 'development',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_progress: 'false',
  };
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (value === undefined) continue;
    if (SECRET_ENV.test(key)) continue; // belt and braces: an allowlisted name still cannot carry a secret
    env[key] = value;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (home) env.HOME = home;
  if (workspace) env.npm_config_cache = `${workspace}/.npm-cache`;
  for (const [key, value] of Object.entries(sessionEnv || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    env[key] = String(value ?? '').slice(0, 4096);
  }
  return env;
}

/** What the client may truthfully be told about the sandbox the terminal runs in. */
export function describeTerminalPolicy() {
  return {
    isolation: 'process',
    executables: [...TERMINAL_EXECUTABLES],
    shell: false,
    note: 'Commands run as real child processes on the gateway host, one at a time, with no shell. '
      + 'npm install and node <script> execute project code by design; the containment is the '
      + 'gateway host itself, so run it in a container if you need stronger isolation.',
    limits: {
      concurrentRunsPerSession: 1,
      outputBytesPerRun: 2 * 1024 * 1024,
      defaultTimeoutMs: 30 * 60 * 1000,
      maxTimeoutMs: 2 * 60 * 60 * 1000,
    },
    refused: [
      'shell syntax: pipes, redirects, chaining, substitution',
      'executables other than node, npm and npx',
      'npm global installs and any --prefix / --registry / --proxy / --cache retargeting',
      'paths outside the workspace',
    ],
    needsApproval: [
      'npm ci', 'npm uninstall', 'npm publish / unpublish / deprecate', 'npm audit fix',
      'npm install --force', 'npm exec', 'npm link',
    ],
    notEnforced: [
      'kernel-level network isolation — a child inherits the host network',
      'filesystem isolation beyond the working directory — a script can read world-readable files',
      'CPU quotas beyond the wall clock',
    ],
  };
}
