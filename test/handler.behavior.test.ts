import assert from "node:assert/strict";
import test from "node:test";

import * as sdpTransform from "sdp-transform";
import { ortc, testFakeParameters } from "mediasoup-client";

import { WrtcHandler } from "../src/index.ts";
import { setupTransportWithoutLocalSdpForTest } from "./test-hooks.ts";

const VALID_OFFER_SDP = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1 2
a=msid-semantic: WMS *
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=mid:0
a=sendrecv
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtcp-fb:111 transport-cc
a=rtcp-mux
a=rtcp-rsize
a=ssrc:11111111 cname:audioCname
a=ssrc:11111111 msid:mock-stream-id track-audio
a=ice-ufrag:test
a=ice-pwd:testpassword
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff
a=setup:actpass
m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99
c=IN IP4 0.0.0.0
a=mid:1
a=sendrecv
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time
a=rtpmap:96 VP8/90000
a=rtcp-fb:96 nack
a=rtcp-fb:96 nack pli
a=rtcp-fb:96 ccm fir
a=rtcp-fb:96 goog-remb
a=rtcp-fb:96 transport-cc
a=rtpmap:97 rtx/90000
a=fmtp:97 apt=96
a=rtpmap:98 VP9/90000
a=rtcp-fb:98 nack
a=rtcp-fb:98 nack pli
a=rtcp-fb:98 ccm fir
a=rtcp-fb:98 transport-cc
a=rtpmap:99 rtx/90000
a=fmtp:99 apt=98
a=rtcp-mux
a=rtcp-rsize
a=ssrc-group:FID 22222221 22222222
a=ssrc:22222221 cname:videoCname
a=ssrc:22222221 msid:mock-stream-id track-video
a=ssrc:22222222 cname:videoCname
a=ssrc:22222222 msid:mock-stream-id track-video
a=ice-ufrag:test
a=ice-pwd:testpassword
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff
a=setup:actpass
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=mid:2
a=sctp-port:5000
a=max-message-size:262144
a=ice-ufrag:test
a=ice-pwd:testpassword
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff
a=setup:actpass
`;

function createMockTransceiver(kind, direction = "sendrecv", mid) {
  const params = { encodings: [{}] };

  return {
    mid,
    direction,
    sender: {
      replaceTrack: async () => {},
      getParameters: () => params,
      setParameters: async (newParams) => {
        params.encodings = newParams.encodings;
      },
      getStats: async () => new Map([["sender", { type: "outbound-rtp" }]]),
    },
    receiver: {
      track: { id: `receiver-${mid}`, kind },
      getStats: async () => new Map([["receiver", { type: "inbound-rtp" }]]),
    },
    stop: () => {},
  };
}

class MockRTCPeerConnection {
  static instances = [];

  constructor(configuration = {}) {
    this.configuration = configuration;
    this.transceivers = [];
    this.listeners = new Map();
    this.localDescription = undefined;
    this.remoteDescription = undefined;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.iceGatheringState = "new";
    this.sctp = { maxMessageSize: 262144 };
    this.closed = false;

    MockRTCPeerConnection.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  getConfiguration() {
    return this.configuration;
  }

  setConfiguration(configuration) {
    this.configuration = configuration;
  }

  addTransceiver(trackOrKind, options = {}) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const mid = String(this.transceivers.length);
    const transceiver = createMockTransceiver(
      kind,
      options.direction ?? "sendrecv",
      mid,
    );
    this.transceivers.push(transceiver);

    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  removeTrack() {}

  async createOffer() {
    return { type: "offer", sdp: VALID_OFFER_SDP };
  }

  async createAnswer() {
    return { type: "answer", sdp: VALID_OFFER_SDP };
  }

  async setLocalDescription(description) {
    this.localDescription = description;

    for (const [idx, transceiver] of this.transceivers.entries()) {
      if (transceiver.mid === undefined || transceiver.mid === null) {
        transceiver.mid = String(idx);
      }
    }
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;

    if (description?.type === "offer" && description?.sdp) {
      const sdpObject = sdpTransform.parse(description.sdp);
      const mediaSections = sdpObject.media ?? [];

      for (const media of mediaSections) {
        const mid = String(media.mid ?? this.transceivers.length);
        const existing = this.transceivers.find((entry) => entry.mid === mid);

        if (!existing && (media.type === "audio" || media.type === "video")) {
          this.transceivers.push(
            createMockTransceiver(media.type, "recvonly", mid),
          );
        }
      }
    }
  }

  createDataChannel(label, options) {
    return { label, readyState: "open", options };
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
  }

  getStats() {
    return new Map([["transport", { type: "transport" }]]);
  }
}

class MockRTCPeerConnectionThrowingOffer extends MockRTCPeerConnection {
  async createOffer() {
    throw new Error("createOffer failed");
  }
}

class MockRTCPeerConnectionThrowingOfferAndClose extends MockRTCPeerConnectionThrowingOffer {
  close() {
    throw new Error("close failed");
  }
}

class MockRTCPeerConnectionUndefinedMid extends MockRTCPeerConnection {
  addTransceiver(trackOrKind, options = {}) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const transceiver = createMockTransceiver(
      kind,
      options.direction ?? "sendrecv",
      undefined,
    );

    this.transceivers.push(transceiver);
    return transceiver;
  }
}

class MockRTCPeerConnectionDeferredMid extends MockRTCPeerConnectionUndefinedMid {
  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;

    for (const [idx, transceiver] of this.transceivers.entries()) {
      if (transceiver.mid === undefined || transceiver.mid === null) {
        transceiver.mid = String(idx);
      }
    }

    if (description?.type === "offer" && description?.sdp) {
      const sdpObject = sdpTransform.parse(description.sdp);
      const mediaSections = sdpObject.media ?? [];

      for (const media of mediaSections) {
        const mid = String(media.mid ?? this.transceivers.length);
        const existing = this.transceivers.find((entry) => entry.mid === mid);

        if (!existing && (media.type === "audio" || media.type === "video")) {
          this.transceivers.push(
            createMockTransceiver(media.type, "recvonly", mid),
          );
        }
      }
    }
  }
}

class MockRTCPeerConnectionNoConnectionState extends MockRTCPeerConnection {
  constructor(configuration = {}) {
    super(configuration);
    this.connectionState = undefined;
  }
}

class MockRTCPeerConnectionCloseThrows extends MockRTCPeerConnection {
  close() {
    throw new Error("close failed");
  }
}

class MockRTCPeerConnectionWithoutAutoRecv extends MockRTCPeerConnection {
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
}

class MockRTCPeerConnectionWithoutSctp extends MockRTCPeerConnection {
  constructor(configuration = {}) {
    super(configuration);
    this.sctp = undefined;
  }
}

class MockRTCPeerConnectionExtmapAllowMixed extends MockRTCPeerConnection {
  async createOffer() {
    return {
      type: "offer",
      sdp: VALID_OFFER_SDP.replace(
        "a=msid-semantic: WMS *",
        "a=msid-semantic: WMS *\na=extmap-allow-mixed",
      ),
    };
  }
}

class MockRTCPeerConnectionH264 extends MockRTCPeerConnection {
  async createOffer() {
    return {
      type: "offer",
      sdp: VALID_OFFER_SDP.replace(
        "a=rtpmap:96 VP8/90000",
        "a=rtpmap:96 H264/90000",
      ),
    };
  }
}

class MockMediaStream {
  constructor() {
    this.id = "mock-stream-id";
  }
}

class MockMediaStreamWithRelease extends MockMediaStream {
  static releaseCalls = [];

  release(releaseTracks) {
    MockMediaStreamWithRelease.releaseCalls.push(releaseTracks);
  }
}

class MockMediaStreamWithThrowingRelease extends MockMediaStream {
  static releaseCalls = 0;

  release() {
    MockMediaStreamWithThrowingRelease.releaseCalls += 1;
    throw new Error("release failed");
  }
}

function createWrtc(
  pcClass = MockRTCPeerConnection,
  mediaStreamClass = MockMediaStream,
) {
  return {
    RTCPeerConnection: pcClass,
    MediaStream: mediaStreamClass,
  };
}

function createHandlerOptions(
  direction,
  { dtlsRole, includeAbsCaptureTime = false } = {},
) {
  const transportRemoteParameters =
    testFakeParameters.generateTransportRemoteParameters();
  const routerRtpCapabilities = structuredClone(
    testFakeParameters.generateRouterRtpCapabilities(),
  );

  return {
    direction,
    iceParameters: structuredClone(transportRemoteParameters.iceParameters),
    iceCandidates: structuredClone(transportRemoteParameters.iceCandidates),
    dtlsParameters: {
      ...structuredClone(transportRemoteParameters.dtlsParameters),
      role: dtlsRole ?? transportRemoteParameters.dtlsParameters.role,
    },
    sctpParameters: structuredClone(transportRemoteParameters.sctpParameters),
    getSendExtendedRtpCapabilities: (nativeSendRtpCapabilities) => {
      const extendedRtpCapabilities = ortc.getExtendedRtpCapabilities(
        nativeSendRtpCapabilities,
        routerRtpCapabilities,
      );

      if (includeAbsCaptureTime) {
        extendedRtpCapabilities.headerExtensions.push({
          kind: "video",
          uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
          sendId: 7,
          recvId: 7,
          encrypt: false,
          direction: "sendrecv",
        });
      }

      return extendedRtpCapabilities;
    },
  };
}

function attachConnectHandler(handler) {
  handler.on("@connect", ({ dtlsParameters }, callback) => {
    assert.ok(dtlsParameters);
    callback();
  });
}

test("send handler lifecycle methods work with a mocked runtime", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  const track = { id: "track-1", kind: "audio" };
  const sendResult = await handler.send({ track });

  assert.ok(sendResult.localId);
  assert.ok(sendResult.rtpParameters);

  await handler.pauseSending(sendResult.localId);
  await handler.resumeSending(sendResult.localId);
  await handler.replaceTrack(sendResult.localId, null);
  await handler.setMaxSpatialLayer(sendResult.localId, 0);
  await handler.setRtpEncodingParameters(sendResult.localId, { active: true });

  const senderStats = await handler.getSenderStats(sendResult.localId);
  const transportStats = await handler.getTransportStats();

  assert.ok(senderStats instanceof Map);
  assert.ok(transportStats instanceof Map);

  const sendDataChannelResult = await handler.sendDataChannel({
    sctpStreamParameters: {
      streamId: 0,
      ordered: true,
      maxPacketLifeTime: undefined,
      maxRetransmits: undefined,
      label: "dc",
      protocol: "chat",
    },
  });

  assert.equal(sendDataChannelResult.sctpStreamParameters.streamId, 0);
  assert.equal(handler.getDataChannelMaxMessageSize(), 262144);

  await handler.restartIce(
    testFakeParameters.generateTransportRemoteParameters().iceParameters,
  );
  await handler.stopSending(sendResult.localId);

  handler.close();
  handler.close();
});

test("recv handler lifecycle methods work with a mocked runtime", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("recv"));

  attachConnectHandler(handler);

  const consumerRemoteParameters =
    testFakeParameters.generateConsumerRemoteParameters({
      codecMimeType: "audio/opus",
    });

  const [receiveResult] = await handler.receive([
    {
      trackId: "remote-track-1",
      kind: "audio",
      rtpParameters: consumerRemoteParameters.rtpParameters,
      onRtpReceiver: (rtpReceiver) => {
        assert.ok(rtpReceiver);
      },
    },
  ]);

  assert.equal(receiveResult.localId, "0");
  assert.equal(receiveResult.track.kind, "audio");

  await handler.pauseReceiving([receiveResult.localId]);
  await handler.resumeReceiving([receiveResult.localId]);

  const receiverStats = await handler.getReceiverStats(receiveResult.localId);
  assert.ok(receiverStats instanceof Map);

  const receiveDataChannelResult = await handler.receiveDataChannel({
    maxMessageSize: 16384,
    sctpStreamParameters: {
      streamId: 7,
      ordered: false,
      maxPacketLifeTime: 3000,
      maxRetransmits: undefined,
    },
    label: "chat",
    protocol: "json",
  });

  assert.equal(receiveDataChannelResult.dataChannel.label, "chat");

  await handler.restartIce(
    testFakeParameters.generateTransportRemoteParameters().iceParameters,
  );
  await handler.stopReceiving([receiveResult.localId]);

  handler.close();
});

test("direction and closed guards throw expected errors", async () => {
  const wrtc = createWrtc();

  const sendFactory = WrtcHandler.createFactory(wrtc);
  const sendHandler = sendFactory.factory(createHandlerOptions("send"));
  attachConnectHandler(sendHandler);

  const recvFactory = WrtcHandler.createFactory(wrtc);
  const recvHandler = recvFactory.factory(createHandlerOptions("recv"));
  attachConnectHandler(recvHandler);

  await assert.rejects(() => sendHandler.receive([]), /recv/);
  await assert.rejects(
    () => recvHandler.send({ track: { id: "x", kind: "audio" } }),
    /send/,
  );

  sendHandler.close();
  await assert.rejects(
    () => sendHandler.updateIceServers([]),
    /InvalidStateError/,
  );
});

test("fallback connection state mapping uses iceconnectionstatechange events", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc(MockRTCPeerConnectionNoConnectionState);
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  const emittedStates = [];

  handler.on("@connectionstatechange", (state) => {
    emittedStates.push(state);
  });

  const pc = MockRTCPeerConnection.instances.at(-1);

  pc.iceConnectionState = "checking";
  pc.emit("iceconnectionstatechange");
  pc.iceConnectionState = "connected";
  pc.emit("iceconnectionstatechange");
  pc.iceConnectionState = "failed";
  pc.emit("iceconnectionstatechange");
  pc.iceConnectionState = "disconnected";
  pc.emit("iceconnectionstatechange");
  pc.iceConnectionState = "closed";
  pc.emit("iceconnectionstatechange");

  assert.deepEqual(emittedStates, [
    "connecting",
    "connected",
    "failed",
    "disconnected",
    "closed",
  ]);

  handler.close();
});

test("native RTP capabilities failure path closes the peer connection and rethrows", async () => {
  const wrtc = createWrtc(MockRTCPeerConnectionThrowingOffer);
  const factory = WrtcHandler.createFactory(wrtc);

  await assert.rejects(
    () => factory.getNativeRtpCapabilities({ direction: "sendonly" }),
    /createOffer failed/,
  );
});

test("send path supports multiple encodings and deferred MID assignment", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc(MockRTCPeerConnectionUndefinedMid);
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  const onRtpSenderCalls = [];
  const track = { id: "track-video-2", kind: "video" };
  const sendResult = await handler.send({
    track,
    encodings: [{ scalabilityMode: "L1T3" }, { scalabilityMode: "L1T3" }],
    onRtpSender: (sender) => {
      onRtpSenderCalls.push(sender);
    },
  });

  assert.equal(handler.name, "wrtc");
  assert.ok(sendResult.localId);
  assert.equal(onRtpSenderCalls.length, 1);

  await handler.stopSending(sendResult.localId);
  handler.close();
});

test("connection and ICE event handlers emit expected notifications", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  const events = {
    connection: [],
    gathering: [],
    candidateErrors: [],
  };

  handler.on("@connectionstatechange", (state) =>
    events.connection.push(state),
  );
  handler.on("@icegatheringstatechange", (state) =>
    events.gathering.push(state),
  );
  handler.on("@icecandidateerror", (event) =>
    events.candidateErrors.push(event),
  );

  const pc = MockRTCPeerConnection.instances.at(-1);

  pc.iceGatheringState = "gathering";
  pc.emit("icegatheringstatechange");
  pc.connectionState = "connecting";
  pc.emit("connectionstatechange");
  pc.emit("icecandidateerror", { errorCode: 701 });

  assert.deepEqual(events.gathering, ["gathering"]);
  assert.deepEqual(events.connection, ["connecting"]);
  assert.equal(events.candidateErrors.length, 1);

  handler.close();
});

test("forced DTLS role path and single encoding send branch are exercised", async () => {
  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(
    createHandlerOptions("send", { dtlsRole: "server" }),
  );

  attachConnectHandler(handler);

  const result = await handler.send({
    track: { id: "track-single-encoding", kind: "video" },
    encodings: [{ maxBitrate: 1000000 }],
  });

  assert.ok(result.localId);

  await handler.stopSending(result.localId);
  handler.close();
});

test("VP9 SVC and absCaptureTime send branches are exercised", async () => {
  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const handler = factory.factory(
    createHandlerOptions("send", { includeAbsCaptureTime: true }),
  );

  attachConnectHandler(handler);

  const result = await handler.send({
    track: { id: "track-vp9", kind: "video" },
    encodings: [{ scalabilityMode: "L3T3" }],
    codec: {
      mimeType: "video/VP9",
      clockRate: 90000,
      channels: undefined,
      parameters: { "profile-id": 0 },
      rtcpFeedback: [
        { type: "nack" },
        { type: "nack", parameter: "pli" },
        { type: "ccm", parameter: "fir" },
        { type: "transport-cc" },
      ],
    },
    headerExtensionOptions: { absCaptureTime: true },
  });

  assert.ok(result.localId);

  await handler.stopSending(result.localId);
  handler.close();
});

test("send() assigns localId after answer when transceiver.mid is initially undefined", async () => {
  const wrtc = createWrtc(MockRTCPeerConnectionDeferredMid);
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  const result = await handler.send({
    track: { id: "track-deferred-mid", kind: "audio" },
  });

  assert.equal(result.localId, "0");
  await handler.stopSending(result.localId);
  handler.close();
});

test("sendDataChannel can bootstrap transport before send()", async () => {
  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  const dataResult = await handler.sendDataChannel({
    sctpStreamParameters: {
      streamId: 1,
      ordered: true,
      maxPacketLifeTime: undefined,
      maxRetransmits: undefined,
      label: "pre-send-dc",
      protocol: "text",
    },
  });
  assert.equal(dataResult.sctpStreamParameters.streamId, 0);
  handler.close();
});

test("stopSending tolerates transceiver.stop() errors", async () => {
  MockRTCPeerConnection.instances = [];

  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  const first = await handler.send({
    track: { id: "track-first", kind: "audio" },
  });
  const result = await handler.send({
    track: { id: "track-stop-throw", kind: "video" },
  });
  const pc = MockRTCPeerConnection.instances.at(-1);
  const transceiver = pc
    .getTransceivers()
    .find((entry) => entry.mid === result.localId);

  transceiver.stop = () => {
    throw new Error("stop failure");
  };

  await handler.stopSending(result.localId);
  await handler.stopSending(first.localId);
  handler.close();
});

test("receiveDataChannel can bootstrap transport before receive()", async () => {
  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("recv"));

  attachConnectHandler(handler);

  const result = await handler.receiveDataChannel({
    maxMessageSize: 32768,
    sctpStreamParameters: {
      streamId: 9,
      ordered: true,
      maxPacketLifeTime: undefined,
      maxRetransmits: undefined,
    },
    label: "bootstrap-recv-dc",
    protocol: "json",
  });

  assert.equal(result.dataChannel.label, "bootstrap-recv-dc");
  handler.close();
});

test("additional alternate branches are exercised", async () => {
  {
    const wrtc = createWrtc(MockRTCPeerConnectionCloseThrows);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const sendHandler = factory.factory(createHandlerOptions("send"));
    const recvHandler = factory.factory(createHandlerOptions("recv"));

    await sendHandler.restartIce(
      testFakeParameters.generateTransportRemoteParameters().iceParameters,
    );
    await recvHandler.restartIce(
      testFakeParameters.generateTransportRemoteParameters().iceParameters,
    );

    await assert.rejects(
      () => sendHandler.pauseSending("missing"),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => sendHandler.resumeSending("missing"),
      /no media section found/,
    );
    await assert.rejects(
      () => sendHandler.getSenderStats("missing"),
      /associated RTCRtpTransceiver not found/,
    );

    await assert.rejects(
      () => recvHandler.pauseReceiving(["missing"]),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => recvHandler.resumeReceiving(["missing"]),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => recvHandler.getReceiverStats("missing"),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => recvHandler.stopReceiving(["missing"]),
      /associated RTCRtpTransceiver not found/,
    );

    sendHandler.close();
    recvHandler.close();

    await sendHandler.stopSending("whatever");
    await recvHandler.stopReceiving(["whatever"]);
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    attachConnectHandler(handler);

    const sent = await handler.send({
      track: { id: "replace-track", kind: "audio" },
    });

    await handler.replaceTrack(sent.localId, {
      id: "new-track",
      kind: "audio",
    });
    await assert.rejects(
      () => handler.stopSending("missing"),
      /associated RTCRtpTransceiver not found/,
    );

    const firstDc = await handler.sendDataChannel({
      sctpStreamParameters: {
        streamId: 0,
        ordered: true,
        maxPacketLifeTime: undefined,
        maxRetransmits: undefined,
        label: undefined,
        protocol: "json",
      },
    });
    const secondDc = await handler.sendDataChannel({
      sctpStreamParameters: {
        streamId: 0,
        ordered: false,
        maxPacketLifeTime: 10,
        maxRetransmits: undefined,
        label: undefined,
        protocol: "json",
      },
    });

    assert.equal(firstDc.dataChannel.label, "");
    assert.equal(secondDc.sctpStreamParameters.streamId, 1);

    await handler.stopSending(sent.localId);
    handler.close();
  }

  {
    const wrtc = createWrtc(MockRTCPeerConnectionWithoutSctp);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    assert.equal(handler.getDataChannelMaxMessageSize(), undefined);
    handler.close();
  }

  {
    MockRTCPeerConnection.instances = [];

    const wrtc = createWrtc(MockRTCPeerConnectionNoConnectionState);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    const emittedStates = [];
    handler.on("@connectionstatechange", (state) => emittedStates.push(state));

    const pc = MockRTCPeerConnection.instances.at(-1);
    pc.iceConnectionState = "completed";
    pc.emit("iceconnectionstatechange");

    assert.deepEqual(emittedStates, ["connected"]);
    handler.close();
  }

  {
    const wrtc = createWrtc(MockRTCPeerConnectionWithoutAutoRecv);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const consumerRemoteParameters =
      testFakeParameters.generateConsumerRemoteParameters({
        codecMimeType: "audio/opus",
      });

    await assert.rejects(
      () =>
        handler.receive([
          {
            trackId: "missing-transceiver",
            kind: "audio",
            rtpParameters: consumerRemoteParameters.rtpParameters,
            onRtpReceiver: () => {},
          },
        ]),
      /transceiver not found/,
    );

    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const first = await handler.receiveDataChannel({
      maxMessageSize: 12345,
      sctpStreamParameters: {
        streamId: 5,
        ordered: true,
        maxPacketLifeTime: undefined,
        maxRetransmits: undefined,
      },
      label: undefined,
      protocol: "text",
    });
    const second = await handler.receiveDataChannel({
      maxMessageSize: 12345,
      sctpStreamParameters: {
        streamId: 6,
        ordered: false,
        maxPacketLifeTime: 10,
        maxRetransmits: undefined,
      },
      label: undefined,
      protocol: "text",
    });

    assert.equal(first.dataChannel.label, "");
    assert.equal(second.dataChannel.label, "");
    handler.close();
  }
});

test("remaining branch-heavy paths are exercised", async () => {
  {
    const wrtc = createWrtc(MockRTCPeerConnectionCloseThrows);
    const factory = WrtcHandler.createFactory(wrtc);

    await factory.getNativeRtpCapabilities({ direction: "sendonly" });
  }

  {
    const wrtc = createWrtc(MockRTCPeerConnectionExtmapAllowMixed);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    attachConnectHandler(handler);

    const first = await handler.send({
      track: { id: "transport-ready-1", kind: "audio" },
    });
    const second = await handler.send({
      track: { id: "transport-ready-2", kind: "video" },
      encodings: [{ maxBitrate: 800000 }],
    });

    await handler.stopSending(second.localId);

    await assert.rejects(
      () => handler.resumeSending(second.localId),
      /associated RTCRtpTransceiver not found/,
    );

    await handler.stopSending(first.localId);
    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const consumerA = testFakeParameters.generateConsumerRemoteParameters({
      codecMimeType: "audio/opus",
    });
    const consumerB = testFakeParameters.generateConsumerRemoteParameters({
      codecMimeType: "audio/opus",
    });

    const first = await handler.receive([
      {
        trackId: "recv-no-callback",
        kind: "audio",
        rtpParameters: consumerA.rtpParameters,
      },
    ]);
    const second = await handler.receive([
      {
        trackId: "recv-with-callback",
        kind: "audio",
        rtpParameters: consumerB.rtpParameters,
        onRtpReceiver: () => {},
      },
    ]);

    await handler.stopReceiving([first[0].localId, second[0].localId]);
    handler.close();
  }

  {
    const wrtc = createWrtc(MockRTCPeerConnectionWithoutAutoRecv);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const consumerRemoteParameters =
      testFakeParameters.generateConsumerRemoteParameters({
        codecMimeType: "audio/opus",
      });

    await assert.rejects(
      () =>
        handler.receive([
          {
            trackId: "missing-new-transceiver",
            kind: "audio",
            rtpParameters: consumerRemoteParameters.rtpParameters,
          },
        ]),
      /new RTCRtpTransceiver not found/,
    );

    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const consumerRemoteParameters =
      testFakeParameters.generateConsumerRemoteParameters({
        codecMimeType: "audio/opus",
      });

    const [result] = await handler.receive([
      {
        trackId: "recv-before-dc",
        kind: "audio",
        rtpParameters: consumerRemoteParameters.rtpParameters,
      },
    ]);

    const dc = await handler.receiveDataChannel({
      maxMessageSize: 23456,
      sctpStreamParameters: {
        streamId: 11,
        ordered: true,
        maxPacketLifeTime: undefined,
        maxRetransmits: undefined,
      },
      label: "after-receive",
      protocol: "text",
    });

    assert.equal(dc.dataChannel.label, "after-receive");
    await handler.stopReceiving([result.localId]);
    handler.close();
  }
});

test("targeted remaining boolean branches are exercised", async () => {
  {
    const wrtc = createWrtc(MockRTCPeerConnectionThrowingOfferAndClose);
    const factory = WrtcHandler.createFactory(wrtc);

    await assert.rejects(
      () => factory.getNativeRtpCapabilities({ direction: "sendonly" }),
      /createOffer failed/,
    );
  }

  {
    const wrtc = createWrtc(MockRTCPeerConnectionH264);
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("send"));

    attachConnectHandler(handler);

    const sent = await handler.send({
      track: { id: "h264-native-send", kind: "video" },
      encodings: [{}, {}],
    });

    await handler.stopSending(sent.localId);
    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(
      createHandlerOptions("send", { dtlsRole: "client" }),
    );

    attachConnectHandler(handler);

    const sent = await handler.send({
      track: { id: "h264-branch", kind: "video" },
      encodings: [{}, {}],
    });

    await assert.rejects(
      () => handler.replaceTrack("missing", null),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => handler.setMaxSpatialLayer("missing", 0),
      /associated RTCRtpTransceiver not found/,
    );
    await assert.rejects(
      () => handler.setRtpEncodingParameters("missing", { active: false }),
      /associated RTCRtpTransceiver not found/,
    );

    await handler.stopSending(sent.localId);
    handler.close();
  }

  {
    const wrtc = createWrtc();
    const factory = WrtcHandler.createFactory(wrtc);
    const handler = factory.factory(createHandlerOptions("recv"));

    attachConnectHandler(handler);

    const consumerRemoteParameters =
      testFakeParameters.generateConsumerRemoteParameters({
        codecMimeType: "audio/opus",
      });
    const customRtpParameters = structuredClone(
      consumerRemoteParameters.rtpParameters,
    );

    customRtpParameters.msid = undefined;
    customRtpParameters.rtcp = {
      ...customRtpParameters.rtcp,
      cname: null,
    };

    const [recv] = await handler.receive([
      {
        trackId: "recv-fallback-stream-id",
        kind: "audio",
        rtpParameters: customRtpParameters,
      },
    ]);

    await handler.stopReceiving([recv.localId]);
    handler.close();
  }
});

test("close() releases local stream when runtime exposes release()", () => {
  MockMediaStreamWithRelease.releaseCalls = [];

  const wrtc = createWrtc(MockRTCPeerConnection, MockMediaStreamWithRelease);
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  handler.close();

  assert.deepEqual(MockMediaStreamWithRelease.releaseCalls, [false]);
});

test("close() tolerates local stream release() errors", () => {
  MockMediaStreamWithThrowingRelease.releaseCalls = 0;

  const wrtc = createWrtc(
    MockRTCPeerConnection,
    MockMediaStreamWithThrowingRelease,
  );
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  handler.close();

  assert.equal(MockMediaStreamWithThrowingRelease.releaseCalls, 1);
});

test("test-hooks can execute setupTransport() fallback without localSdpObject", async () => {
  const wrtc = createWrtc();
  const factory = WrtcHandler.createFactory(wrtc);
  const handler = factory.factory(createHandlerOptions("send"));

  attachConnectHandler(handler);

  await handler.send({ track: { id: "hook-setup-transport", kind: "audio" } });
  await setupTransportWithoutLocalSdpForTest(handler, "client");

  handler.close();
});
