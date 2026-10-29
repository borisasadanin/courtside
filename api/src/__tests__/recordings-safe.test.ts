/**
 * Recordings survive a restart or an update.
 *
 * The lists of recordings, highlights and cameras are each changed by reading
 * the list, changing it and writing it back. Right after a restart storage can
 * be slow or briefly unreachable; if that read is taken for "no recordings
 * yet", the next write replaces every recording with just the new one.
 */
import { describe, it, expect, vi } from "vitest";
import { MinioClient } from "../minio.js";

const STORED = [{ id: "old-match" }];

/** A client whose storage answers GetObject with `get` and records every write. */
function client(get: () => Promise<unknown>) {
  const minio = new MinioClient("http://storage.test", "key", "secret");
  const writes: string[] = [];
  (minio as unknown as { s3: unknown }).s3 = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Body?: string } }) => {
      if (cmd.constructor.name === "GetObjectCommand") return get();
      if (cmd.constructor.name === "PutObjectCommand") writes.push(String(cmd.input.Body));
      return {};
    }),
  };
  return { minio, writes };
}

const body = (text: string) => ({ Body: { transformToString: async () => text } });
const failure = (name: string) => Object.assign(new Error(name), { name });

describe("the recordings list", () => {
  it("is empty only when there is no list yet", async () => {
    const { minio } = client(async () => { throw failure("NoSuchKey"); });
    expect(await minio.readVodIndex()).toEqual([]);
  });

  it("is never taken for empty when storage does not answer", async () => {
    const { minio, writes } = client(async () => { throw failure("TimeoutError"); });
    await expect(minio.readVodIndex()).rejects.toThrow();
    await expect(minio.addVodEntry({ id: "new-match" } as never)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("is never taken for empty when it is read only in part", async () => {
    const { minio, writes } = client(async () => body('[{"id":"old-ma'));
    await expect(minio.addVodEntry({ id: "new-match" } as never)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("keeps every earlier recording when one is added", async () => {
    const { minio, writes } = client(async () => body(JSON.stringify(STORED)));
    await minio.addVodEntry({ id: "new-match" } as never);
    expect(JSON.parse(writes[0]).map((e: { id: string }) => e.id)).toEqual(["old-match", "new-match"]);
  });
});

describe("the highlights list", () => {
  it("is not overwritten when storage does not answer", async () => {
    const { minio, writes } = client(async () => { throw failure("NetworkingError"); });
    await expect(minio.addClipEntry({ id: "clip" } as never)).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});

describe("the camera list", () => {
  it("does not read as empty when storage does not answer", async () => {
    const { minio } = client(async () => { throw failure("ECONNREFUSED"); });
    await expect(minio.readDeviceIndex()).rejects.toThrow();
  });
});

describe("where an update looks for what earlier versions stored", () => {
  // Installations never set STORAGE_BUCKET, so they all rely on the default.
  // Renaming the bucket or a list would make an updated platform look in the
  // wrong place and show no recordings at all.
  it("uses the same bucket and file names as every earlier release", async () => {
    const minio = new MinioClient("http://storage.test", "key", "secret");
    const asked: string[] = [];
    (minio as unknown as { s3: unknown }).s3 = {
      send: vi.fn(async (cmd: { input: { Bucket: string; Key: string } }) => {
        asked.push(`${cmd.input.Bucket}/${cmd.input.Key}`);
        throw failure("NoSuchKey");
      }),
    };
    await minio.readVodIndex();
    await minio.readClipsIndex();
    await minio.readDeviceIndex();
    await minio.readStreamMetaIndex();
    expect(asked).toEqual([
      "recordings/vod-index.json",
      "recordings/clips-index.json",
      "recordings/devices.json",
      "recordings/active-streams.json",
    ]);
  });
});
