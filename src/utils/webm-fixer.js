/**
 * WebM EBML Duration Header Fixer
 * Patches the missing Duration tag in WebM recordings produced by browser MediaRecorder
 * so that media players can seek and properly display video duration.
 */

// Reads EBML variable-length integer (VINT)
function readVint(buffer, offset) {
  const b = buffer[offset];
  if (b === 0) return null;
  let mask = 0x80;
  let length = 1;
  while ((b & mask) === 0) {
    mask >>= 1;
    length++;
    if (length > 8) return null;
  }
  let value = b & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = (value * 256) + buffer[offset + i];
  }
  return { length, value };
}

// Writes an EBML Float (double precision 8 bytes)
function makeDouble(val) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, val, false); // Big endian
  return new Uint8Array(buf);
}

export async function fixWebmDuration(blob, durationMs) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Look for Info element (EBML ID 0x1549A966)
    const infoId = [0x15, 0x49, 0xa9, 0x66];
    let infoOffset = -1;

    for (let i = 0; i < Math.min(bytes.length - 4, 1024 * 10); i++) {
      if (
        bytes[i] === infoId[0] &&
        bytes[i + 1] === infoId[1] &&
        bytes[i + 2] === infoId[2] &&
        bytes[i + 3] === infoId[3]
      ) {
        infoOffset = i;
        break;
      }
    }

    if (infoOffset === -1) {
      console.warn('[WebMFixer] Segment Info tag not found within search window; returning original blob');
      return blob;
    }

    // Read Info element length
    const infoLenVint = readVint(bytes, infoOffset + 4);
    if (!infoLenVint) return blob;

    const infoContentStart = infoOffset + 4 + infoLenVint.length;
    const infoContentEnd = infoContentStart + infoLenVint.value;

    // Check if Duration element (ID 0x4489) already exists inside Info
    let durationOffset = -1;
    for (let i = infoContentStart; i < Math.min(infoContentEnd, bytes.length - 2); i++) {
      if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
        durationOffset = i;
        break;
      }
    }

    const durationFloatBytes = makeDouble(durationMs);

    if (durationOffset !== -1) {
      // Overwrite existing duration
      const durationLenVint = readVint(bytes, durationOffset + 2);
      if (durationLenVint && durationLenVint.length === 1 && durationLenVint.value === 8) {
        bytes.set(durationFloatBytes, durationOffset + 3);
        return new Blob([bytes], { type: blob.type || 'video/webm' });
      }
    }

    // Otherwise, construct a new Duration element: [0x44, 0x89] + [0x88 (8-byte float vint)] + 8 bytes float
    const durationTag = new Uint8Array(2 + 1 + 8);
    durationTag[0] = 0x44;
    durationTag[1] = 0x89;
    durationTag[2] = 0x88; // VINT of 8 bytes
    durationTag.set(durationFloatBytes, 3);

    // Insert durationTag at infoContentStart
    const newBytes = new Uint8Array(bytes.length + durationTag.length);
    newBytes.set(bytes.subarray(0, infoContentStart), 0);
    newBytes.set(durationTag, infoContentStart);
    newBytes.set(bytes.subarray(infoContentStart), infoContentStart + durationTag.length);

    // Update Info element size if possible
    return new Blob([newBytes], { type: blob.type || 'video/webm' });
  } catch (err) {
    console.warn('[WebMFixer] Could not patch WebM duration:', err);
    return blob;
  }
}
