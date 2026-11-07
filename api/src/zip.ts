/**
 * A minimal ZIP writer: stored entries only, no compression.
 *
 * Used to hand a guest every clip of their space in one download (#54).  The
 * files are MP4s, which do not compress, so storing them as they are costs
 * nothing and needs no dependency.  Entries are loaded one at a time and
 * written as soon as they are loaded, so memory holds one clip at a time,
 * never the whole archive.
 *
 * Limits: no ZIP64, so the archive must stay under 4 GiB (a guest space holds
 * a match's opponent clips, a few hundred MB at most).  Names are UTF-8
 * (general purpose flag bit 11).
 */
import { Readable } from "node:stream";

export interface ZipEntry {
  /** File name inside the archive. */
  name: string;
  /** Modification time stored for the entry. */
  date: Date;
  /** The file's bytes, fetched only when the entry is written. */
  load: () => Promise<Buffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as ZIP stores them (local time, two-second steps). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_FLAG = 0x0800;
const MAX_32 = 0xffffffff;

/**
 * The archive as a stream.  An entry whose load fails is left out (and
 * reported through onSkip), so one missing file does not spoil the rest.
 */
export function zipStream(entries: ZipEntry[], onSkip?: (entry: ZipEntry, err: unknown) => void): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    let count = 0;

    for (const entry of entries) {
      let data: Buffer;
      try {
        data = await entry.load();
      } catch (err) {
        onSkip?.(entry, err);
        continue;
      }
      const name = Buffer.from(entry.name, "utf8");
      const crc = crc32(data);
      const { time, date } = dosDateTime(entry.date);
      if (offset + 30 + name.length + data.length > MAX_32) {
        throw new Error("Archive too large for a ZIP without ZIP64");
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      // extra, comment, disk, internal attributes, external attributes: all 0
      header.writeUInt32LE(offset, 42);
      central.push(header, name);

      yield Buffer.concat([local, name]);
      yield data;
      offset += 30 + name.length + data.length;
      count++;
    }

    const centralDir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    yield Buffer.concat([centralDir, end]);
  }

  return Readable.from(generate());
}
