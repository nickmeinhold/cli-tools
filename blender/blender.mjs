#!/usr/bin/env node
/**
 * blender — CLI wrapper around the BlenderMCP addon + headless Blender.
 *
 * Two ways to drive Blender, same as the MCP exposed but from the shell:
 *
 *   SOCKET MODE (live Blender, mirrors the MCP server) — talks to the
 *   blender_mcp_addon.py TCP server on localhost:9876. Blender must be OPEN with
 *   the BlenderMCP panel's server started (N-panel → BlenderMCP → Connect/Start
 *   MCP Server). Lets you drive the running session and screenshot the viewport.
 *     blender eval --code "import bpy; print(len(bpy.data.objects))"
 *     blender eval --file script.py
 *     blender scene
 *     blender object --name Cube
 *     blender screenshot --out /tmp/vp.png [--max-size 1200]
 *     blender raw --type get_scene_info --params '{}'
 *     blender ping
 *
 *   HEADLESS MODE (no running Blender, reproducible batch) — runs
 *   `blender --background [blend] --python script`. This is what automated jobs
 *   (GLB import/export, blendshape transfer) should use.
 *     blender headless --file job.py [--blend in.blend] [-- arg1 arg2]
 *     blender headless --code "import bpy; print(bpy.app.version_string)"
 *
 * All structured output is JSON to stdout; eval/headless print captured stdout.
 * Protocol (socket): send {"type","params"} → recv {"status","result"} | {"status":"error","message"}.
 */

import net from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = 9876;
const BLENDER_BIN = process.env.BLENDER_BIN || 'blender';

// --- arg parsing (--flag value, --flag=value, bare positionals, `--` passthrough) ---
function parseArgs(argv) {
  const out = { _: [], passthrough: [] };
  let afterDD = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDD) { out.passthrough.push(a); continue; }
    if (a === '--') { afterDD = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[a.slice(2)] = argv[++i]; }
      else { out[a.slice(2)] = true; }
    } else { out._.push(a); }
  }
  return out;
}

// --- socket: send one command, resolve with parsed JSON response ---
function send(command, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port: PORT });
    let buf = '';
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(command)));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      try { const j = JSON.parse(buf); resolve(j); sock.end(); } catch { /* wait for more */ }
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('socket timeout (is the BlenderMCP server running in an open Blender?)')); });
    sock.on('error', (e) => reject(new Error(
      `${e.message}\nIs Blender open with the MCP server started? (N-panel → BlenderMCP → Start MCP Server, port ${PORT})`)));
    sock.on('end', () => { if (buf) { try { resolve(JSON.parse(buf)); } catch { reject(new Error('incomplete/garbled response: ' + buf.slice(0, 300))); } } });
  });
}

function unwrap(resp) {
  if (resp && resp.status === 'error') throw new Error('Blender: ' + (resp.message || 'unknown error'));
  return resp && 'result' in resp ? resp.result : resp;
}

function readCode(args) {
  if (args.code) return args.code;
  if (args.file === '-' ) return readFileSync(0, 'utf8');
  if (args.file) return readFileSync(args.file, 'utf8');
  if (args._.length) return args._.join(' ');
  throw new Error('provide --code "<python>", --file <path>, or - for stdin');
}

const HELP = `blender — CLI for the BlenderMCP addon + headless Blender

SOCKET MODE (needs Blender open + MCP server started, port ${PORT}):
  eval        Run python in the live session. --code STR | --file PATH | -(stdin)
  scene       get_scene_info (JSON)
  object      get_object_info  --name NAME
  screenshot  Save a viewport screenshot.  --out PATH [--max-size 800]
  raw         Any command.  --type CMD [--params JSON]
  ping        Check the socket is reachable

HEADLESS MODE (no running Blender; reproducible batch):
  headless    blender --background [--blend FILE] --python <script>
              --file PATH | --code STR  [--blend FILE] [-- passthrough args]

Env: BLENDER_BIN (default 'blender')`;

async function main() {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (sub) {
    case 'eval': {
      const r = unwrap(await send({ type: 'execute_code', params: { code: readCode(args) } }));
      // execute_code returns { executed: true, result: "<captured stdout>" }
      process.stdout.write(typeof r?.result === 'string' ? r.result : JSON.stringify(r, null, 2));
      if (!String(r?.result ?? '').endsWith('\n')) process.stdout.write('\n');
      break;
    }
    case 'scene':
      console.log(JSON.stringify(unwrap(await send({ type: 'get_scene_info', params: {} })), null, 2));
      break;
    case 'object':
      if (!args.name) throw new Error('--name required');
      console.log(JSON.stringify(unwrap(await send({ type: 'get_object_info', params: { name: args.name } })), null, 2));
      break;
    case 'screenshot': {
      if (!args.out) throw new Error('--out PATH required');
      const params = { filepath: args.out, max_size: args['max-size'] ? Number(args['max-size']) : 800, format: 'png' };
      console.log(JSON.stringify(unwrap(await send({ type: 'get_viewport_screenshot', params })), null, 2));
      break;
    }
    case 'raw': {
      const params = args.params ? JSON.parse(args.params) : {};
      console.log(JSON.stringify(await send({ type: args.type, params }), null, 2));
      break;
    }
    case 'ping': {
      try { await send({ type: 'get_scene_info', params: {} }, { timeoutMs: 4000 }); console.log('ok: BlenderMCP reachable on ' + HOST + ':' + PORT); }
      catch (e) { console.error('unreachable: ' + e.message); process.exit(1); }
      break;
    }
    case 'headless': {
      let scriptPath;
      if (args.file) scriptPath = args.file;
      else if (args.code) {
        const dir = mkdtempSync(join(tmpdir(), 'blender-cli-'));
        scriptPath = join(dir, 'job.py');
        writeFileSync(scriptPath, args.code);
      } else throw new Error('headless: provide --file PATH or --code STR');
      const cmd = ['--background'];
      if (args.blend) cmd.push(args.blend);
      cmd.push('--python', scriptPath);
      if (args.passthrough.length) cmd.push('--', ...args.passthrough);
      const res = spawnSync(BLENDER_BIN, cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (res.error) throw res.error;
      process.stdout.write(res.stdout || '');
      if (res.status !== 0) { process.stderr.write(res.stderr || ''); process.exit(res.status ?? 1); }
      break;
    }
    case '-h': case '--help': case 'help': case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`unknown subcommand: ${sub}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
