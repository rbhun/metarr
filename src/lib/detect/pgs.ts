import fs from "node:fs";
import { crc32, deflateSync } from "node:zlib";

type PaletteEntry = { y: number; a: number };
type Bitmap = { width: number; height: number; rgba: Uint8Array };

function decodeRle(data: Uint8Array, width: number, height: number): Uint8Array | null {
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  const pixels = new Uint8Array(width * height);
  let offset = 0;
  let x = 0;
  let y = 0;
  while (offset < data.length && y < height) {
    let color = data[offset++] ?? 0;
    let run = 1;
    if (color === 0) {
      if (offset >= data.length) break;
      const flags = data[offset++] ?? 0;
      run = flags & 0x3f;
      if (flags & 0x40) {
        if (offset >= data.length) break;
        run = (run << 8) + (data[offset++] ?? 0);
      }
      color = flags & 0x80 ? (data[offset++] ?? 0) : 0;
      if (run === 0) {
        y += 1;
        x = 0;
        continue;
      }
    }
    const room = width - x;
    const take = Math.min(run, room);
    if (take > 0) pixels.fill(color, y * width + x, y * width + x + take);
    x += take;
    if (x >= width) {
      x = 0;
      y += 1;
    }
  }
  return pixels;
}

function toBitmap(indexes: Uint8Array, width: number, height: number, palette: Map<number, PaletteEntry>): Bitmap | null {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  const ink = new Uint8Array(indexes.length);
  for (let index = 0; index < indexes.length; index += 1) {
    const entry = palette.get(indexes[index] ?? 0);
    const alpha = entry?.a ?? ((indexes[index] ?? 0) === 0 ? 0 : 255);
    const luma = entry?.y ?? ((indexes[index] ?? 0) === 0 ? 0 : 235);
    if (alpha <= 16 || luma <= 40) continue;
    ink[index] = 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < left) left = x;
    if (y < top) top = y;
    if (x + 1 > right) right = x + 1;
    if (y + 1 > bottom) bottom = y + 1;
  }
  if (right <= left || bottom <= top) return null;
  const pad = 8;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width, right + pad);
  bottom = Math.min(height, bottom + pad);
  const croppedWidth = right - left;
  const croppedHeight = bottom - top;
  if (croppedWidth < 8 || croppedHeight < 8) return null;
  const rgba = new Uint8Array(croppedWidth * croppedHeight * 4);
  for (let y = 0; y < croppedHeight; y += 1) {
    for (let x = 0; x < croppedWidth; x += 1) {
      const on = ink[(top + y) * width + left + x] === 1;
      const value = on ? 255 : 0;
      const pixel = (y * croppedWidth + x) * 4;
      rgba[pixel] = value;
      rgba[pixel + 1] = value;
      rgba[pixel + 2] = value;
      rgba[pixel + 3] = 255;
    }
  }
  return { width: croppedWidth, height: croppedHeight, rgba };
}

export function readPgsImages(data: Uint8Array): Bitmap[] {
  const images: Bitmap[] = [];
  const palette = new Map<number, PaletteEntry>();
  let pending: { width: number; height: number; expected: number; rle: Uint8Array } | null = null;
  let offset = 0;
  const finishObject = () => {
    if (!pending) return;
    const current = pending;
    pending = null;
    const indexes = decodeRle(current.rle.subarray(0, Math.min(current.rle.length, current.expected || current.rle.length)), current.width, current.height);
    if (!indexes) return;
    const bitmap = toBitmap(indexes, current.width, current.height, palette);
    if (bitmap) images.push(bitmap);
  };

  while (offset + 13 <= data.length) {
    if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
      offset += 1;
      continue;
    }
    const type = data[offset + 10] ?? 0;
    const size = ((data[offset + 11] ?? 0) << 8) | (data[offset + 12] ?? 0);
    const start = offset + 13;
    if (start + size > data.length) break;
    const segment = data.subarray(start, start + size);
    offset = start + size;
    if (type === 0x14 && segment.length >= 2) {
      let cursor = 2;
      while (cursor + 5 <= segment.length) {
        const id = segment[cursor] ?? 0;
        palette.set(id, { y: segment[cursor + 1] ?? 0, a: segment[cursor + 4] ?? 0 });
        cursor += 5;
      }
    } else if (type === 0x15 && segment.length >= 4) {
      const sequence = segment[3] ?? 0;
      if (sequence & 0x80) {
        if (segment.length < 11) continue;
        const length = ((segment[4] ?? 0) << 16) | ((segment[5] ?? 0) << 8) | (segment[6] ?? 0);
        const width = ((segment[7] ?? 0) << 8) | (segment[8] ?? 0);
        const height = ((segment[9] ?? 0) << 8) | (segment[10] ?? 0);
        const expected = Math.max(0, length - 4);
        const rle = segment.subarray(11);
        pending = { width, height, expected, rle: Uint8Array.from(rle) };
        if (pending.rle.length >= expected) finishObject();
      } else if (pending) {
        const more = segment.subarray(4);
        const joined: Uint8Array = new Uint8Array(pending.rle.length + more.length);
        joined.set(pending.rle, 0);
        joined.set(more, pending.rle.length);
        pending = { width: pending.width, height: pending.height, expected: pending.expected, rle: joined };
        if (pending.rle.length >= pending.expected) finishObject();
      }
    } else if (type === 0x80) {
      finishObject();
    }
  }
  finishObject();
  return images;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

export function writePng(file: string, bitmap: Bitmap) {
  const stride = bitmap.width * 4;
  const raw = Buffer.alloc(bitmap.height * (stride + 1));
  for (let y = 0; y < bitmap.height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    Buffer.from(bitmap.rgba.buffer, bitmap.rgba.byteOffset + y * stride, stride).copy(raw, row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(bitmap.width, 0);
  header.writeUInt32BE(bitmap.height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}
