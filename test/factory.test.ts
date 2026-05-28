import assert from "node:assert/strict";
import test from "node:test";

import { WrtcHandler } from "../src/index.ts";

const VALID_OFFER_SDP = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
a=msid-semantic: WMS *
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=mid:0
a=sendrecv
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtcp-mux
a=rtcp-rsize
a=ice-ufrag:test
a=ice-pwd:testpassword
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff
a=setup:actpass
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=mid:1
a=sendrecv
a=rtpmap:96 VP8/90000
a=rtcp-mux
a=rtcp-rsize
a=ice-ufrag:test
a=ice-pwd:testpassword
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff
a=setup:actpass
`;

class MockRTCPeerConnection {
  constructor(configuration = {}) {
    this.configuration = configuration;
    this.transceivers = [];
    this.localDescription = undefined;
    this.closed = false;
  }

  addEventListener() {}

  removeEventListener() {}

  getConfiguration() {
    return this.configuration;
  }

  setConfiguration(configuration) {
    this.configuration = configuration;
  }

  addTransceiver(kind, options) {
    const transceiver = {
      mid: String(this.transceivers.length),
      sender: {
        replaceTrack: async () => {},
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async () => {},
        getStats: async () => new Map(),
      },
      receiver: {
        track: { kind },
        getStats: async () => new Map(),
      },
      stop: () => {},
      direction: options?.direction ?? "sendrecv",
    };

    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer() {
    return { type: "offer", sdp: VALID_OFFER_SDP };
  }

  async createAnswer() {
    return { type: "answer", sdp: VALID_OFFER_SDP };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription() {}

  close() {
    this.closed = true;
  }

  getStats() {
    return new Map();
  }
}

class MockMediaStream {
  constructor() {
    this.id = "mock-stream";
  }
}

class MockRTCPeerConnectionCloseThrows extends MockRTCPeerConnection {
  close() {
    throw new Error("close failed");
  }
}

const wrtc = {
  RTCPeerConnection: MockRTCPeerConnection,
  MediaStream: MockMediaStream,
};

test("WrtcHandler.createFactory exposes the wrtc handler contract", async () => {
  const factory = WrtcHandler.createFactory(wrtc);

  assert.equal(factory.name, "wrtc");
  assert.equal(typeof factory.factory, "function");
  assert.equal(typeof factory.getNativeRtpCapabilities, "function");
  assert.equal(typeof factory.getNativeSctpCapabilities, "function");

  const sctpCapabilities = await factory.getNativeSctpCapabilities();
  assert.deepEqual(sctpCapabilities, { numStreams: { OS: 65535, MIS: 65535 } });

  const rtpCapabilities = await factory.getNativeRtpCapabilities({
    direction: "send",
  });

  assert.ok(Array.isArray(rtpCapabilities.codecs));
  assert.ok(
    rtpCapabilities.codecs.some((codec) => codec.mimeType === "audio/opus"),
  );
  assert.ok(
    rtpCapabilities.codecs.some((codec) => codec.mimeType === "video/VP8"),
  );
});

test("WrtcHandler.createFactory returns a valid factory", () => {
  const factory = WrtcHandler.createFactory(wrtc);

  assert.equal(factory.name, "wrtc");
  assert.equal(typeof factory.factory, "function");
});

test("WrtcHandler.createFactory accepts a custom logger sink", () => {
  const customLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const factoryFromClass = WrtcHandler.createFactory(wrtc, customLogger);

  assert.equal(factoryFromClass.name, "wrtc");
});

test("WrtcHandler.getNativeRtpCapabilities tolerates close() failures", async () => {
  const wrtcCloseThrows = {
    RTCPeerConnection: MockRTCPeerConnectionCloseThrows,
    MediaStream: MockMediaStream,
  };
  const factory = WrtcHandler.createFactory(wrtcCloseThrows);

  const rtpCapabilities = await factory.getNativeRtpCapabilities({
    direction: "send",
  });

  assert.ok(Array.isArray(rtpCapabilities.codecs));
});
