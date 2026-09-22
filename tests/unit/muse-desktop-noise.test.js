/**
 * Unit tests for the Muse Noise transport (open-sse/shared/museNoise.js).
 * Loopback Noise XX handshake, protobuf roundtrips, RV challenge handling.
 * No network, no credentials.
 */
import { describe, it, expect } from "vitest";
import {
  NoiseXXInitiator,
  HatchNoiseClient,
  decodeRvChallenge,
  encodeMsg3Payload,
  expectedVmProof,
  clientProof,
  Writer,
  readFields,
  readVarint,
  encNoiseTransportFrame,
  decNoiseTransportFrame,
  encServiceFrame,
  decServiceFrame,
  encApplicationRequest,
  decApplicationResponse,
  decBodyChunk,
  encServiceRequest,
  decServiceResponse,
  ServiceType,
} from "../../open-sse/shared/museNoise.js";
import crypto from "node:crypto";

// Minimal XX responder (empty static keys) mirroring the initiator.
function x25519Gen() {
  const kp = crypto.generateKeyPairSync("x25519");
  const pubDer = kp.publicKey.export({ type: "spki", format: "der" });
  const privDer = kp.privateKey.export({ type: "pkcs8", format: "der" });
  return { pub: pubDer.subarray(pubDer.length - 32), priv: privDer.subarray(privDer.length - 32) };
}
function x25519Dh(priv, pub) {
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), priv]),
      format: "der", type: "pkcs8",
    }),
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), pub]),
      format: "der", type: "spki",
    }),
  });
}
function hkdfCk(ck, ikm) {
  const tk = crypto.createHmac("sha256", ck).update(ikm).digest();
  const o1 = crypto.createHmac("sha256", tk).update(Buffer.from([1])).digest();
  const o2 = crypto.createHmac("sha256", tk).update(Buffer.concat([o1, Buffer.from([2])])).digest();
  return [o1, o2];
}
function makeResponder() {
  const init = new NoiseXXInitiator();
  const ss = init.ss;
  const eph = x25519Gen();
  const stat = x25519Gen();
  return {
    readMessage1(msg) {
      const re = msg.subarray(0, 32);
      ss.mixHash(re);
      ss.mixHash(msg.subarray(32));
      this.re = re;
    },
    writeMessage2(payload) {
      ss.mixHash(eph.pub);
      let [ck, tk] = hkdfCk(ss.ck, x25519Dh(eph.priv, this.re)); // ee
      ss.ck = ck;
      ss.cs.initializeKey(tk);
      const encryptedStatic = ss.encryptAndHash(stat.pub);
      [ck, tk] = hkdfCk(ss.ck, x25519Dh(stat.priv, this.re)); // es
      ss.ck = ck;
      ss.cs.initializeKey(tk);
      const encryptedPayload = ss.encryptAndHash(payload);
      return {
        bytes: Buffer.concat([eph.pub, encryptedStatic, encryptedPayload]),
        sendK: null,
        recvK: null,
        ss,
        readMessage3: (msg) => {
          const initiatorStatic = ss.decryptAndHash(msg.subarray(0, 48));
          if (initiatorStatic.length !== 32) throw new Error("invalid initiator static key");
          [ck, tk] = hkdfCk(ss.ck, x25519Dh(eph.priv, initiatorStatic)); // se
          ss.ck = ck;
          ss.cs.initializeKey(tk);
          const gotPayload = ss.decryptAndHash(msg.subarray(48));
          const [k1, k2] = hkdfCk(ss.ck, Buffer.alloc(0));
          return { payload: gotPayload, sendK: k2, recvK: k1 };
        },
      };
    },
  };
}

describe("muse Noise XX handshake (loopback)", () => {
  it("initializes Noise state from the padded protocol name", () => {
    const init = new NoiseXXInitiator();
    expect(init.ss.ck.toString("hex")).toBe(
      "4e6f6973655f58585f32353531395f41455347434d5f53484132353600000000",
    );
    expect(init.ss.h.toString("hex")).toBe(
      "5df72b67b965add1168f0a6c756df21c204f7e64fc682be6a3ab4b682c8db64b",
    );
  });

  it("completes with matching transport keys", () => {
    const init = new NoiseXXInitiator();
    const rsp = makeResponder();
    const m1 = init.writeMessage1();
    expect(m1.length).toBe(66); // 32B key + protobuf{1:<32B nonce>}
    rsp.readMessage1(m1);
    const payload = crypto.randomBytes(70);
    const m2 = rsp.writeMessage2(payload);
    expect(m2.bytes.length).toBe(166); // 32B e + 48B Encrypt(s) + 86B Encrypt(payload)
    const { payload: got, handshakeHash } = init.readMessage2(m2.bytes);
    expect(got).toEqual(payload);
    const m3 = init.writeMessage3(Buffer.alloc(0));
    expect(m3.bytes.length).toBe(64); // 48B Encrypt(s) + 16B Encrypt(empty payload)
    const responder = m2.readMessage3(m3.bytes);
    expect(responder.payload).toEqual(Buffer.alloc(0));
    expect(m3.sendCipher.k).toEqual(responder.recvK);
    expect(m3.recvCipher.k).toEqual(responder.sendK);
    expect(handshakeHash.length).toBe(32);
  });
});

describe("muse protobuf framing", () => {
  it("round-trips NoiseTransportFrame", () => {
    const enc = encNoiseTransportFrame(123456789n, 2, 5, Buffer.from("hello"));
    const dec = decNoiseTransportFrame(enc);
    expect(dec.chunkId).toBe(123456789n);
    expect(dec.chunkIndex).toBe(2);
    expect(dec.totalChunks).toBe(5);
    expect(dec.payload.toString()).toBe("hello");
  });

  it("round-trips ServiceFrame request/response/bodyChunk", () => {
    for (const kind of ["request", "response", "bodyChunk"]) {
      const enc = encServiceFrame(7n, kind, Buffer.from("x"));
      const dec = decServiceFrame(enc);
      expect(dec.kind).toBe(kind);
      expect(dec.streamId).toBe(7n);
      expect(dec.payload.toString()).toBe("x");
    }
  });

  it("round-trips ApplicationRequest/Response", () => {
    const req = encApplicationRequest("POST", "/chat/stream",
      [{ key: "x-app-id", value: "hatch-web" }], Buffer.from("{}"));
    const f = readFields(req);
    expect(f[1][0].toString()).toBe("POST");
    expect(f[2][0].toString()).toBe("/chat/stream");

    const resp = new Writer().tag(1, 0).int32(200)
      .message(2, new Writer().string(1, "content-type").string(2, "application/json").finish())
      .bytes(3, Buffer.from('{"ok":true}')).tag(4, 0).bool(true).finish();
    const dec = decApplicationResponse(resp);
    expect(dec.status).toBe(200);
    expect(dec.headers).toEqual([{ key: "content-type", value: "application/json" }]);
    expect(dec.body.toString()).toBe('{"ok":true}');
    expect(dec.endBody).toBe(true);
  });

  it("round-trips ServiceRequest + BodyChunk", () => {
    const sr = encServiceRequest(ServiceType.DAEMON, Buffer.from("inner"));
    const srf = readFields(sr);
    expect(Number(readVarint(srf[1][0], 0)[0])).toBe(ServiceType.DAEMON);
    expect(srf[2][0].toString()).toBe("inner");
    // ServiceResponse{1: payload}
    const resp = new Writer().bytes(1, Buffer.from("out")).finish();
    expect(decServiceResponse(resp).payload.toString()).toBe("out");
    const bc = new Writer().bytes(1, Buffer.from("data")).tag(2, 0).bool(true).finish();
    const dec = decBodyChunk(bc);
    expect(dec.data.toString()).toBe("data");
    expect(dec.endBody).toBe(true);
  });
});

describe("muse transport regressions", () => {
  it("round-trips high-bit unsigned chunk IDs", () => {
    const id = 0xfedcba9876543210n;
    expect(decNoiseTransportFrame(encNoiseTransportFrame(id, 0, 1, Buffer.alloc(0))).chunkId).toBe(id);
  });

  it("does not advance the receive nonce after authentication failure", () => {
    const key = crypto.randomBytes(32);
    const sender = new NoiseXXInitiator().ss.cs;
    const receiver = new NoiseXXInitiator().ss.cs;
    sender.initializeKey(key);
    receiver.initializeKey(key);
    const ciphertext = sender.encryptWithAd(Buffer.from("ad"), Buffer.from("ok"));
    const bad = Buffer.from(ciphertext);
    bad[0] ^= 1;
    expect(() => receiver.decryptWithAd(Buffer.from("ad"), bad)).toThrow();
    expect(receiver.n).toBe(0n);
    expect(receiver.decryptWithAd(Buffer.from("ad"), ciphertext).toString()).toBe("ok");
    expect(receiver.n).toBe(1n);
  });

  it("rejects non-2xx application responses before delivering records", () => {
    const client = new HatchNoiseClient();
    const errors = [];
    const responses = [];
    const records = [];
    client.pending.set("1", {
      textBuf: "", done: false,
      onResponse: (response) => responses.push(response),
      onError: (error) => errors.push(error),
      onRecord: (record) => records.push(record),
    });
    const response = new Writer()
      .tag(1, 0).int32(429)
      .bytes(3, Buffer.from('{"error":"rate limited"}'))
      .tag(4, 0).bool(true)
      .finish();
    const service = new Writer().bytes(1, encServiceFrame(1n, "response", response)).finish();
    client._onServicePayload(service);
    expect(client.pending.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(429);
    expect(errors[0].message).toContain("429");
    expect(records).toEqual([]);
  });

  it("rejects pending requests when the gateway closes", () => {
    const errors = [];
    const client = new HatchNoiseClient();
    client.ws = { close: () => {} };
    client.pending.set("1", { textBuf: "", done: false, onError: (error) => errors.push(error) });
    client.close();
    expect(client.pending.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("connection closed");
  });

  it("rejects pre-aborted requests without sending a frame", () => {
    const controller = new AbortController();
    controller.abort();
    const errors = [];
    const client = new HatchNoiseClient();
    client.sendHttpRequest({
      path: "/chat/stream", signal: controller.signal,
      onError: (error) => errors.push(error),
    });
    expect(client.pending.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("aborted");
  });

  it("preserves UTF-8 characters split across body chunks", () => {
    const records = [];
    const client = new HatchNoiseClient();
    const entry = { textBuf: "", decoder: new TextDecoder(), onRecord: (record) => records.push(record) };
    const bytes = Buffer.from('{"text":"é"}');
    client._feedText(entry, bytes.subarray(0, bytes.length - 2), false);
    client._feedText(entry, bytes.subarray(bytes.length - 2), true);
    expect(records).toEqual([{ text: "é" }]);
  });

  it("rejects conflicting reassembly metadata", () => {
    const errors = [];
    const client = new HatchNoiseClient();
    client.pending.set("1", { textBuf: "", done: false, onError: (error) => errors.push(error) });
    client._onTransportFrame(encNoiseTransportFrame(9n, 0, 2, Buffer.from("a")));
    client._onTransportFrame(encNoiseTransportFrame(9n, 1, 3, Buffer.from("b")));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("protocol error");
    expect(client.pending.size).toBe(0);
  });
});

describe("muse RV challenge", () => {
  it("returns null for the standard attestation payload", () => {
    expect(decodeRvChallenge(crypto.randomBytes(70))).toBeNull();
    expect(decodeRvChallenge(Buffer.alloc(0))).toBeNull();
  });

  it("parses a synthetic provisioned challenge and verifies proofs", () => {
    const rvKey = crypto.randomBytes(32);
    const vmNonce = crypto.randomBytes(32);
    const clientNonce = crypto.randomBytes(32);
    const hs1 = crypto.randomBytes(32);
    const hs2 = crypto.randomBytes(32);
    const vmProof = expectedVmProof(rvKey, hs1, vmNonce, clientNonce);
    const chal = new Writer()
      .bytes(1, Buffer.from("att"))
      .tag(2, 0).int32(2)
      .bytes(3, vmNonce)
      .bytes(4, vmProof)
      .finish();
    const dec = decodeRvChallenge(chal);
    expect(dec.state).toBe("provisioned");
    expect(dec.vmNonce).toEqual(vmNonce);
    expect(dec.vmProof).toEqual(vmProof);
    // client proof derives with the post-msg2 handshake hash
    const proof = clientProof(rvKey, hs2, vmNonce, clientNonce);
    expect(proof.length).toBe(32);
    const msg3 = encodeMsg3Payload({ notaryToken: "tok", proof });
    const f = readFields(msg3);
    expect(f[1][0].toString()).toBe("tok");
    expect(f[3][0]).toEqual(proof);
    expect(f[2]).toBeUndefined();
  });

  it("encodes the unprovisioned fresh-key payload", () => {
    const rvKey = crypto.randomBytes(32);
    const msg3 = encodeMsg3Payload({ notaryToken: "tok", freshRvKey: rvKey });
    const f = readFields(msg3);
    expect(f[2][0]).toEqual(rvKey);
    expect(f[3]).toBeUndefined();
  });
});
