// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/// <reference types="node" />
import * as fs from 'node:fs';
import * as path from 'node:path';

export function getScssFiles(): string[] {
  const srcFolder: string = path.join(__dirname, '../../src');
  const sourceFiles: string[] = [];

  const dirs: string[] = [''];
  for (const dir of dirs) {
    const dirents: fs.Dirent[] = fs.readdirSync(dir ? `${srcFolder}/${dir}` : srcFolder, {
      withFileTypes: true
    });
    for (const dirent of dirents) {
      const { name } = dirent;
      if (dirent.isDirectory()) {
        const subDir: string = dir ? `${dir}/${name}` : name;
        dirs.push(subDir);
      } else if (dirent.isFile()) {
        if (!name.startsWith('_') && (name.endsWith('.sass') || name.endsWith('.scss'))) {
          sourceFiles.push(dir ? `${dir}/${name}` : name);
        }
      }
    }
  }
  return sourceFiles;
}

export function validateSnapshots(dir: string, fileName: string): void {
  const originalExt: string = path.extname(fileName);
  const relativeDir: string = path.dirname(fileName);
  const fullDir: string = path.join(dir, relativeDir);
  const basename: string = path.basename(fileName, originalExt) + '.';
  const files: fs.Dirent[] = fs.readdirSync(fullDir, { withFileTypes: true });
  const filteredFiles: fs.Dirent[] = files.filter((file: fs.Dirent) => {
    return file.isFile() && file.name.startsWith(basename);
  });
  expect(filteredFiles.map((x) => x.name)).toMatchSnapshot(`files`);
  filteredFiles.forEach((file: fs.Dirent) => {
    if (!file.isFile() || !file.name.startsWith(basename)) {
      return;
    }
    const filePath: string = path.join(fullDir, file.name);
    const fileContents: string = fs.readFileSync(filePath, 'utf8');
    const normalizedFileContents: string = fileContents.replace(/\r/gm, '');
    expect(normalizedFileContents).toMatchSnapshot(`${file.name}`);
  });
}
