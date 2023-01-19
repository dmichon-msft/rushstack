import * as fs from 'fs';
import * as path from 'path';

import { FileSystem, Path } from '@rushstack/node-core-library';
import { CancellationToken } from '../pluginFramework/CancellationToken';

export interface IDirectoryWatcherOptions {
  rootPath: string;
  cancellationToken: CancellationToken;
  debounceTimeoutMs?: number;
  filter?: (path: string) => boolean;
}

export interface ITimeData {
  files: ReadonlyMap<string, number>;
  maxTime: number;
}

interface IFileSystemOperation {
  (node: ITreeNode): Promise<void>;
}

interface ITreeNode {
  mtime: number;

  parent: ITreeNode | undefined;
  path: string;

  scantime: number;
  items: Map<string, ITreeNode> | undefined;
}

export function computeDiff(
  newState: ReadonlyMap<string, number>,
  oldState: ReadonlyMap<string, number> | undefined
): ReadonlyMap<string, number | undefined> {
  const diff: Map<string, number | undefined> = new Map();
  if (!oldState) {
    for (const [key, value] of newState) {
      diff.set(key, value);
    }
  } else {
    for (const [key, value] of newState) {
      const old: number | undefined = oldState.get(key);
      if (value !== old) {
        diff.set(key, value);
      }
    }

    for (const [key, oldValue] of oldState) {
      const newValue: number | undefined = newState.get(key);
      if (oldValue !== newValue) {
        diff.set(key, newValue);
      }
    }
  }

  return diff;
}

export function computeHasChanged(
  newState: ReadonlyMap<string, number>,
  oldState: ReadonlyMap<string, number>
): boolean {
  if (newState.size !== oldState.size) {
    return true;
  }

  for (const [key, value] of newState) {
    const old: number | undefined = oldState.get(key);
    if (value !== old) {
      return true;
    }
  }

  for (const [key, oldValue] of oldState) {
    const newValue: number | undefined = newState.get(key);
    if (oldValue !== newValue) {
      return true;
    }
  }

  return false;
}

export async function* watchForChangesAsync(
  options: IDirectoryWatcherOptions
): AsyncIterableIterator<ITimeData> {
  const { filter, debounceTimeoutMs = 250, rootPath: rawRoot, cancellationToken } = options;

  const normalizedRoot: string = Path.convertToSlashes(rawRoot);
  const rootPrefix: string = normalizedRoot + '/';

  const rootNode: ITreeNode = {
    mtime: -1,
    parent: undefined,
    path: normalizedRoot,
    items: new Map(),
    scantime: -2
  };

  const pendingScans: Set<ITreeNode> = new Set();
  const pendingStats: Set<ITreeNode> = new Set();

  let globalScanPending: boolean = true;

  let operationTimeout: NodeJS.Timeout | undefined;

  function collectTimes(): ITimeData {
    const files: Map<string, number> = new Map();

    const maxTime: number = collectTimesInternal(files, rootNode);

    return {
      files,
      maxTime
    };
  }

  function* iteratePrefixes(filePath: string): IterableIterator<string> {
    if (!filePath.startsWith(rootPrefix)) {
      throw new Error(`Unexpected file path: ${filePath} not under ${rootPrefix}`);
    }

    let start: number = rootPrefix.length;
    let slashIndex: number = filePath.indexOf('/', start);
    while (slashIndex > 0) {
      const prefix: string = filePath.slice(0, slashIndex);
      yield prefix;
      start = slashIndex + 1;
      slashIndex = filePath.indexOf('/', start);
    }
    yield filePath;
  }

  function getNodeFor(filePath: string): ITreeNode {
    let node: ITreeNode = rootNode;
    if (filePath === normalizedRoot) {
      return node;
    }

    for (const prefix of iteratePrefixes(filePath)) {
      if (!node.items) {
        node.items = new Map();
      }
      const { items } = node;

      let child: ITreeNode | undefined = items.get(prefix);
      if (!child) {
        items.set(
          prefix,
          (child = {
            mtime: -1,
            parent: node,
            path: prefix,
            items: undefined,
            scantime: -2
          })
        );
      }
      node = child;
    }

    return node;
  }

  function collectTimesInternal(fileTimes: Map<string, number>, node: ITreeNode): number {
    const { items } = node;
    let maxTime: number = node.mtime;
    if (items) {
      for (const child of items.values()) {
        maxTime = Math.max(maxTime, collectTimesInternal(fileTimes, child));
      }
    } else {
      fileTimes.set(node.path, maxTime);
    }

    return maxTime;
  }

  async function scan(rawNode: ITreeNode): Promise<void> {
    if (operationTimeout !== undefined) {
      throw interruptError;
    }
    pendingScans.delete(rawNode);

    const node: ITreeNode = rawNode;
    const dir: string = node.path;
    if (dir === normalizedRoot) {
      globalScanPending = false;
    }

    const now: number = Date.now();

    try {
      const entries: ReadonlyArray<fs.Dirent> = await fs.promises.readdir(dir, {
        encoding: 'utf-8',
        withFileTypes: true
      });

      const oldItems: Map<string, ITreeNode> | undefined = node.items;

      const items: Map<string, ITreeNode> = (node.items = new Map());
      node.mtime = now;

      for (const entry of entries) {
        const { name } = entry;
        const fullPath: string = `${dir}/${name}`;
        if (filter && !filter(fullPath)) {
          continue;
        }

        let child: ITreeNode | undefined = oldItems?.get(fullPath);
        items.set(
          fullPath,
          (child = {
            mtime: -1,
            parent: node,
            path: fullPath,
            items: undefined,
            scantime: -2
          })
        );

        pendingStats.add(child);
        if (entry.isDirectory() && child.scantime <= child.mtime) {
          pendingScans.add(child);
        }
      }
    } catch (err) {
      if (!FileSystem.isNotExistError(err)) {
        pendingScans.add(node);
      }

      node.parent?.items!.delete(node.path);
    }
  }

  async function stat(rawNode: ITreeNode): Promise<void> {
    if (operationTimeout !== undefined) {
      throw interruptError;
    }
    pendingStats.delete(rawNode);

    const node: ITreeNode = rawNode;
    const file: string = node.path;
    try {
      const stats: fs.Stats = await fs.promises.lstat(file);
      const mtimeMs: number = stats.mtimeMs || stats.ctimeMs || Date.now();
      node.mtime = mtimeMs;
      if (stats.isDirectory()) {
        if (!node.items) {
          node.items = new Map();
        }
        if (node.scantime <= mtimeMs) {
          pendingScans.add(node);
        }
      } else {
        node.items = undefined;
      }
    } catch (err) {
      if (!FileSystem.isNotExistError(err)) {
        pendingStats.add(node);
        return;
      }

      node.parent?.items!.delete(node.path);
    }
  }

  const interruptError: Error = new Error(
    `The watcher emitted a new change while invoking file system operations. Aborting.`
  );

  let resolveChangePromise: () => void;
  let changePromise: Promise<void> = createChangePromise();

  function createChangePromise(): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
      resolveChangePromise = resolve;
    });
  }

  function wrappedResolveChangePromise(): void {
    resolveChangePromise();
    clearTimeout(operationTimeout!);
    operationTimeout = undefined;
  }

  function onChange(event: string, fileName: string): void {
    let isSignificant: boolean = false;
    if (!fileName) {
      globalScanPending = true;
      isSignificant = true;
      pendingScans.clear();
      pendingStats.clear();
      pendingScans.add(rootNode);
    } else if (!globalScanPending) {
      const filePath: string = Path.convertToSlashes(path.resolve(normalizedRoot, fileName));
      isSignificant = !filter || filter(filePath);
      if (isSignificant) {
        const node: ITreeNode = getNodeFor(filePath);
        pendingStats.add(node);
      }
    }

    if (operationTimeout) {
      clearTimeout(operationTimeout);
    }
    if (isSignificant || operationTimeout) {
      operationTimeout = setTimeout(wrappedResolveChangePromise, debounceTimeoutMs);
    }
  }

  async function waitForFSOperations(): Promise<void> {
    while (pendingScans.size > 0 || pendingStats.size > 0) {
      const block: Promise<void>[] = [...Array.from(pendingScans, scan), ...Array.from(pendingStats, stat)];
      // TODO: restructure this into a proper async parallel queue.
      await Promise.all(block);
    }
  }

  pendingScans.add(rootNode);

  await waitForFSOperations();

  const watcher: fs.FSWatcher = fs.watch(
    normalizedRoot,
    {
      encoding: 'utf-8',
      persistent: true,
      recursive: true
    },
    onChange
  );

  let lastTimes: ITimeData = collectTimes();
  yield lastTimes;

  while (!cancellationToken.isCancelled) {
    await Promise.race([cancellationToken.onCancelledPromise, changePromise]);
    changePromise = createChangePromise();

    try {
      await waitForFSOperations();
    } catch (err) {
      continue;
    }

    const times: ITimeData = collectTimes();
    if (times.maxTime > lastTimes.maxTime) {
      // Don't emit a change if nothing of consequence occurred
      yield times;
      lastTimes = times;
    }
  }

  watcher.close();
}
