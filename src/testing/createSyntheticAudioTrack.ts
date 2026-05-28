type WrtcModule = typeof import('@roamhq/wrtc');


type CreateSyntheticAudioTrackOptions = {
  sampleRate?: number;
  channelCount?: number;
  intervalMs?: number;
};


export function createSyntheticAudioTrack(
  wrtc: WrtcModule,
  {
    sampleRate = 48000,
    channelCount = 1,
    intervalMs = 10,
  }: CreateSyntheticAudioTrackOptions = {},
)
{
  const audioSource = new wrtc.nonstandard.RTCAudioSource();
  const track = audioSource.createTrack();

  const numberOfFrames = sampleRate / 100;
  const samples = new Int16Array(numberOfFrames * channelCount);

  const intervalId = setInterval(() => {
    audioSource.onData({ samples, sampleRate, channelCount, numberOfFrames });
  }, intervalMs);

  return {
    audioSource,
    track,
    sampleRate,
    channelCount,
    numberOfFrames,
    samples,
    stop: (): void => {
      clearInterval(intervalId);
      track.stop();
    },
  };
}
