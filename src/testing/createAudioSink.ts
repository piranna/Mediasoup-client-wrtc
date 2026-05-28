import type { WrtcRuntimeWithNonstandard } from './webrtcRuntimeTypes.ts';


export function createAudioSink(
  wrtcRuntime: WrtcRuntimeWithNonstandard,
  track: MediaStreamTrack,
)
{
  const sink = new wrtcRuntime.nonstandard.RTCAudioSink(track);
  let framesReceived = 0;

  sink.ondata = () => {
    framesReceived++;
  };

  return {
    sink,
    getFramesReceived: (): number => framesReceived,
    wait: async (timeoutMs: number, pollIntervalMs = 50): Promise<void> => {
      const deadline = Date.now() + timeoutMs;

      while (framesReceived === 0 && Date.now() < deadline)
      {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
    stop: (): void => {
      sink.stop();
      sink.ondata = undefined;
    },
  };
}
