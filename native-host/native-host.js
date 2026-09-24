#!/usr/bin/env node
/**
 * @file CaptureDesk native messaging host (capturedesk-native-host).
 *
 * A tiny Chrome/Chromium native-messaging host that receives recording bytes
 * from the CaptureDesk extension and writes them straight to the local
 * CaptureDesk Recordings folder, skipping the browser Downloads pipeline.
 *
 * Protocol (each message is a JSON body length-prefixed with a 32-bit native
 * byte order integer, as required by Chrome native messaging):
 *   → { "type": "ping" }                       → { "type": "pong", ... }
 *   → { "type": "begin", "fileName", "size" }  → { "type": "begin-ok", "path" }
 *   → { "type": "chunk", "data": <base64> }    → { "type": "chunk-ok", "written" }
 *   → { "type": "end" }                        → { "type": "end-ok", "path", "size" }
 *   → { "type": "abort" }                      → { "type": "abort-ok" }
 *
 * Requires Node.js 18+. Register with install-windows.bat / install-linux.sh.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Preferred output root: env override or <Videos>/CaptureDesk. */
const preferred = process.env.CAPTUREDESK_HOME
  || path.join(os.homedir(), 'Videos', 'CaptureDesk');

/** Fallback when the preferred root cannot be created. */
const fallback = path.join(os.homedir(), 'CaptureDesk');

/**
 * Resolve the directory a file should land in (creating it when possible).
 * @returns {string} Writable directory path.
 */
function resolveDir() {
  for (const dir of [preferred, fallback]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {
      // Try the next candidate.
    }
  }
  return os.tmpdir();
}

let state = null; // { fileName, stream, written, dir }

/** Send one JSON message back to the extension. */
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(head);
  process.stdout.write(body);
}

/** Sanitize a file name to a single safe path segment. */
function safeName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[\s.]+/, '')
    .trim();
  return clean || `CaptureDesk_${Date.now()}.webm`;
}

/** Handle one decoded message. */
function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    send({ type: 'error', error: 'Malformed message.' });
    return;
  }
  switch (msg.type) {
    case 'ping': {
      send({
        type: 'pong',
        host: 'capturedesk-native-host',
        version: '1.0.0',
        dir: preferred,
      });
      break;
    }
    case 'begin': {
      try {
        if (state && state.stream) {
          try {
            state.stream.end();
          } catch (_) {
            // Closing a stale stream.
          }
        }
        const dir = resolveDir();
        const fileName = safeName(msg.fileName);
        const target = path.join(dir, fileName);
        state = { fileName, stream: fs.createWriteStream(target), written: 0, dir };
        send({ type: 'begin-ok', path: target });
      } catch (err) {
        state = null;
        send({ type: 'error', error: err.message });
      }
      break;
    }
    case 'chunk': {
      if (!state || !state.stream) {
        send({ type: 'error', error: 'No active transfer. Send "begin" first.' });
        return;
      }
      const buf = Buffer.from(String(msg.data || ''), 'base64');
      state.stream.write(buf);
      state.written += buf.length;
      send({ type: 'chunk-ok', written: state.written });
      break;
    }
    case 'end': {
      if (!state || !state.stream) {
        send({ type: 'error', error: 'No active transfer.' });
        return;
      }
      const st = state;
      const done = { path: path.join(st.dir, st.fileName), size: st.written };
      st.stream.end(() => {
        send({ type: 'end-ok', path: done.path, size: done.size });
        if (state === st) state = null;
        done.ok = true;
      });
      // Remember the finished transfer so process shutdown waits for it.
      state.finishing = done;
      break;
    }
    case 'abort': {
      if (state && state.stream) {
        const p = path.join(state.dir, state.fileName);
        state.stream.end(() => {
          try {
            fs.unlinkSync(p);
          } catch (_) {
            // Best effort cleanup.
          }
        });
      }
      state = null;
      send({ type: 'abort-ok' });
      break;
    }
    default:
      send({ type: 'error', error: `Unknown type: ${msg.type}` });
  }
}

// ---- native messaging read loop -------------------------------------------

let pending = null;
let stdinBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  for (;;) {
    if (!pending) {
      if (stdinBuffer.length < 4) return;
      const len = stdinBuffer.readUInt32LE(0);
      if (len <= 0 || len > 64 * 1024 * 1024) {
        send({ type: 'error', error: 'Invalid frame length.' });
        process.exit(1);
      }
      pending = len;
      stdinBuffer = stdinBuffer.slice(4);
    }
    if (stdinBuffer.length < pending) return;
    const body = stdinBuffer.slice(0, pending);
    stdinBuffer = stdinBuffer.slice(pending);
    pending = null;
    try {
      handleMessage(JSON.parse(body.toString('utf8')));
    } catch (err) {
      send({ type: 'error', error: err.message });
    }
  }
});

process.stdin.on('end', () => {
  /** Exit after any in-flight stream flush (worst case 2s guard). */
  const finish = () => process.exit(0);
  if (state && state.stream && !state.finishing) {
    // Browser vanished mid-transfer: finalize partial data so it survives.
    const st = state;
    st.stream.end(finish);
    state = null;
  } else if (state && state.finishing && !state.finishing.ok) {
    setTimeout(finish, 2000);
  } else {
    // Allow a just-queued end-ok frame to flush to the pipe.
    setTimeout(finish, 50);
  }
});

process.on('SIGTERM', () => process.exit(0));
