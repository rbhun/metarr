import { Transform, type TransformCallback } from "node:stream";

const START = Buffer.from([0, 0, 1]);
const RPU_NAL_TYPE = 62;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32/MPEG-2, the checksum Dolby Vision puts at the end of each RPU. */
export function crc32Mpeg2(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/** Drops the emulation-prevention byte HEVC inserts after two zero bytes. */
export function unescapeNal(data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length);
  let length = 0;
  let zeros = 0;
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index]!;
    if (zeros >= 2 && byte === 3 && (index + 1 >= data.length || data[index + 1]! <= 3)) {
      zeros = 0;
      continue;
    }
    out[length] = byte;
    length += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

/** The checks dovi_tool stops on: the RPU must end in 0x80 after its CRC, and the CRC must match. */
export function rpuIsValid(nal: Uint8Array): boolean {
  const payload = unescapeNal(nal.subarray(2));
  let end = payload.length;
  while (end > 0 && payload[end - 1] === 0) end -= 1;
  if (end < 7 || payload[end - 1] !== 0x80) return false;
  const received = payload.readUInt32BE(end - 5);
  return crc32Mpeg2(payload.subarray(1, end - 5)) === received;
}

/**
 * The Dolby Vision profile an RPU NAL (from its 2-byte header) belongs to, read the way dovi_tool does:
 * `vdr_rpu_profile` 0 is profile 5; 1 is 7 or 8, told apart by whether an enhancement layer is mapped.
 * Returns 7 for both 7 and 8, since only 5 changes what Metarr does.
 */
export function rpuProfile(nal: Uint8Array): number | null {
  const payload = unescapeNal(nal.subarray(2));
  if (payload[0] !== 0x19 || payload.length < 4) return null;
  const bits = (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
  const rpuType = bits >>> 18;
  if (rpuType !== 2) return null;
  const vdrRpuProfile = (bits >>> 3) & 0xf;
  return vdrRpuProfile === 0 ? 5 : vdrRpuProfile === 1 ? 7 : null;
}

/** The profile of the first readable RPU in an Annex B HEVC stream. */
export function firstRpuProfile(stream: Buffer): number | null {
  for (let found = stream.indexOf(START); found >= 0; found = stream.indexOf(START, found + 3)) {
    const header = stream[found + 3];
    if (header == null || ((header >> 1) & 0x3f) !== RPU_NAL_TYPE) continue;
    const next = stream.indexOf(START, found + 3);
    const nal = stream.subarray(found + 3, next < 0 ? stream.length : next);
    const end = nal.length - trailingZeros(nal);
    if (!rpuIsValid(nal.subarray(0, end))) continue;
    return rpuProfile(nal.subarray(0, end));
  }
  return null;
}

function trailingZeros(data: Uint8Array): number {
  let count = 0;
  while (count < data.length && data[data.length - 1 - count] === 0) count += 1;
  return count;
}

/**
 * Passes an Annex B HEVC stream through, replacing each Dolby Vision RPU that dovi_tool could not read
 * with the last good one, so a few damaged frames borrow the frame before's brightness data instead of
 * stopping the conversion. Every other byte goes through unchanged.
 */
export class RpuRepair extends Transform {
  total = 0;
  replaced = 0;
  /** Unreadable RPUs before the first good one, which have nothing to borrow from. */
  unrepaired = 0;
  private carry: Buffer = Buffer.alloc(0);
  private pending = false;
  private lastGood: Buffer | null = null;

  private unit(bytes: Buffer): Buffer {
    const header = bytes[3];
    if (header == null || ((header >> 1) & 0x3f) !== RPU_NAL_TYPE) return bytes;
    this.total += 1;
    const zeros = trailingZeros(bytes);
    const body = bytes.subarray(0, bytes.length - zeros);
    if (rpuIsValid(body.subarray(3))) {
      this.lastGood = Buffer.from(body);
      return bytes;
    }
    if (!this.lastGood) {
      this.unrepaired += 1;
      return bytes;
    }
    this.replaced += 1;
    return zeros ? Buffer.concat([this.lastGood, bytes.subarray(bytes.length - zeros)]) : this.lastGood;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let from = Math.max(this.pending ? 3 : 0, this.carry.length - 2);
    let unitStart = this.pending ? 0 : -1;
    for (let found = buffer.indexOf(START, from); found >= 0; found = buffer.indexOf(START, from)) {
      if (unitStart < 0) {
        if (found > 0) this.push(buffer.subarray(0, found));
      } else {
        this.push(this.unit(buffer.subarray(unitStart, found)));
      }
      unitStart = found;
      from = found + 3;
    }
    if (unitStart < 0) {
      const keep = Math.min(2, buffer.length);
      if (buffer.length > keep) this.push(buffer.subarray(0, buffer.length - keep));
      this.carry = Buffer.from(buffer.subarray(buffer.length - keep));
      this.pending = false;
    } else {
      this.carry = Buffer.from(buffer.subarray(unitStart));
      this.pending = true;
    }
    done();
  }

  override _flush(done: TransformCallback) {
    if (this.carry.length) this.push(this.pending ? this.unit(this.carry) : this.carry);
    this.carry = Buffer.alloc(0);
    done();
  }
}
