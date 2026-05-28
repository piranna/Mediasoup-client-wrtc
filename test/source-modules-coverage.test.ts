import assert from 'node:assert/strict';
import test from 'node:test';


test('all source modules are loadable for full src coverage accounting', async () => {
  const modules = await Promise.all([
    import('../src/index.ts'),
    import('../src/testing/index.ts'),
    import('../src/testing/createAudioSink.ts'),
    import('../src/testing/createLocalMediasoupServer.ts'),
    import('../src/testing/createSyntheticAudioTrack.ts'),
    import('../src/testing/createWrtcDevice.ts'),
  ]);

  for (const mod of modules) {
    assert.ok(mod);
  }
});
