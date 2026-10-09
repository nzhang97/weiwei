import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const SYSTEM = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYSTEM, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM, 'System32', 'cmd.exe');
const SYSTEM_PATH = [path.join(SYSTEM, 'System32'), SYSTEM, path.dirname(POWERSHELL)].join(';');
const OPTIONS = { skip: !WIN, timeout: 60000 };
const MARKER = 'WEI_LAUNCHER_TEST:';
const normalized = (p) => path.resolve(p).toLowerCase();

function fixture(t) {
  const temp = mkdtempSync(path.join(tmpdir(), 'wei-launcher-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'Wei space \u536b\u620d');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'ws'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'ws', 'package.json'), '{}');
  for (const name of ['start-windows.bat', 'start-windows.ps1', 'resolve-node.ps1']) {
    copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  // Probe the environment passed to launch.mjs without starting a server or downloading anything.
  writeFileSync(path.join(root, 'scripts', 'launch.mjs'), `
import { spawnSync } from 'node:child_process';
const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true });
const npm = spawnSync('npm.cmd', ['--version'], { encoding: 'utf8', shell: true, windowsHide: true });
console.log(${JSON.stringify(MARKER)} + JSON.stringify({
  execPath: process.execPath, argv: process.argv.slice(2), cwd: process.cwd(),
  node: { status: node.status, stdout: node.stdout?.trim(), error: node.error?.message },
  npm: { status: npm.status, stdout: npm.stdout?.trim(), error: npm.error?.message }
}));
`);
  return { root, temp };
}

function runtime(dir) {
  mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'node.exe');
  try { linkSync(process.execPath, exe); } catch { copyFileSync(process.execPath, exe); }
  writeFileSync(path.join(dir, 'npm.cmd'), '@echo off\r\nnode "%~dp0npm-probe.mjs" %*\r\n');
  writeFileSync(path.join(dir, 'npm-probe.mjs'), 'console.log(JSON.stringify({execPath:process.execPath,argv:process.argv.slice(2)}));\n');
  return exe;
}

function env(extraPath = '') {
  const result = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|node_options|node_exe)$/i.test(k)));
  result.PATH = extraPath ? `${extraPath};${SYSTEM_PATH}` : SYSTEM_PATH;
  result.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  result.ComSpec = CMD;
  return result;
}

function launch(root, kind, args = [], extraPath = '') {
  const script = path.join(root, 'scripts', `start-windows.${kind}`);
  const command = kind === 'bat' ? CMD : POWERSHELL;
  const commandArgs = kind === 'bat'
    ? ['/d', '/s', '/c', `""${script}" ${args.map((a) => `"${a}"`).join(' ')}"`]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
  const r = spawnSync(command, commandArgs, {
    cwd: root, env: env(extraPath), encoding: 'utf8', windowsHide: true,
    windowsVerbatimArguments: kind === 'bat', input: '\r\n', timeout: 20000,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const line = r.stdout.split(/\r?\n/).find((s) => s.startsWith(MARKER));
  assert.ok(line, `launch.mjs did not run:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(MARKER.length));
}

function assertRuntime(result, exe, root) {
  assert.equal(normalized(result.execPath), normalized(exe));
  assert.equal(normalized(result.cwd), normalized(root));
  assert.equal(result.node.status, 0, JSON.stringify(result.node));
  assert.equal(normalized(result.node.stdout), normalized(exe), 'child node uses the selected runtime');
  assert.equal(result.npm.status, 0, JSON.stringify(result.npm));
  const npm = JSON.parse(result.npm.stdout);
  assert.equal(normalized(npm.execPath), normalized(exe), 'npm.cmd and its node child inherit PATH');
  assert.deepEqual(npm.argv, ['--version']);
}

function resolveNode(root) {
  const r = spawnSync(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts', 'resolve-node.ps1'), '-PathOnly',
  ], { cwd: root, env: env(), encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}

test('Windows batch finds portable Node without system Node and preserves spaced arguments', OPTIONS, (t) => {
  const { root } = fixture(t);
  const exe = runtime(path.join(root, '.runtime', 'node-v24.21.0-win-x64'));
  const args = ['--port', '3001', '--no-open', '--game', 'D:\\Games space\\\u660e\u65e5\u65b9\u821f', '--no-local'];
  const result = launch(root, 'bat', args);
  assertRuntime(result, exe, root);
  assert.deepEqual(result.argv, args);
});

test('Windows PowerShell finds portable Node and preserves Port plus remaining arguments', OPTIONS, (t) => {
  const { root } = fixture(t);
  const exe = runtime(path.join(root, '.runtime', 'node-v24.21.0-win-x64'));
  const rest = ['--no-open', '--game', 'D:\\Games space\\\u660e\u65e5\u65b9\u821f', '--no-local'];
  const result = launch(root, 'ps1', ['-Port', '3001', ...rest]);
  assertRuntime(result, exe, root);
  assert.deepEqual(result.argv, ['--port', '3001', ...rest]);
});

test('both Windows launchers preserve a supported Node already on PATH', OPTIONS, (t) => {
  const { root, temp } = fixture(t);
  runtime(path.join(root, '.runtime', 'node-v24.21.0-win-x64'));
  const exe = runtime(path.join(temp, 'system Node'));
  for (const kind of ['bat', 'ps1']) {
    const result = launch(root, kind, ['--help'], path.dirname(exe));
    assertRuntime(result, exe, root);
    assert.deepEqual(result.argv, ['--help']);
  }
});

test('Windows resolver validates the executable version instead of trusting the directory name', OPTIONS, (t) => {
  const { root } = fixture(t);
  const exe = runtime(path.join(root, '.runtime', 'node-v20.0.0-win-x64'));
  assert.equal(normalized(resolveNode(root)), normalized(exe), 'the executable is current Node despite the misleading directory name');
});

test('Windows resolver skips a broken portable executable when another runtime works', OPTIONS, (t) => {
  const { root } = fixture(t);
  const exe = runtime(path.join(root, '.runtime', 'node-v24.21.0-win-x64'));
  const broken = path.join(root, '.runtime', 'node-v99.0.0-win-x64');
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, 'node.exe'), 'not a Windows executable\n');
  assert.equal(normalized(resolveNode(root)), normalized(exe));
});
