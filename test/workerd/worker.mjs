// Cloudflare Workers smoke test: resolves the package through the "workerd"
// export condition, which imports lz4.wasm statically. Run with run.mjs.
import * as z from '@kodespire/lz4-js';

export default {
  async fetch() {
    const result = {};
    try {
      const src = new TextEncoder().encode('workerd '.repeat(20_000));
      const frame = await z.compress(src, 9);
      result.roundTrip = (await z.decompress(frame)).length === src.length;
      await z.init();
      result.sync = z.decompressSync(z.compressSync('abc')).length === 3;
      result.block = z.decompressBlockSync(z.compressBlockSync(src), src.length).length === src.length;
      try {
        await z.decompress(frame.subarray(0, frame.length - 3));
        result.truncated = 'no error';
      } catch (error) {
        result.truncated = error.code;
      }
      const body = new Response(src).body.pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream());
      result.stream = (await new Response(body).arrayBuffer()).byteLength === src.length;
      result.backend = z.activeBackend();
      result.version = z.LZ4_VERSION;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    }
    return Response.json(result);
  },
};
