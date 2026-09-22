/**
 * Muse (Meta AI) Noise transport — clean-room implementation.
 *
 * Implements the Noise_XX_25519_AESGCM_SHA256 handshake and the framed
 * service-mux protocol used by the Muse gateway (wss://<host>/v1/noise),
 * reverse-engineered from the web client and verified live against the
 * production gateway (handshake, ping, chat.stream, chat.subscribe).
 *
 * No Meta source is reproduced here: only protocol constants, protobuf field
 * numbers, endpoint shapes, and behavior observed on the wire.
 *
 * Wire summary (all verified live 2026-09-21):
 * - Handshake: Noise XX, 25519, AES-256-GCM, SHA-256. Msg1 = 32B eph key +
 *   protobuf{1: <32B client nonce>}; msg2 = 32B eph key + AEAD(70B payload);
 *   msg3 = AEAD(msg3 payload, usually empty when msg2 carries no RV challenge).
 * - Transport frames: protobuf NoiseTransportFrame{1:chunk_id,2:chunk_index,
 *   3:total_chunks,4:payload}; payload chunks <= 65489 bytes, <= 256 chunks.
 * - Service mux: ServiceRequest{1:service,2:payload} /
 *   ServiceResponse{1:payload}; ServiceFrame{1:stream_id, 2:request |
 *   3:response | 4:body_chunk | 5:reset}.
 * - ApplicationRequest{1:verb,2:path,3:headers,4:body,5:end_body};
 *   ApplicationResponse{1:status,2:headers,3:body,4:end_body};
 *   BodyChunk{1:data,2:end_body}.
 * - Subscription records are newline-delimited JSON; a trailing unterminated
 *   record is flushed at stream end.
 */

import crypto from "node:crypto";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Noise_XX_25519_AESGCM_SHA256
// ---------------------------------------------------------------------------

const PROTOCOL_NAME = Buffer.from("Noise_XX_25519_AESGCM_SHA256");
const HASH_LEN = 32;
const MAX_HANDSHAKE_MSG = 65535;

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}
function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
// Noise HKDF: HMAC-SHA256 expansion (2 outputs for chaining-key splits).
function hkdf2(chainingKey, inputKeyMaterial) {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Buffer.from([0x01]));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  return [out1, out2];
}
// X25519 via the 1.3.101.110 (X25519) OID; raw 32-byte keys.
const X25519_OID_DER_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
function x25519KeyPair() {
  const kp = crypto.generateKeyPairSync("x25519");
  const pubDer = kp.publicKey.export({ type: "spki", format: "der" });
  const privDer = kp.privateKey.export({ type: "pkcs8", format: "der" });
  return {
    pub: pubDer.subarray(pubDer.length - 32),
    priv: privDer.subarray(privDer.length - 32),
  };
}
function x25519(privRaw, pubRaw) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([X25519_OID_DER_PREFIX, privRaw]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), pubRaw]), format: "der", type: "spki" });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}

class CipherState {
  constructor() { this.k = null; this.n = 0n; }
  initializeKey(k) { this.k = Buffer.from(k); this.n = 0n; }
  hasKey() { return this.k !== null; }
  // 12-byte nonce: 4 zero bytes || uint64 BE counter; empty AD.
  encryptWithAd(ad, pt) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.n, 4);
    this.n += 1n;
    const c = crypto.createCipheriv("aes-256-gcm", this.k, nonce, { authTagLength: 16 });
    c.setAAD(ad);
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  }
  decryptWithAd(ad, ct) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.n, 4);
    const tag = ct.subarray(ct.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", this.k, nonce, { authTagLength: 16 });
    d.setAAD(ad);
    d.setAuthTag(tag);
    const plaintext = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    this.n += 1n;
    return plaintext;
  }
}

class SymmetricState {
  constructor() {
    this.cs = new CipherState();
    // Noise initializes h to protocol_name padded to HASHLEN (not hashed).
    // Empty prologue is mixed exactly once below.
    this.h = Buffer.concat([PROTOCOL_NAME, Buffer.alloc(HASH_LEN - PROTOCOL_NAME.length)]);
    this.ck = Buffer.from(this.h);
    this.mixHash(Buffer.alloc(0));
  }
  mixHash(d) { this.h = sha256(Buffer.concat([this.h, d])); }
  mixKey(ikm) {
    const [ck, tk] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs.initializeKey(tk);
  }
  encryptAndHash(pt) {
    const ct = this.cs.hasKey() ? this.cs.encryptWithAd(this.h, pt) : Buffer.from(pt);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct) {
    const pt = this.cs.hasKey() ? this.cs.decryptWithAd(this.h, ct) : Buffer.from(ct);
    this.mixHash(ct);
    return pt;
  }
  split() {
    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    const c1 = new CipherState(); c1.initializeKey(k1);
    const c2 = new CipherState(); c2.initializeKey(k2);
    return [c1, c2];
  }
  handshakeHash() { return Buffer.from(this.h); }
}

// RV/private-auth (NoisePrivateAuthConfig) — implemented for completeness.
// Observed live sessions carry no RV challenge (empty msg3 payload), but the
// derivation below matches the client's builder exactly.
const RV_LABEL = Buffer.from("hatch.noise-auth.key.v1");
function rvSubkey(rvKey, role) {
  return hmacSha256(rvKey, Buffer.concat([RV_LABEL, Buffer.from(role)]));
}
export function expectedVmProof(rvKey, hsHashAfterMsg1, vmNonce, clientNonce) {
  return hmacSha256(
    rvSubkey(rvKey, "vm-proof-key"),
    Buffer.concat([Buffer.from("hatch.noise-auth.vm-proof.v1"), hsHashAfterMsg1, vmNonce, clientNonce]),
  );
}
export function clientProof(rvKey, hsHashAfterMsg2, vmNonce, clientNonce) {
  return hmacSha256(
    rvSubkey(rvKey, "client-proof-key"),
    Buffer.concat([Buffer.from("hatch.noise-auth.client-proof.v1"), hsHashAfterMsg2, vmNonce, clientNonce]),
  );
}
// Decode the msg2 RV challenge. Returns null when the payload is not a
// challenge (the common case: a 70B attestation blob) or not valid protobuf,
// else {state: "unprovisioned"|"provisioned", vmNonce, vmProof, attestation}.
export function decodeRvChallenge(payload) {
  let f;
  try {
    f = readFields(payload);
  } catch {
    return null;
  }
  const state = f[2]?.[0] !== undefined ? Number(readVarint(f[2][0], 0)[0]) : null;
  const vmNonce = f[3]?.[0];
  if ((state !== 1 && state !== 2) || !vmNonce || vmNonce.length !== 32) return null;
  return {
    state: state === 1 ? "unprovisioned" : "provisioned",
    attestation: f[1]?.[0] || Buffer.alloc(0),
    vmNonce,
    vmProof: f[4]?.[0] || Buffer.alloc(0),
  };
}
// Encode the msg3 private-auth payload.
export function encodeMsg3Payload({ notaryToken, freshRvKey = null, proof = null }) {
  const w = new Writer();
  if (notaryToken) w.string(1, notaryToken);
  if (freshRvKey) w.bytes(2, freshRvKey);
  else if (proof) w.bytes(3, proof);
  return w.finish();
}

export class NoiseXXInitiator {
  constructor() {
    this.ss = new SymmetricState();
    this.e = x25519KeyPair();
    this.s = x25519KeyPair();
    this.re = null;
    this.rs = null;
    this.clientNonce = crypto.randomBytes(32);
  }
  // -> 66 bytes: 32B eph pubkey || protobuf{1: clientNonce}
  writeMessage1() {
    const w = new Writer();
    w.bytes(1, this.clientNonce);
    const nonceMsg = w.finish();
    this.ss.mixHash(this.e.pub);
    this.ss.mixHash(nonceMsg);
    return Buffer.concat([this.e.pub, nonceMsg]);
  }
  // <- msg2: e || Encrypt(s) || Encrypt(payload), with ee/es DH tokens.
  // Returns {payload, handshakeHash, remoteStatic} after the full message.
  readMessage2(msg) {
    if (msg.length > MAX_HANDSHAKE_MSG) throw new Error("handshake message too large");
    if (msg.length < 32 + 48 + 16) throw new Error("handshake message too short");
    const re = msg.subarray(0, 32);
    this.ss.mixHash(re);
    this.ss.mixKey(x25519(this.e.priv, re)); // ee
    this.re = re;
    this.rs = this.ss.decryptAndHash(msg.subarray(32, 32 + 48));
    if (this.rs.length !== 32) throw new Error("invalid responder static key");
    this.ss.mixKey(x25519(this.e.priv, this.rs)); // es
    const payload = this.ss.decryptAndHash(msg.subarray(32 + 48));
    const handshakeHash = this.ss.handshakeHash();
    return { payload, handshakeHash, remoteEph: re, remoteStatic: this.rs };
  }
  // -> msg3: Encrypt(s) || Encrypt(payload), with se DH token.
  writeMessage3(payloadBytes) {
    if (!this.rs) throw new Error("responder static key unavailable");
    const encryptedStatic = this.ss.encryptAndHash(this.s.pub);
    this.ss.mixKey(x25519(this.s.priv, this.re)); // se
    const encryptedPayload = this.ss.encryptAndHash(payloadBytes);
    const [k1, k2] = this.ss.split();
    return { bytes: Buffer.concat([encryptedStatic, encryptedPayload]), sendCipher: k1, recvCipher: k2 };
  }
}

// ---------------------------------------------------------------------------
// Minimal protobuf codec (varint / 64-bit / length-delimited only)
// ---------------------------------------------------------------------------

export class Writer {
  constructor() { this.parts = []; }
  tag(field, wire) { this.uint32((field << 3) | wire); return this; }
  uint32(v) {
    v >>>= 0;
    const b = [];
    do { let x = v & 0x7f; v >>>= 7; b.push(v ? x | 0x80 : x); } while (v);
    this.parts.push(Buffer.from(b));
    return this;
  }
  int32(v) { return this.uint32(v >>> 0); }
  uint64(v) {
    let x = BigInt(v);
    const b = [];
    do { let byte = Number(x & 0x7fn); x >>= 7n; b.push(x ? byte | 0x80 : byte); } while (x);
    this.parts.push(Buffer.from(b));
    return this;
  }
  bool(v) { return this.uint32(v ? 1 : 0); }
  bytes(field, buf) {
    this.tag(field, 2);
    this.uint32(buf.length);
    this.parts.push(Buffer.from(buf));
    return this;
  }
  string(field, s) { return this.bytes(field, Buffer.from(s, "utf8")); }
  message(field, buf) { return this.bytes(field, buf); }
  finish() { return Buffer.concat(this.parts); }
}

export function readVarint(buf, off) {
  let v = 0n, shift = 0n, i = off;
  for (;;) {
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [v, i];
}
// -> {fieldNo: [value,...]} where value is a Buffer holding the raw field
// encoding (varint bytes for wire 0, payload bytes for wire 2). Callers
// decode varints with readVarint(v[0], 0)[0].
export function readFields(buf) {
  const f = {};
  let off = 0;
  while (off < buf.length) {
    const [tag, o1] = readVarint(buf, off); off = o1;
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) {
      const start = off;
      const [, o2] = readVarint(buf, off); off = o2;
      (f[field] ||= []).push(buf.subarray(start, o2));
    }
    else if (wire === 1) { off += 8; }
    else if (wire === 2) {
      const [len, o2] = readVarint(buf, off); off = o2;
      const b = buf.subarray(off, off + Number(len)); off += Number(len);
      (f[field] ||= []).push(b);
    } else if (wire === 5) { off += 4; }
    else throw new Error("unsupported wire type " + wire);
  }
  return f;
}

// --- frame codecs ---
export const ServiceType = { DAEMON: 0, SENTINEL: 1, VAULT: 2, AUTHD: 3 };

export function encNoiseTransportFrame(chunkId, chunkIndex, totalChunks, payload) {
  const w = new Writer();
  w.tag(1, 0).uint64(chunkId);
  w.tag(2, 0).uint32(chunkIndex);
  w.tag(3, 0).uint32(totalChunks);
  if (payload.length) w.bytes(4, payload);
  return w.finish();
}
export function decNoiseTransportFrame(buf) {
  const f = readFields(buf);
  const asU64 = (b) => BigInt.asUintN(64, readVarint(b, 0)[0]);
  const asU32 = (b) => Number(readVarint(b, 0)[0]);
  return {
    chunkId: f[1] ? asU64(f[1][0]) : 0n,
    chunkIndex: f[2] ? asU32(f[2][0]) : 0,
    totalChunks: f[3] ? asU32(f[3][0]) : 0,
    payload: f[4] ? f[4][0] : Buffer.alloc(0),
  };
}
export function encServiceRequest(service, payload) {
  return new Writer().tag(1, 0).int32(service).bytes(2, payload).finish();
}
export function decServiceResponse(buf) {
  const f = readFields(buf);
  return { payload: f[1]?.[0] || Buffer.alloc(0) };
}
export function encServiceFrame(streamId, kind, payload) {
  const w = new Writer();
  w.tag(1, 0).uint64(streamId);
  const field = { request: 2, response: 3, bodyChunk: 4, reset: 5 }[kind];
  w.message(field, payload);
  return w.finish();
}
export function decServiceFrame(buf) {
  const f = readFields(buf);
  const kinds = { 2: "request", 3: "response", 4: "bodyChunk", 5: "reset" };
  for (const [fn, k] of Object.entries(kinds)) {
    if (f[fn]) return { streamId: BigInt(readVarint(f[1][0], 0)[0]), kind: k, payload: f[fn][0] };
  }
  throw new Error("unknown service frame kind");
}
export function encApplicationRequest(verb, path, headers, body) {
  const w = new Writer();
  w.string(1, verb).string(2, path);
  for (const h of headers) {
    const hw = new Writer();
    hw.string(1, h.key).string(2, h.value);
    w.message(3, hw.finish());
  }
  if (body?.length) w.bytes(4, body);
  w.tag(5, 0).bool(true);
  return w.finish();
}
export function decApplicationResponse(buf) {
  const f = readFields(buf);
  const headers = (f[2] || []).map((b) => {
    const hf = readFields(b);
    return { key: hf[1]?.[0]?.toString() || "", value: hf[2]?.[0]?.toString() || "" };
  });
  return {
    status: f[1] ? Number(BigInt.asIntN(32, readVarint(f[1][0], 0)[0])) : 0,
    headers,
    body: f[3]?.[0] || Buffer.alloc(0),
    endBody: f[4] ? readVarint(f[4][0], 0)[0] === 1n : false,
  };
}
export function decBodyChunk(buf) {
  const f = readFields(buf);
  return { data: f[1]?.[0] || Buffer.alloc(0), endBody: f[2] ? readVarint(f[2][0], 0)[0] === 1n : false };
}

// ---------------------------------------------------------------------------
// HatchNoiseClient — WebSocket + Noise + service mux + HTTP-over-daemon
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_CHUNK = 65489;
const MAX_CHUNKS = 256;
const MAX_REASSEMBLY_BYTES = MAX_PAYLOAD_CHUNK * MAX_CHUNKS;

function randomChunkId() {
  const a = crypto.randomBytes(4).readUInt32BE(0);
  const b = crypto.randomBytes(4).readUInt32BE(0);
  return (BigInt(a) << 32n) | BigInt(b);
}

export class HatchNoiseClient {
  constructor() {
    this.ws = null;
    this.sendCipher = null;
    this.recvCipher = null;
    this.nextStreamId = 1n;
    this.pending = new Map(); // streamId -> entry
    this.reassembly = new Map(); // chunkId -> {total, parts[]}
    this.onClose = null;
    this.wsErrorHandler = null;
  }

  buildUrl({ gatewayHost, vmId, authToken, notaryToken, appId, requestId }) {
    const q = new URLSearchParams({
      vm_id: vmId,
      auth_token: authToken,
      app_id: appId || "hatch-web",
      request_id: requestId || crypto.randomUUID(),
    });
    if (notaryToken) q.set("notary_token", notaryToken);
    return `wss://${gatewayHost}/v1/noise?${q.toString()}`;
  }

  /**
   * Connect + Noise XX handshake. opts: {gatewayHost, vmId, authToken,
   * notaryToken?, appId?, requestId?, origin?, proxyAgent?, rv?}
   * rv: {notaryToken, rvKey} when the server presents an RV challenge.
   * Resolves with the msg2 payload (attestation bytes or challenge).
   */
  async connect(opts) {
    const url = this.buildUrl(opts);
    const wsOpts = { origin: opts.origin || "https://muse.ai" };
    if (opts.proxyAgent) wsOpts.agent = opts.proxyAgent;
    const ws = new WebSocket(url, wsOpts);
    this.ws = ws;
    const persistentErrorHandler = (error) => this._failPending(error);
    this.wsErrorHandler = persistentErrorHandler;
    ws.on("error", persistentErrorHandler);
    await new Promise((resolve, reject) => {
      let settled = false;
      let abortHandler;
      const timer = setTimeout(() => settle(new Error("websocket open timeout")), 20000);
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
        if (opts.signal && abortHandler) opts.signal.removeEventListener("abort", abortHandler);
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          try { ws.terminate(); } catch { try { ws.close(); } catch { /* ignore */ } }
          reject(error);
        } else resolve();
      };
      const onOpen = () => settle();
      const onError = (error) => settle(error);
      abortHandler = () => settle(new Error("aborted"));
      ws.once("open", onOpen);
      ws.once("error", onError);
      if (opts.signal?.aborted) abortHandler();
      else opts.signal?.addEventListener("abort", abortHandler, { once: true });
    });
    ws.on("message", (data) => this._onWsMessage(Buffer.from(data)));
    ws.on("close", () => {
      this._failPending(new Error("Muse gateway connection closed"));
      this.onClose?.();
    });

    try {
      const hs = new NoiseXXInitiator();
      ws.send(hs.writeMessage1());
      const msg2 = await this._nextBinary(30000, opts.signal);
      const { payload, handshakeHash } = hs.readMessage2(msg2);

      let msg3Payload = Buffer.alloc(0);
      const challenge = decodeRvChallenge(payload);
      if (challenge && opts.rv) {
        if (challenge.state === "unprovisioned") {
          msg3Payload = encodeMsg3Payload({ notaryToken: opts.rv.notaryToken, freshRvKey: opts.rv.rvKey });
        } else {
          const expect = expectedVmProof(opts.rv.rvKey, hs.ss.handshakeHash(), challenge.vmNonce, hs.clientNonce);
          if (!crypto.timingSafeEqual(expect, challenge.vmProof)) throw new Error("vm proof mismatch (cvm_key_rejected)");
          const proof = clientProof(opts.rv.rvKey, handshakeHash, challenge.vmNonce, hs.clientNonce);
          msg3Payload = encodeMsg3Payload({ notaryToken: opts.rv.notaryToken, proof });
        }
      }
      const m3 = hs.writeMessage3(msg3Payload);
      this.sendCipher = m3.sendCipher;
      this.recvCipher = m3.recvCipher;
      ws.send(m3.bytes);
      return payload;
    } catch (error) {
      this._failPending(error);
      this.close();
      throw error;
    }
  }

  _nextBinary(timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.ws;
      let abortHandler;
      const timer = setTimeout(() => settle(new Error("handshake timeout")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ws?.off("message", onMessage);
        ws?.off("error", onError);
        ws?.off("close", onClose);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      };
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = (data) => settle(null, Buffer.from(data));
      const onError = (error) => settle(error);
      const onClose = () => settle(new Error("Muse gateway connection closed during handshake"));
      abortHandler = () => settle(new Error("aborted"));
      ws?.on("message", onMessage);
      ws?.once("error", onError);
      ws?.once("close", onClose);
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  _cleanupEntry(entry, streamId) {
    if (entry.done) return false;
    entry.done = true;
    this.pending.delete(streamId.toString());
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener("abort", entry.abortHandler);
    }
    return true;
  }

  _fail(entry, streamId, error) {
    if (!this._cleanupEntry(entry, streamId)) return;
    try { entry.onError?.(error); } catch { /* ignore callback errors */ }
  }

  _failPending(error) {
    for (const [streamId, entry] of this.pending) {
      this._fail(entry, BigInt(streamId), error);
    }
    this.reassembly.clear();
  }

  _onWsMessage(data) {
    if (!this.recvCipher) return; // handshake not complete: _nextBinary owns these
    try {
      const pt = this.recvCipher.decryptWithAd(Buffer.alloc(0), data);
      this._onTransportFrame(pt);
    } catch (error) {
      this._failPending(new Error(`Muse gateway protocol error: ${error.message}`));
    }
  }

  _onTransportFrame(frameBytes) {
    try {
      const fr = decNoiseTransportFrame(frameBytes);
      if (fr.totalChunks < 1 || fr.totalChunks > MAX_CHUNKS || fr.payload.length > MAX_PAYLOAD_CHUNK) {
        throw new Error("invalid transport frame bounds");
      }
      const key = fr.chunkId.toString();
      let asm = this.reassembly.get(key);
      if (!asm) {
        if (this.reassembly.size >= 64) throw new Error("too many incomplete transport frames");
        asm = { total: fr.totalChunks, parts: new Array(fr.totalChunks).fill(null), got: 0, bytes: 0 };
        this.reassembly.set(key, asm);
      } else if (fr.totalChunks !== asm.total) {
        throw new Error("conflicting transport frame chunk count");
      }
      if (fr.chunkIndex >= asm.total) throw new Error("invalid transport frame chunk index");
      if (!asm.parts[fr.chunkIndex]) {
        if (asm.bytes + fr.payload.length > MAX_REASSEMBLY_BYTES) {
          throw new Error("transport frame reassembly too large");
        }
        asm.parts[fr.chunkIndex] = fr.payload;
        asm.got++;
        asm.bytes += fr.payload.length;
      }
      if (asm.got === asm.total) {
        this.reassembly.delete(key);
        this._onServicePayload(Buffer.concat(asm.parts));
      }
    } catch (error) {
      this._failPending(new Error(`Muse gateway protocol error: ${error.message}`));
    }
  }

  _onServicePayload(payload) {
    const svc = decServiceResponse(payload);
    const frame = decServiceFrame(svc.payload);
    const entry = this.pending.get(frame.streamId.toString());
    if (!entry) return;
    if (frame.kind === "response") {
      const r = decApplicationResponse(frame.payload);
      if (r.status < 200 || r.status >= 300) {
        const error = new Error(`Muse gateway HTTP ${r.status}`);
        error.status = r.status;
        this._fail(entry, frame.streamId, error);
        return;
      }
      entry.onResponse?.(r);
      if (r.body.length) this._feedText(entry, r.body, r.endBody);
      if (r.endBody) this._finish(entry, frame.streamId);
    } else if (frame.kind === "bodyChunk") {
      const bc = decBodyChunk(frame.payload);
      if (bc.data.length || bc.endBody) this._feedText(entry, bc.data, bc.endBody);
      if (bc.endBody && !entry.done) this._finish(entry, frame.streamId);
    } else if (frame.kind === "reset") {
      this._fail(entry, frame.streamId, new Error("stream reset by server"));
    }
  }

  _feedText(entry, bytes, endBody) {
    entry.textBuf += entry.decoder.decode(bytes, { stream: !endBody });
    const lines = entry.textBuf.split("\n");
    entry.textBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { entry.onRecord?.(JSON.parse(t)); }
      catch { entry.onRecord?.({ _raw: t }); }
    }
    if (endBody) {
      entry.textBuf += entry.decoder.decode();
      if (entry.textBuf.trim()) {
        try { entry.onRecord?.(JSON.parse(entry.textBuf)); }
        catch { entry.onRecord?.({ _raw: entry.textBuf }); }
      }
      entry.textBuf = "";
    }
  }

  _finish(entry, streamId) {
    if (!this._cleanupEntry(entry, streamId)) return;
    try { entry.onDone?.(); } catch { /* ignore callback errors */ }
  }

  _sendServiceFrame(streamId, kind, payload) {
    const frame = encServiceFrame(streamId, kind, payload);
    const chunks = [];
    for (let i = 0; i < frame.length; i += MAX_PAYLOAD_CHUNK) chunks.push(frame.subarray(i, i + MAX_PAYLOAD_CHUNK));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    if (chunks.length > MAX_CHUNKS) throw new Error("frame too large");
    const chunkId = randomChunkId();
    for (let i = 0; i < chunks.length; i++) {
      const tf = encNoiseTransportFrame(chunkId, i, chunks.length, chunks[i]);
      this.ws.send(this.sendCipher.encryptWithAd(Buffer.alloc(0), tf));
    }
  }

  /**
   * Send an HTTP-like request over the daemon service.
   * opts: {method, httpMethod, path, body?, service?, headers?, onResponse?,
   *        onRecord?, onError?, onDone?, signal?}
   */
  sendHttpRequest(opts) {
    const streamId = this.nextStreamId++;
    const entry = {
      textBuf: "",
      decoder: new TextDecoder(),
      done: false,
      signal: opts.signal,
      abortHandler: null,
      onResponse: opts.onResponse,
      onRecord: opts.onRecord,
      onError: opts.onError,
      onDone: opts.onDone,
    };
    this.pending.set(streamId.toString(), entry);
    entry.abortHandler = () => {
      try { if (this.ws && this.sendCipher) this._sendServiceFrame(streamId, "reset", Buffer.alloc(0)); } catch { /* ignore reset failures */ }
      this._fail(entry, streamId, new Error("aborted"));
    };
    if (opts.signal?.aborted) {
      entry.abortHandler();
      return streamId;
    }
    if (opts.signal) opts.signal.addEventListener("abort", entry.abortHandler, { once: true });
    const body = opts.body ? Buffer.from(opts.body, "utf8") : Buffer.alloc(0);
    const req = encApplicationRequest(
      opts.httpMethod || "POST",
      opts.path,
      Object.entries(opts.headers || {}).map(([key, value]) => ({ key, value: String(value) })),
      body,
    );
    const svcReq = encServiceRequest(opts.service ?? ServiceType.DAEMON, req);
    try {
      if (!entry.done) this._sendServiceFrame(streamId, "request", svcReq);
    } catch (error) {
      this._fail(entry, streamId, error);
      throw error;
    }
    return streamId;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this._failPending(new Error("Muse gateway connection closed"));
    try { ws?.close(); } catch { /* ignore */ }
  }
}
