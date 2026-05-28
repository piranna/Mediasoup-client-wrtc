import assert from "node:assert/strict";
import test from "node:test";

import { WrtcHandler } from "../src/index.ts";
import {
  createMockWrtcRuntime,
  MockMediaStream,
  MockRTCPeerConnection,
} from "./fixtures/mockWrtcRuntime.ts";

class MockRTCPeerConnectionCloseThrows extends MockRTCPeerConnection {
  close() {
    throw new Error("close failed");
  }
}

const wrtc = {
  ...createMockWrtcRuntime(),
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
