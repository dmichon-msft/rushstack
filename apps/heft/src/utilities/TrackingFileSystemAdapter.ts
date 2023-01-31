import * as fs from 'fs';
import * as path from 'path';

import type { ReaddirAsynchronousMethod, ReaddirSynchronousMethod } from '@nodelib/fs.scandir';
import type { StatAsynchronousMethod, StatSynchronousMethod } from '@nodelib/fs.stat';
import type { FileSystemAdapter } from 'fast-glob';

interface IReaddirOptions {
  withFileTypes: true;
}

/* eslint-disable @rushstack/no-new-null */
type StatCallback = (error: NodeJS.ErrnoException | null, stats: fs.Stats) => void;
type ReaddirStringCallback = (error: NodeJS.ErrnoException | null, files: string[]) => void;
type ReaddirDirentCallback = (error: NodeJS.ErrnoException | null, files: fs.Dirent[]) => void;
/* eslint-enable @rushstack/no-new-null */

export interface ITrackedFileSystemData {
  /**
   * File system entries that exist, mapped to their last modified times.
   */
  files: Map<string, number>;
  /**
   * Folders that were scanned, mapped to their last scan times.
   */
  contexts: Map<string, number>;
  /**
   * File system entries that were queried but did not exist, mapped to the last check time.
   */
  missing: Map<string, number>;
}

/**
 * A filesystem adapter for use with the "fast-glob" package. This adapter tracks file system accesses
 * to initialize `watchpack`.
 */
export class TrackingFileSystemAdapter implements FileSystemAdapter {
  public files: Map<string, number> = new Map();
  public contexts: Map<string, number> = new Map();
  public missing: Map<string, number> = new Map();

  /** { @inheritdoc fs.readdirSync } */
  public readdirSync: ReaddirSynchronousMethod = ((filePath: string, options?: IReaddirOptions) => {
    filePath = path.normalize(filePath);

    try {
      if (options?.withFileTypes) {
        const results: fs.Dirent[] = fs.readdirSync(filePath, options);
        this.contexts.set(filePath, Date.now());
        return results;
      } else {
        const results: string[] = fs.readdirSync(filePath);
        this.contexts.set(filePath, Date.now());
        return results;
      }
    } catch (err) {
      this.missing.set(filePath, Date.now());
      throw err;
    }
  }) as ReaddirSynchronousMethod;

  /** { @inheritdoc fs.readdir } */
  public readdir: ReaddirAsynchronousMethod = (
    filePath: string,
    optionsOrCallback: IReaddirOptions | ReaddirStringCallback,
    callback?: ReaddirDirentCallback | ReaddirStringCallback
  ) => {
    filePath = path.normalize(filePath);
    // Default to no options, which will return a string callback
    let options: IReaddirOptions | undefined;
    if (typeof optionsOrCallback === 'object') {
      options = optionsOrCallback;
    } else if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    }

    if (options?.withFileTypes) {
      fs.readdir(filePath, options, (err: NodeJS.ErrnoException | null, entries: fs.Dirent[]) => {
        if (err) {
          this.missing.set(filePath, Date.now());
        } else {
          this.contexts.set(filePath, Date.now());
        }
        (callback as ReaddirDirentCallback)(err, entries);
      });
    } else {
      fs.readdir(filePath, (err: NodeJS.ErrnoException | null, entries: string[]) => {
        if (err) {
          this.missing.set(filePath, Date.now());
        } else {
          this.contexts.set(filePath, Date.now());
        }
        (callback as ReaddirStringCallback)(err, entries);
      });
    }
  };

  /** { @inheritdoc fs.lstat } */
  public lstat: StatAsynchronousMethod = (filePath: string, callback: StatCallback): void => {
    filePath = path.normalize(filePath);
    fs.lstat(filePath, (err: NodeJS.ErrnoException | null, stats: fs.Stats) => {
      if (err) {
        this.missing.set(filePath, Date.now());
      } else {
        this.files.set(filePath, stats.mtimeMs || stats.ctimeMs || Date.now());
      }
      callback(err, stats);
    });
  };

  /** { @inheritdoc fs.lstatSync } */
  public lstatSync: StatSynchronousMethod = (filePath: string): fs.Stats => {
    filePath = path.normalize(filePath);
    try {
      const stats: fs.Stats = fs.lstatSync(filePath);
      this.files.set(filePath, stats.mtimeMs || stats.ctimeMs || Date.now());
      return stats;
    } catch (err) {
      this.missing.set(filePath, Date.now());
      throw err;
    }
  };

  /** { @inheritdoc fs.stat } */
  public stat: StatAsynchronousMethod = (filePath: string, callback: StatCallback): void => {
    filePath = path.normalize(filePath);
    fs.stat(filePath, (err: NodeJS.ErrnoException | null, stats: fs.Stats) => {
      if (err) {
        this.missing.set(filePath, Date.now());
      } else {
        this.files.set(filePath, stats.mtimeMs || stats.ctimeMs || Date.now());
      }
      callback(err, stats);
    });
  };

  /** { @inheritdoc fs.statSync } */
  public statSync: StatSynchronousMethod = (filePath: string) => {
    filePath = path.normalize(filePath);
    try {
      const stats: fs.Stats = fs.statSync(filePath);
      this.files.set(filePath, stats.mtimeMs || stats.ctimeMs || Date.now());
      return stats;
    } catch (err) {
      this.missing.set(filePath, Date.now());
      throw err;
    }
  };
}
