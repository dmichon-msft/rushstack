// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { LookupByPath } from '../LookupByPath';

describe('findChildPath', () => {
  it('returns empty for an empty tree', () => {
    expect(new LookupByPath().findChildPath('foo')).toEqual(undefined);
  });
  it('returns the matching node for a trivial tree', () => {
    expect(new LookupByPath([['foo', 1]]).findChildPath('foo')?.value).toEqual(1);
  });
  it('returns the matching node for a single-layer tree', () => {
    const tree: LookupByPath<number> = new LookupByPath([
      ['foo', 1],
      ['bar', 2],
      ['baz', 3]
    ]);

    expect(tree.findChildPath('foo')?.value).toEqual(1);
    expect(tree.findChildPath('bar')?.value).toEqual(2);
    expect(tree.findChildPath('baz')?.value).toEqual(3);
    expect(tree.findChildPath('buzz')?.value).toEqual(undefined);
  });
  it('returns the matching parent for multi-layer queries', () => {
    const tree: LookupByPath<number> = new LookupByPath([
      ['foo', 1],
      ['bar', 2],
      ['baz', 3]
    ]);

    expect(tree.findChildPath('foo/bar')?.value).toEqual(1);
    expect(tree.findChildPath('bar/baz')?.value).toEqual(2);
    expect(tree.findChildPath('baz/foo')?.value).toEqual(3);
    expect(tree.findChildPath('foo/foo')?.value).toEqual(1);
  });
  it('returns the matching parent for multi-layer queries in multi-layer trees', () => {
    const tree: LookupByPath<number> = new LookupByPath([
      ['foo', 1],
      ['bar', 2],
      ['baz', 3],
      ['foo/bar', 4],
      ['foo/bar/baz', 5],
      ['baz/foo', 6],
      ['baz/baz/baz/baz', 7]
    ]);

    expect(tree.findChildPath('foo/foo')?.value).toEqual(1);
    expect(tree.findChildPath('foo/bar\\baz')?.value).toEqual(1);

    expect(tree.findChildPath('bar/baz')?.value).toEqual(2);

    expect(tree.findChildPath('baz/bar')?.value).toEqual(3);
    expect(tree.findChildPath('baz/baz')?.value).toEqual(3);
    expect(tree.findChildPath('baz/baz/baz')?.value).toEqual(3);

    expect(tree.findChildPath('foo/bar')?.value).toEqual(4);
    expect(tree.findChildPath('foo/bar/foo')?.value).toEqual(4);

    expect(tree.findChildPath('foo/bar/baz')?.value).toEqual(5);
    expect(tree.findChildPath('foo/bar/baz/baz/baz/baz/baz')?.value).toEqual(5);

    expect(tree.findChildPath('baz/foo/')?.value).toEqual(6);

    expect(tree.findChildPath('baz/baz/baz/baz')?.value).toEqual(7);

    expect(tree.findChildPath('')).toEqual(undefined);
    expect(tree.findChildPath('foofoo')).toEqual(undefined);
    expect(tree.findChildPath('foo\\bar\\baz')).toEqual(undefined);
  });
  it('handles custom delimiters', () => {
    const tree: LookupByPath<number> = new LookupByPath(
      [
        ['foo,bar', 1],
        ['foo/bar', 2]
      ],
      ','
    );

    expect(tree.findChildPath('foo/bar,baz')?.value).toEqual(2);
    expect(tree.findChildPath('foo,bar/baz')?.value).toEqual(undefined);
    expect(tree.findChildPath('foo,bar,baz')?.value).toEqual(1);
  });
});
