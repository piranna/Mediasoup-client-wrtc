# mediasoup-client-wrtc

mediasoup-client handler for Node.js using an injected, WebRTC-compatible
runtime implementation.

It lets you use mediasoup-client Device outside the browser through a handler
factory that exposes native RTP/SCTP capabilities and manages transports,
tracks, and data channels.

## Features

- Direct integration with mediasoup-client Device via a custom `handlerFactory`.
- Supports `send` and `recv` directions.
- Supports audio/video sending and receiving.
- Supports negotiated SCTP DataChannels.
- Session control methods: ICE restart, pause/resume, replaceTrack, and stats.
- Supports extra RTP header extensions such as `abs-capture-time` on send.
- Logger sink injection in factory helpers, with `console` as default.

## Requirements

- Node.js with ESM support.
- mediasoup-client v3.
- A WebRTC runtime compatible with:
  - `RTCPeerConnection`
  - `MediaStream`

You inject the concrete runtime instance at call time (for example, an external
`wrtc`-compatible package, but any compatible implementation can be used).

## Installation

```sh
npm install mediasoup-client mediasoup-client-wrtc

# Install your preferred runtime implementation separately.
# Example runtime used by the repository examples:
npm install @roamhq/wrtc
```

## Quick Start

```js
import { Device } from "mediasoup-client";
import * as wrtc from "your-webrtc-runtime";
import { WrtcHandler } from "mediasoup-client-wrtc";

const handlerFactory = WrtcHandler.createFactory(wrtc);
const device = new Device({ handlerFactory });

await device.load({ routerRtpCapabilities });
```

In this snippet, `your-webrtc-runtime` is any injected runtime compatible with
the minimal `WrtcLike` contract.

## Integration Example

The following example shows the client-side wiring for a typical mediasoup flow.
Signaling calls are placeholders because they depend on your server
implementation.

```js
import { Device } from "mediasoup-client";
import * as wrtc from "your-webrtc-runtime";
import { WrtcHandler } from "mediasoup-client-wrtc";

async function setupDevice(routerRtpCapabilities) {
  const handlerFactory = WrtcHandler.createFactory(wrtc);
  const device = new Device({ handlerFactory });

  await device.load({ routerRtpCapabilities });
  return device;
}

async function createSendTransport(device, transportOptions) {
  const transport = device.createSendTransport(transportOptions);

  transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await signalConnectTransport({
        transportId: transport.id,
        dtlsParameters,
      });
      callback();
    } catch (error) {
      errback(error);
    }
  });

  transport.on(
    "produce",
    async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { id } = await signalProduce({
          transportId: transport.id,
          kind,
          rtpParameters,
          appData,
        });
        callback({ id });
      } catch (error) {
        errback(error);
      }
    },
  );

  return transport;
}

async function createRecvTransport(device, transportOptions) {
  const transport = device.createRecvTransport(transportOptions);

  transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await signalConnectTransport({
        transportId: transport.id,
        dtlsParameters,
      });
      callback();
    } catch (error) {
      errback(error);
    }
  });

  return transport;
}

async function startMedia(
  routerRtpCapabilities,
  sendTransportOptions,
  recvTransportOptions,
) {
  const device = await setupDevice(routerRtpCapabilities);
  const sendTransport = await createSendTransport(device, sendTransportOptions);
  const recvTransport = await createRecvTransport(device, recvTransportOptions);

  const track = getOutgoingVideoTrack();
  const producer = await sendTransport.produce({ track });

  const {
    id: consumerId,
    kind,
    rtpParameters,
  } = await signalConsume({
    transportId: recvTransport.id,
    producerId: producer.id,
  });

  const consumer = await recvTransport.consume({
    id: consumerId,
    producerId: producer.id,
    kind,
    rtpParameters,
  });

  return { device, sendTransport, recvTransport, producer, consumer };
}
```

`getOutgoingVideoTrack()` represents your application-specific Node.js media
source, such as a capture pipeline, an FFmpeg bridge, or a custom wrtc track
source.

### Proposed Node.js Track Source Example

If you need a concrete placeholder for local testing, you can provide a fake
video track source:

```js
import * as wrtc from "your-webrtc-runtime";

function getOutgoingVideoTrack() {
  if (!wrtc.nonstandard?.RTCVideoSource) {
    throw new Error("RTCVideoSource is not available in this wrtc build");
  }

  const source = new wrtc.nonstandard.RTCVideoSource();
  const track = source.createTrack();

  // In production, feed frames to source.onFrame(...) from your media pipeline.
  return track;
}
```

## Public API

### `WrtcHandler.createFactory(wrtc, loggerSink = console)`

Creates a mediasoup-compatible `HandlerFactory`.

- `wrtc`: compatible WebRTC runtime.
- `loggerSink`: object with `info`, `warn`, and `error` methods. Defaults to
  `console`.

### Minimal `WrtcLike` interface

```ts
interface WrtcLike {
  RTCPeerConnection: new (
    configuration?: RTCConfiguration,
  ) => RTCPeerConnection;
  MediaStream: new () => MediaStream;
}
```

### Testing Helpers Subpath

The package also exposes testing/integration helpers via:

```ts
import {
  createAudioSink,
  createLocalMediasoupServer,
  createLoggerSink,
  createSyntheticAudioTrack,
  createWrtcDevice,
  createWrtcHandlerFactory,
  type WrtcRuntimeWithNonstandard,
} from "mediasoup-client-wrtc/testing";
```

This subpath is intended for local integration tooling and example wiring. You
pass the concrete runtime implementation explicitly to these helpers.

## Handler Behavior

- Computes native RTP capabilities by generating a local SDP offer with
  audio/video transceivers.
- Uses mediasoup-client `InvalidStateError` for closed-state checks.
- Keeps a MID <-> RTCRtpTransceiver map for follow-up operations.
- Supports sender operations:
  - `send`, `stopSending`, `pauseSending`, `resumeSending`
  - `replaceTrack`
  - `setMaxSpatialLayer`
  - `setRtpEncodingParameters`
  - `getSenderStats`
- Supports receiver operations:
  - `receive`, `stopReceiving`, `pauseReceiving`, `resumeReceiving`
  - `getReceiverStats`
- Supports send and recv DataChannel negotiation over SCTP.
- Supports `restartIce` and `updateIceServers`.

## Development

Project structure:

- TypeScript source code lives in `src/`.
- Build output is emitted to `dist/` (flat output, e.g. `dist/index.js`).
- `test/` and `examples/` are source-only and are not transpiled by
  `npm run build`.

Build:

```sh
npm run build
```

Run tests:

```sh
npm test
```

Tests run directly from TypeScript files in `test/*.test.ts`.

Current tests cover factory contract and native capability bootstrap with a
mocked WebRTC runtime.

## Examples

The repository includes example source files in `examples/`:

Each example calls `loadWrtcRuntimeModule('@roamhq/wrtc')` from
`mediasoup-client-wrtc/testing`. You can switch to another compatible runtime
by passing a different module id to that helper.

- `examples/01-load-device.ts`: minimal `Device.load()` bootstrap.
- `examples/02-produce-consume-audio-mock.ts`: mock signaling flow without a
  real mediasoup server.
- `examples/03-produce-consume-audio-real-mediasoup.ts`: end-to-end flow with a
  local mediasoup Worker/Router and real media exchange.

Examples are provided as TypeScript reference code and are not transpiled by
`npm run build`.

## License

ISC
