import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RANGE_READ_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const TRANSIENT_RANGE_READ_ERROR_CODES = new Set([
  "EAGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EINTR",
  "EIO",
  "ENETDOWN",
  "ENETUNREACH",
  "ESTALE",
  "ETIMEDOUT",
  "archive_cold_mount_unavailable",
  "archive_object_unavailable",
]);

export interface ArchiveRemoteObject {
  bytes: number;
  sha256: string | null;
}

export interface ArchiveRemote {
  put(key: string, body: Uint8Array, sha256: string): Promise<void>;
  putFile(key: string, path: string, bytes: number, sha256: string): Promise<void>;
  head(key: string): Promise<ArchiveRemoteObject>;
  read(key: string): Promise<Buffer>;
  readRange(key: string, offset: number, length: number): Promise<Buffer>;
  openRead(key: string): Promise<NodeJS.ReadableStream>;
  downloadToFile(key: string, path: string): Promise<void>;
}

export class FilesystemArchiveRemote implements ArchiveRemote {
  readonly root: string;
  readonly createRoot: boolean;
  readonly enforcePrivateObjects: boolean;
  constructor(root: string, options: { createRoot?: boolean; enforcePrivateObjects?: boolean } = {}) {
    this.root = resolve(root);
    this.createRoot = options.createRoot ?? true;
    this.enforcePrivateObjects = options.enforcePrivateObjects ?? false;
  }

  async put(key: string, body: Uint8Array, expectedSha256: string): Promise<void> {
    if (sha256Hex(body) !== expectedSha256) throw remoteError("archive_upload_hash_mismatch");
    const path = this.path(key);
    await this.ensurePrivateDirectory(dirname(path));
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporary, body, { mode: 0o600, flag: "wx" });
      try {
        await fs.link(temporary, path);
      } catch (error) {
        if (isLinkUnsupported(error)) {
          await fs.copyFile(temporary, path, fsConstants.COPYFILE_EXCL).catch(async (copyError: unknown) => {
            if (!isAlreadyExists(copyError)) throw copyError;
          });
        } else if (!isAlreadyExists(error)) throw error;
        const existing = await this.head(key);
        if (existing.bytes !== body.length || existing.sha256 !== expectedSha256) throw remoteError("archive_object_conflict");
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async head(key: string): Promise<ArchiveRemoteObject> {
    const path = await this.privateObjectPath(key);
    const [stat, digest] = await Promise.all([fs.stat(path), sha256File(path)]);
    return { bytes: stat.size, sha256: digest };
  }

  async putFile(key: string, source: string, bytes: number, expectedSha256: string): Promise<void> {
    const [stat, digest] = await Promise.all([fs.stat(source), sha256File(source)]);
    if (stat.size !== bytes || digest !== expectedSha256) throw remoteError("archive_upload_hash_mismatch");
    const path = this.path(key);
    await this.ensurePrivateDirectory(dirname(path));
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporary, 0o600);
      try { await fs.link(temporary, path); }
      catch (error) {
        if (isLinkUnsupported(error)) {
          await fs.copyFile(temporary, path, fsConstants.COPYFILE_EXCL).catch(async (copyError: unknown) => {
            if (!isAlreadyExists(copyError)) throw copyError;
          });
        } else if (!isAlreadyExists(error)) throw error;
        const existing = await this.head(key);
        if (existing.bytes !== bytes || existing.sha256 !== expectedSha256) throw remoteError("archive_object_conflict");
      }
    } catch (error) {
      if (isArchiveError(error)) throw error;
      throw remoteError("archive_remote_write_failed");
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async promoteStagedFile(key: string, source: string, bytes: number, expectedSha256: string): Promise<void> {
    const sourcePath = resolve(source);
    const stagingRoot = resolve(this.root, ".staging");
    if (sourcePath === stagingRoot || !sourcePath.startsWith(`${stagingRoot}${sep}`)) {
      throw remoteError("archive_invalid_staging_path");
    }
    const sourceStat = await this.privateFilePath(sourcePath);
    if (sourceStat.size !== bytes) throw remoteError("archive_upload_hash_mismatch");

    const destination = this.path(key);
    await this.ensurePrivateDirectory(dirname(destination));
    const existing = await this.headIfPresent(key);
    if (existing) {
      if (existing.bytes !== bytes || existing.sha256 !== expectedSha256) throw remoteError("archive_object_conflict");
      await fs.rm(sourcePath, { force: true });
      return;
    }

    try {
      await fs.rename(sourcePath, destination);
    } catch (error) {
      const promoted = await this.headIfPresent(key);
      if (promoted?.bytes === bytes && promoted.sha256 === expectedSha256) {
        await fs.rm(sourcePath, { force: true });
        return;
      }
      if (promoted) throw remoteError("archive_object_conflict");
      if (isArchiveError(error)) throw error;
      throw remoteError("archive_remote_write_failed");
    }

    const promoted = await this.privateFilePath(destination);
    if (promoted.size !== bytes) throw remoteError("archive_object_conflict");
  }

  async read(key: string): Promise<Buffer> { return fs.readFile(await this.privateObjectPath(key)); }

  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw remoteError("archive_invalid_read_range");
    }
    return retryTransientRangeRead(async () => {
      const handle = await fs.open(await this.privateObjectPath(key), "r");
      try {
        const result = Buffer.alloc(length);
        let consumed = 0;
        while (consumed < length) {
          const read = await handle.read(result, consumed, length - consumed, offset + consumed);
          if (read.bytesRead === 0) throw remoteError("archive_range_read_short");
          consumed += read.bytesRead;
        }
        return result;
      } finally {
        await handle.close();
      }
    });
  }

  async openRead(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(await this.privateObjectPath(key));
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    await fs.copyFile(await this.privateObjectPath(key), path, fsConstants.COPYFILE_EXCL);
    await fs.chmod(path, 0o600);
  }

  private async privateObjectPath(key: string): Promise<string> {
    const path = this.path(key);
    await this.privateFilePath(path);
    return path;
  }

  private async privateFilePath(path: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
    const stat = await fs.lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") throw error;
      throw remoteError("archive_object_unavailable");
    });
    if (stat.isSymbolicLink() || !stat.isFile()) throw remoteError("archive_object_invalid");
    await this.assertPrivateDirectoryChain(dirname(path));
    if (this.enforcePrivateObjects && ((stat.mode & 0o777) & ~0o600) !== 0) throw remoteError("archive_object_permissions_invalid");
    return stat;
  }

  private async headIfPresent(key: string): Promise<ArchiveRemoteObject | null> {
    try { return await this.head(key); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private path(key: string): string {
    const path = resolve(this.root, key.replace(/^\/+/, ""));
    if (path !== this.root && !path.startsWith(`${this.root}/`)) throw remoteError("archive_invalid_object_key");
    return path;
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    if (!this.createRoot) {
      const root = await fs.lstat(this.root).catch((error: unknown) => {
        throw remoteError(errorCode(error) === "ENOENT" ? "archive_cold_mount_missing" : "archive_cold_mount_unavailable");
      });
      if (!root.isDirectory() || root.isSymbolicLink()) throw remoteError("archive_cold_mount_invalid");
    }
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await this.assertPrivateDirectoryChain(path);
    await fs.chmod(this.root, 0o700);
    await fs.chmod(path, 0o700);
  }

  private async assertPrivateDirectoryChain(path: string): Promise<void> {
    const rootStat = await fs.lstat(this.root).catch((error: unknown) => {
      throw remoteError(errorCode(error) === "ENOENT" ? "archive_cold_mount_missing" : "archive_cold_mount_unavailable");
    });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw remoteError("archive_cold_mount_invalid");
    const relativePath = relative(this.root, path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.includes(`${sep}..${sep}`)) {
      throw remoteError("archive_invalid_object_key");
    }
    let current = this.root;
    for (const component of relativePath.split(sep).filter(Boolean)) {
      current = join(current, component);
      const stat = await fs.lstat(current).catch((error: unknown) => {
        throw remoteError(errorCode(error) === "ENOENT" ? "archive_object_unavailable" : "archive_object_invalid");
      });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw remoteError("archive_object_invalid");
    }
  }
}

export function archiveRemoteFromConfig(root: string): ArchiveRemote {
  return new FilesystemArchiveRemote(root);
}

export function archiveReadRemoteFromConfig(hotRoot: string, coldRoot?: string): ArchiveRemote {
  const hot = new FilesystemArchiveRemote(hotRoot);
  if (!coldRoot) return hot;
  const cold = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
  return new FallbackArchiveRemote(
    cold,
    hot,
    cold.root,
  );
}

class FallbackArchiveRemote implements ArchiveRemote {
  constructor(
    private readonly primary: ArchiveRemote,
    private readonly legacy: ArchiveRemote,
    private readonly primaryRoot: string,
  ) {}

  put(key: string, body: Uint8Array, sha256: string): Promise<void> { return this.primary.put(key, body, sha256); }
  putFile(key: string, path: string, bytes: number, sha256: string): Promise<void> { return this.primary.putFile(key, path, bytes, sha256); }
  head(key: string): Promise<ArchiveRemoteObject> { return this.readWithLegacy((remote) => remote.head(key)); }
  read(key: string): Promise<Buffer> { return this.readWithLegacy((remote) => remote.read(key)); }
  readRange(key: string, offset: number, length: number): Promise<Buffer> { return this.readWithLegacy((remote) => remote.readRange(key, offset, length)); }
  openRead(key: string): Promise<NodeJS.ReadableStream> { return this.readWithLegacy((remote) => remote.openRead(key)); }
  downloadToFile(key: string, path: string): Promise<void> { return this.readWithLegacy((remote) => remote.downloadToFile(key, path)); }

  private async readWithLegacy<T>(operation: (remote: ArchiveRemote) => Promise<T>): Promise<T> {
    const root = await fs.lstat(this.primaryRoot).catch((error: unknown) => {
      throw remoteError(errorCode(error) === "ENOENT" ? "archive_cold_mount_missing" : "archive_cold_mount_unavailable");
    });
    if (!root.isDirectory() || root.isSymbolicLink()) throw remoteError("archive_cold_mount_invalid");
    try { return await operation(this.primary); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      return operation(this.legacy);
    }
  }
}

export interface FilesystemArchiveMountPreflightResult {
  root: string;
  device: number;
  filesystemType: number;
  availableBytes: number;
  mountRequired: boolean;
}

/**
 * Fail-closed admission for a filesystem-backed cold archive. The root must
 * already exist; Friday never creates a local look-alike when the mount is
 * absent. Production callers keep `requireMount=true`, which proves the path
 * is a mount boundary by comparing it with its parent device.
 */
export async function preflightFilesystemArchiveMount(input: {
  coldDirectory: string;
  hotDirectory: string;
  requireMount: boolean;
  minimumAvailableBytes?: number;
  writeProbe?: boolean;
}): Promise<FilesystemArchiveMountPreflightResult> {
  const root = resolve(input.coldDirectory);
  const hot = resolve(input.hotDirectory);
  if (root === hot || root.startsWith(`${hot}/`) || hot.startsWith(`${root}/`)) throw remoteError("archive_cold_hot_path_overlap");
  const coldStat = await fs.lstat(root).catch((error: unknown) => {
    throw remoteError(errorCode(error) === "ENOENT" ? "archive_cold_mount_missing" : "archive_cold_mount_unavailable");
  });
  if (!coldStat.isDirectory() || coldStat.isSymbolicLink()) throw remoteError("archive_cold_mount_invalid");
  if (((coldStat.mode & 0o777) & ~0o700) !== 0) throw remoteError("archive_cold_mount_permissions_invalid");
  const parentStat = await fs.stat(dirname(root));
  if (input.requireMount && coldStat.dev === parentStat.dev) throw remoteError("archive_cold_mount_identity_invalid");
  await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
  const filesystem = await fs.statfs(root);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < (input.minimumAvailableBytes ?? 1)) {
    throw remoteError("archive_cold_mount_space_insufficient");
  }
  if (input.writeProbe ?? true) await verifySeekAndWrite(root);
  return { root, device: coldStat.dev, filesystemType: Number(filesystem.type), availableBytes, mountRequired: input.requireMount };
}

async function verifySeekAndWrite(root: string): Promise<void> {
  const path = resolve(root, `.friday-archive-probe-${process.pid}-${Date.now()}`);
  const expected = Buffer.from("friday-archive-range-probe", "utf8");
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path, "wx", 0o600);
    await handle.write(expected, 0, expected.length, 0);
    await handle.sync();
    await handle.close();
    handle = await fs.open(path, "r");
    const actual = Buffer.alloc(7);
    const read = await handle.read(actual, 0, actual.length, 7);
    if (read.bytesRead !== actual.length || !actual.equals(expected.subarray(7, 14))) throw remoteError("archive_cold_mount_range_read_invalid");
  } catch (error) {
    if (isArchiveError(error)) throw error;
    throw remoteError("archive_cold_mount_probe_failed");
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(path, { force: true }).catch(() => undefined);
  }
}

async function retryTransientRangeRead<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const code = errorCode(error);
      if (!code || !TRANSIENT_RANGE_READ_ERROR_CODES.has(code)) {
        if (isArchiveError(error) || code === "ENOENT") throw error;
        throw remoteError("archive_remote_read_failed");
      }
      const delayMs = RANGE_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw remoteError("archive_remote_read_failed");
      await sleep(delayMs);
    }
  }
}

function remoteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isLinkUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOSYS" || code === "ENOTSUP" || code === "EXDEV";
}

function isArchiveError(error: unknown): error is Error & { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("archive_"));
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
