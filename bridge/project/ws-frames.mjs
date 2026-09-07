import { WS_FRAME_LIMIT } from '../config.mjs';

const DEFAULT_CHUNK_CHARACTERS = 30_000;

export function fitsWsFrame(payload, frameLimit = WS_FRAME_LIMIT) {
  return Buffer.byteLength(JSON.stringify(payload)) <= frameLimit;
}

export function splitTextToFrames(text, envelope, options = {}) {
  if (!text) return [''];
  const frameLimit = options.frameLimit || WS_FRAME_LIMIT;
  const chunkCharacters = options.chunkCharacters || DEFAULT_CHUNK_CHARACTERS;
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + chunkCharacters);
    let accepted = false;
    while (end > offset) {
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end--;
      }
      const content = text.slice(offset, end);
      if (fitsWsFrame({
        ...envelope,
        sequence: 9999,
        content,
        complete: false,
      }, frameLimit)) {
        chunks.push(content);
        offset = end;
        accepted = true;
        break;
      }
      end -= Math.min(1024, end - offset);
    }
    if (!accepted) {
      throw new Error('WebSocket frame metadata exceeds the frame limit');
    }
  }
  return chunks;
}

export function sendTextFrames(metadata, text, send) {
  const chunks = splitTextToFrames(text, metadata);
  chunks.forEach((content, sequence) => {
    send({
      ...metadata,
      sequence,
      content,
      complete: sequence === chunks.length - 1,
    });
  });
}
