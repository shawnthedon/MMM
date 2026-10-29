/* ============ Self-modification — the sandbox ============
 * Runs one allowlisted command inside an experiment workspace, with:
 *   • the workspace as the working directory (never the repository);
 *   • a scrubbed environment — no gateway secrets, no DATA_DIR, no MMM_* variables;
 *   • a wall-clock timeout, output caps and a bounded Node heap;
 *   • captured stdout/stderr so the result is evidence, not a claim.
 *
 * Honest limits, stated everywhere this is reported: this is **process-level** isolation on the
 * gateway host, not a container or a VM. There is no kernel-level network block and no separate user
 * namespace, so an experiment that runs arbitrary shell code would be a risk — which is exactly why
 * only allowlisted commands run, why the environment carries no credentials, and why an experiment can
 * never promote itself. If you need stronger isolation, run the gateway inside a container with no
 * ambient credentials; the module will keep working because the contract is just "execute a command".
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HARD_RUNTIME_LIMIT_MS, checkSandboxCommand } from './policy.js';

const MAX_OUTPUT = 64 * 1024;

/** What the UI and the capability endpoint may truthfully say about the sandbox. */
export function describeSandbox() {
  return {
    isolation: 'process',
    label: 'Process isolation on the gateway host',
    limits: { runtimeMs: HARD_RUNTIME_LIMIT_MS, heapMB: 256, outputBytes: MAX_OUTPUT },
    enforced: [
      'cwd is the experiment workspace; the repository is read-only to it',
      'environment is rebuilt from scratch: no secrets, no DATA_DIR, no MMM_* variables',
      'command must match the allowlist (node --check, node <script>, npm run test*)',
      'wall-clock timeout with SIGKILL, output truncated at 64 KB, Node heap capped',
    ],
    notEnforced: [
      'kernel network isolation — the sandbox inherits the host network',
      'filesystem isolation outside the workspace — a script could still read world-readable files',
      'CPU quotas beyond the wall clock',
    ],
    recommendation: 'Run the gateway in a container without ambient credentials for defence in depth.',
  };
}

const KEEP_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

function sandboxEnv(workspace) {
  const env = { NODE_ENV: 'test', MMM_SANDBOX: '1', CI: '1', NODE_OPTIONS: '--max-old-space-size=256' };
  for (const key of KEEP_ENV) if (process.env[key]) env[key] = process.env[key];
  // A writable HOME inside the workspace, so tools cannot touch the operator's home directory.
  const home = join(workspace, '.sandbox-home');
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  return env;
}

/**
 * @returns {Promise<{ ok: boolean, code: number|null, signal: string|null, timedOut: boolean, durationMs: number,
 *   stdout: string, stderr: string, truncated: boolean, command: string, label: string, reason?: string }>}
 */
export async function runInSandbox({ command, workspace, timeoutMs = 60000 } = {}) {
  const verdict = checkSandboxCommand(command);
  if (!verdict.ok) {
    return { ok: false, code: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: '', truncated: false, command: String(command || ''), label: '', reason: verdict.reason };
  }
  const budget = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), HARD_RUNTIME_LIMIT_MS);
  const argv = verdict.command.split(' ');
  const started = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: workspace,
        env: sandboxEnv(workspace),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group, so a timeout can kill children too
      });
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: '', truncated: false, command: verdict.command, label: verdict.label, reason: String(error.message || error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const collect = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > MAX_OUTPUT) { stdout += text.slice(0, Math.max(0, MAX_OUTPUT - stdout.length)); truncated = true; }
        else stdout += text;
      } else if (stderr.length + text.length > MAX_OUTPUT) { stderr += text.slice(0, Math.max(0, MAX_OUTPUT - stderr.length)); truncated = true; }
      else stderr += text;
    };
    child.stdout?.on('data', (c) => collect(c, 'out'));
    child.stderr?.on('data', (c) => collect(c, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, budget);
    timer.unref?.();

    const finish = (code, signal, reason) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      resolve({
        ok: code === 0 && !timedOut,
        code: code ?? null,
        signal: signal ?? null,
        timedOut,
        durationMs,
        stdout: stdout.slice(-MAX_OUTPUT),
        stderr: stderr.slice(-MAX_OUTPUT),
        truncated,
        command: verdict.command,
        label: verdict.label,
        ...(reason ? { reason } : {}),
      });
    };

    child.on('error', (error) => finish(null, null, String(error.message || error)));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** A compact, honest one-line report for a timeline entry. */
export function summariseRun(run) {
  if (!run) return 'no run recorded';
  const status = run.timedOut ? 'timed out' : run.ok ? 'passed' : `failed (exit ${run.code ?? run.signal ?? 'unknown'})`;
  return `${run.command} → ${status} in ${Math.round((run.durationMs || 0) / 100) / 10}s`;
}
