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

export class MockRTCPeerConnection {
  configuration: RTCConfiguration;
  transceivers: Array<RTCRtpTransceiver>;
  localDescription: RTCSessionDescriptionInit | undefined;

  constructor(configuration: RTCConfiguration = {}) {
    this.configuration = configuration;
    this.transceivers = [];
    this.localDescription = undefined;
  }

  addEventListener() {}

  removeEventListener() {}

  getConfiguration() {
    return this.configuration;
  }

  setConfiguration(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  addTransceiver(kind: string, options?: RTCRtpTransceiverInit) {
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
      direction: options?.direction ?? 'sendrecv',
    } as unknown as RTCRtpTransceiver;

    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: VALID_OFFER_SDP };
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: VALID_OFFER_SDP };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription() {}

  close() {}

  getStats() {
    return new Map();
  }
}

export class MockMediaStream {
  id = 'mock-stream';
}

export function createMockWrtcRuntime() {
  return {
    RTCPeerConnection: MockRTCPeerConnection,
    MediaStream: MockMediaStream,
  };
}
