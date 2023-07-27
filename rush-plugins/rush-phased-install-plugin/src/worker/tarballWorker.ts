import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { parentPort } from 'node:worker_threads';

import { gunzipSync, type IDecompressResult } from './gunzipSync';

import type { IParseResult, ITarballExtractMessage, ITarballParseMessage } from '../types';

function handleMessage(message: ITarballParseMessage | ITarballExtractMessage | false): void {
  if (message === false) {
    parentPort!.off('message', handleMessage);
    process.exit(0);
  }

  const { buffer, integrity } = message;

  try {
    switch (message.type) {
      case 'parse':
        const { length } = message;
        const parseResult: IParseResult = processTarballInWorker(Buffer.from(buffer, 0, length), integrity);
        parentPort!.postMessage({ requestId: integrity, status: 'success', value: parseResult });
        return;
      case 'extract':
        const { folder, files } = message;
        const extractResult: boolean = extractTar(Buffer.from(buffer), files, folder);
        parentPort!.postMessage({ requestId: integrity, status: 'success', value: extractResult });
        return;
    }
  } catch (e) {
    parentPort!.postMessage({ requestId: integrity, status: 'error', error: e.toString() });
  }
}

parentPort!.on('message', handleMessage);

interface IFile {
  offset: number;
  mode: number;
  size: number;
}

const ZERO: number = '0'.charCodeAt(0);
const FILE_TYPE_DIRECTORY: number = '5'.charCodeAt(0);
const SEVEN: number = '7'.charCodeAt(0);
const SPACE: number = ' '.charCodeAt(0);
const SLASH: number = '/'.charCodeAt(0);
const BACKSLASH: number = '\\'.charCodeAt(0);
const FILE_TYPE_PAX_HEADER: number = 'x'.charCodeAt(0);

const USTAR_MAGIC: Buffer = Buffer.from('ustar', 'latin1');

const MODE_OFFSET: 100 = 100;
const FILE_SIZE_OFFSET: 124 = 124;
const CHECKSUM_OFFSET: 148 = 148;
const FILE_TYPE_OFFSET: 156 = 156;
const MAGIC_OFFSET: 257 = 257;
const PREFIX_OFFSET: 345 = 345;

// See TAR specification here: https://www.gnu.org/software/tar/manual/html_node/Standard.html
function parseTarball(buffer: Buffer): IParseResult {
  const files: Map<string, IFile> = new Map();

  let pathTrimmed: boolean = false;

  let mode: number = 0;
  let fileSize: number = 0;
  let fileType: number = 0;

  let prefix: string = '';
  let fileName: string = '';

  // If a PAX extended header record is encountered and has a path field, it overrides the next entry's path.
  let paxHeaderPath: string = '';
  let paxHeaderFileSize: number | undefined = undefined;

  let blockBytes: number = 0;

  let blockStart: number = 0;
  while (buffer[blockStart] !== 0) {
    // Parse out a TAR header. header size is 512 bytes.
    // The file type is a single byte at offset 156 in the header
    fileType = buffer[blockStart + FILE_TYPE_OFFSET];
    if (paxHeaderFileSize !== undefined) {
      fileSize = paxHeaderFileSize;
      paxHeaderFileSize = undefined;
    } else {
      // The file size is an octal number encoded as UTF-8. It is terminated by a NUL or space. Maximum length 12 characters.
      fileSize = parseOctal(blockStart + FILE_SIZE_OFFSET, 12);
    }

    // The total size will always be an integer number of 512 byte blocks.
    // Also include 1 block for the header itself.
    // eslint-disable-next-line no-bitwise
    blockBytes = (fileSize & ~0x1ff) + (fileSize & 0x1ff ? 1024 : 512);

    const expectedCheckSum: number = parseOctal(blockStart + CHECKSUM_OFFSET, 8);
    const actualCheckSum: number = checkSum(blockStart);
    if (expectedCheckSum !== actualCheckSum) {
      throw new Error(
        `Invalid checksum for TAR header at offset ${blockStart}. Expected ${expectedCheckSum}, got ${actualCheckSum}`
      );
    }

    if (
      buffer.compare(
        USTAR_MAGIC,
        0,
        USTAR_MAGIC.byteLength,
        blockStart + MAGIC_OFFSET,
        blockStart + MAGIC_OFFSET + USTAR_MAGIC.byteLength
      ) !== 0
    ) {
      throw new Error(
        `This parser only supports USTAR or GNU TAR archives. Found magic and version: ${buffer.toString(
          'latin1',
          blockStart + MAGIC_OFFSET,
          blockStart + MAGIC_OFFSET + 8
        )}`
      );
    }

    // Mark that the first path segment has not been removed.
    pathTrimmed = false;

    if (paxHeaderPath) {
      fileName = paxHeaderPath;

      // The PAX header only applies to the immediate next entry.
      paxHeaderPath = '';
    } else {
      // The full file path is an optional prefix at offset 345, followed by the file name at offset 0, separated by a '/'.
      // Both values are terminated by a NUL if not using the full length of the field.
      prefix = parseString(blockStart + PREFIX_OFFSET, 155);

      // If the prefix is present and did not contain a `/` or `\\`, then the prefix is the first path segment and should be dropped entirely.
      if (prefix && !pathTrimmed) {
        pathTrimmed = true;
        prefix = '';
      }

      // Get the base filename at offset 0, up to 100 characters (where the mode field begins).
      fileName = parseString(blockStart, MODE_OFFSET);

      if (prefix) {
        // If the prefix was not trimmed entirely (or absent), need to join with the remaining filename
        fileName = `${prefix}/${fileName}`;
      }
    }

    // Values '\0' and '0' are normal files.
    // Treat all other file types as non-existent
    // However, we still need to parse the name to handle collisions
    switch (fileType) {
      case 0:
      case ZERO:
        // The file mode is an octal number encoded as UTF-8. It is terminated by a NUL or space. Maximum length 8 characters.
        mode = parseOctal(blockStart + MODE_OFFSET, 8);

        // The TAR format is an append-only data structure; as such later entries with the same name supercede earlier ones.
        files.set(fileName, { offset: blockStart + 512, mode, size: fileSize });
        break;
      case FILE_TYPE_DIRECTORY:
        // Skip
        break;
      case FILE_TYPE_PAX_HEADER:
        parsePaxHeader(blockStart + 512, fileSize);
        break;
      default:
        throw new Error(`Unsupported file type ${fileType} for file ${fileName}.`);
    }

    // Move to the next record in the TAR archive.
    blockStart += blockBytes;
  }

  return { files, buffer: buffer.buffer };

  /**
   * Computes the checksum for the TAR header at the specified `offset`.
   * @param offset - The current offset into the tar buffer
   * @returns The header checksum
   */
  function checkSum(offset: number): number {
    let sum: number = 256;
    let i: number = offset;

    const checksumStart: number = offset + 148;
    const checksumEnd: number = offset + 156;
    const blockEnd: number = offset + 512;

    for (; i < checksumStart; i++) {
      sum += buffer[i];
    }

    for (i = checksumEnd; i < blockEnd; i++) {
      sum += buffer[i];
    }

    return sum;
  }

  /**
   * Parses a PAX header, which is a series of key/value pairs.
   *
   * @param offset - Offset into the buffer where the PAX header starts
   * @param length - Length of the PAX header, in bytes
   * @returns The path field, if present
   */
  function parsePaxHeader(offset: number, length: number): void {
    const end: number = offset + length;
    let i: number = offset;
    while (i < end) {
      const lineStart: number = i;
      while (i < end && buffer[i] !== SPACE) {
        i++;
      }

      // The format of a PAX header line is "%d %s=%s\n"
      const strLen: string = buffer.toString('utf-8', lineStart, i);
      const len: number = parseInt(strLen, 10);
      if (!len) {
        throw new Error(`Invalid length in PAX record: ${strLen}`);
      }

      // Skip the space.
      i++;

      const lineEnd: number = lineStart + len;

      const record: string = buffer.toString('utf-8', i, lineEnd - 1);
      i = lineEnd;

      const equalSign: number = record.indexOf('=');
      const keyword: string = record.slice(0, equalSign);
      // eslint-disable-next-line no-console
      if (keyword === 'path') {
        // Still need to trim the first path segment.
        const slashIndex: number = record.indexOf('/', equalSign + 1);
        paxHeaderPath = record.slice(slashIndex >= 0 ? slashIndex + 1 : equalSign + 1);
      } else if (keyword === 'size') {
        const size: number = parseInt(record.slice(equalSign + 1), 10);
        if (isNaN(size) || size < 0) {
          throw new Error(`Invalid size in PAX record: ${record}`);
        }
        paxHeaderFileSize = size;
      } else {
        // Ignore. Not relevant.
        continue;
      }
    }
  }

  /**
   * Parses a UTF-8 string at the specified `offset`, up to `length` characters. If it ends early, it will be terminated by a NUL.
   * Will trim the first segment if `pathTrimmed` is currently false and the string contains a `/` or `\\`.
   */
  function parseString(offset: number, length: number): string {
    let end: number = offset;
    const max: number = length + offset;
    for (let char: number = buffer[end]; char !== 0 && end !== max; char = buffer[++end]) {
      if (!pathTrimmed && (char === SLASH || char === BACKSLASH)) {
        pathTrimmed = true;
        offset = end + 1;
      }
    }
    return buffer.toString('utf8', offset, end);
  }

  /**
   * Parses an octal number at the specified `offset`, up to `length` characters. If it ends early, it will be terminated by either
   * a NUL or a space.
   */
  function parseOctal(offset: number, length: number): number {
    let position: number = offset;
    const max: number = length + offset;
    let value: number = 0;
    for (
      let char: number = buffer[position];
      char !== 0 && char !== SPACE && position !== max;
      char = buffer[++position]
    ) {
      if (char < ZERO || char > SEVEN) {
        throw new Error(`Invalid character in octal string: ${String.fromCharCode(char)}`);
      }
      // eslint-disable-next-line no-bitwise
      value <<= 3;
      // eslint-disable-next-line no-bitwise
      value |= char - ZERO;
    }
    return value;
  }
  // eslint-enable no-var
}

const INTEGRITY_REGEX: RegExp = /^([^-]+)-([A-Za-z0-9+\/=]+)$/;

function processTarballInWorker(buffer: Buffer, remoteIntegrity: string | undefined): IParseResult {
  if (remoteIntegrity) {
    const [, algo, integrityHash] = remoteIntegrity.match(INTEGRITY_REGEX)!;
    // Compensate for the possibility of non-uniform Base64 padding
    const normalizedRemoteHash: string = Buffer.from(integrityHash, 'base64').toString('hex');

    const calculatedHash: string = crypto.createHash(algo).update(buffer).digest('hex');
    if (calculatedHash !== normalizedRemoteHash) {
      throw new Error(
        `integrity validation failed:\nintegrity: ${remoteIntegrity}\nexpected: ${normalizedRemoteHash}\nreceived: ${calculatedHash}`
      );
    }
  } else {
    throw new Error('remote does not have an integrity');
  }

  const tarContent: IDecompressResult = gunzipSync(buffer);
  const sharedBuffer: Buffer = Buffer.from(new SharedArrayBuffer(tarContent.totalBytes));
  let offset: number = 0;
  for (const segment of tarContent.buffers) {
    segment.copy(sharedBuffer, offset);
    offset += segment.byteLength;
  }

  return parseTarball(sharedBuffer);
}

/**
 * Extracts the files in the tar archive to the specified folder using synchronous I/O.
 * The reason for using synchronous rather than asynchronous I/O operations is that the implementation
 * of NodeJS's `fs` modules is ultimately synchronous, just hidden by its own thread pool.
 *
 * @param buffer - The raw contents of the tar archive
 * @param files - The index of the tar archive
 * @param folder - The folder to unpack files to
 * @returns true
 */
function extractTar(buffer: Buffer, files: Iterable<[string, IFile]>, folder: string): boolean {
  const createdFolders: Set<string> = new Set();

  for (const [relativePath, { mode, offset, size }] of files) {
    const lastSlashIndex: number = relativePath.lastIndexOf('/');
    const targetDir: string =
      lastSlashIndex >= 0 ? `${folder}/${relativePath.slice(0, lastSlashIndex)}` : folder;
    const targetPath: string = `${folder}/${relativePath}`;

    if (!createdFolders.has(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      createdFolders.add(targetDir);
    }

    const fd: number = fs.openSync(targetPath, 'w', mode);
    try {
      let written: number = 0;
      while (written < size) {
        written += fs.writeSync(fd, buffer, offset + written, size - written, written);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  return true;
}
