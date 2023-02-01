// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'fs';
import * as path from 'path';

function findSourcePath(testPath: string, snapshotExtension: string): string {
  const sourceMapFilePath: string = `${testPath}.map`;
  let sourceFilePath: string = testPath;
  try {
    const sourceMapContent: string = fs.readFileSync(sourceMapFilePath, 'utf-8');
    const {
      sources: [sourcePath]
    } = JSON.parse(sourceMapContent);
    sourceFilePath = path.resolve(path.dirname(testPath), sourcePath);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      throw err;
    }
  }

  const { dir, base } = path.parse(sourceFilePath);
  return path.resolve(dir, '__snapshots__', base + snapshotExtension);
}

const testToSnapshotCache: Map<string, string> = new Map();
const snapshotToTestCache: Map<string, string> = new Map();

const srcDirFromEnv: string | undefined = process.env.JEST_HEFT_SRC_DIR;
const testDirFromEnv: string | undefined = process.env.JEST_HEFT_TEST_DIR;

const snapshotResolver = {
  resolveSnapshotPath(testPath: string, snapshotExtension: string): string {
    testPath = path.normalize(testPath);
    let cachedPath: string | undefined = testToSnapshotCache.get(testPath);
    if (!cachedPath) {
      cachedPath = findSourcePath(testPath, snapshotExtension);
      testToSnapshotCache.set(testPath, cachedPath);
      snapshotToTestCache.set(cachedPath, testPath);
    }
    return cachedPath;
  },

  resolveTestPath(snapshotFilePath: string, snapshotExtension: string): string {
    snapshotFilePath = path.normalize(snapshotFilePath);
    const fromCache: string | undefined = snapshotToTestCache.get(snapshotFilePath);
    if (!fromCache) {
      if (srcDirFromEnv && testDirFromEnv) {
        const { dir, base } = path.parse(snapshotFilePath);
        const parentDir: string = path.dirname(dir);
        const sourceFilePath: string = path.join(parentDir, base.slice(0, -snapshotExtension.length));
        const testFilePath: string = sourceFilePath
          .replace(srcDirFromEnv, testDirFromEnv)
          .replace(/\.tsx?$/, '.js');
        snapshotToTestCache.set(snapshotFilePath, testFilePath);
        return testFilePath;
      } else {
        throw new Error(`Expected snapshot lookup to happen first for ${snapshotFilePath}`);
      }
    }
    return fromCache;
  },

  testPathForConsistencyCheck: path.normalize('/home/rushstack/heft/lib/jest/test.js')
};

export default snapshotResolver;
