import type { WrtcLike } from '../index.ts';


export type AudioSourceOnDataParams = {
  samples: Int16Array;
  sampleRate: number;
  channelCount: number;
  numberOfFrames: number;
};

export type AudioSourceLike = {
  createTrack: () => MediaStreamTrack;
  onData: (data: AudioSourceOnDataParams) => void;
};

export type AudioSinkLike = {
  ondata?: (() => void) | undefined;
  stop: () => void;
};

export type WrtcRuntimeWithNonstandard = WrtcLike & {
  nonstandard: {
    RTCAudioSource: new () => AudioSourceLike;
    RTCAudioSink: new (track: MediaStreamTrack) => AudioSinkLike;
  };
};
