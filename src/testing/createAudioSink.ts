type WrtcModule = typeof import('@roamhq/wrtc');


export function createAudioSink(wrtc: WrtcModule, track: MediaStreamTrack)
{
  const sink = new wrtc.nonstandard.RTCAudioSink(track);
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
