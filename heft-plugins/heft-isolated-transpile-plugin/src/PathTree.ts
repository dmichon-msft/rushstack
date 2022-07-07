// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * A node in the path tree used in PathTree
 */
interface IPathTreeNode<TItem> {
  /**
   * The full path to this item
   */
  fullPath: string;
  /**
   * The value that exactly matches the current relative path
   */
  value: TItem | undefined;
  /**
   * Child nodes by subfolder
   */
  children: Map<string, IPathTreeNode<TItem>> | undefined;
}

/**
 * This class is used to associate POSIX relative paths, such as those returned by `git` commands,
 * with entities that correspond with ancestor folders, such as Rush Projects.
 *
 * It is optimized for efficiently locating the nearest ancestor path with an associated value.
 *
 * @example
 * ```ts
 * const tree = new PathTree([['foo', 1], ['bar', 2], ['foo/bar', 3]]);
 * tree.findChildPath('foo'); // returns 1
 * tree.findChildPath('foo/baz'); // returns 1
 * tree.findChildPath('baz'); // returns undefined
 * tree.findChildPath('foo/bar/baz'); returns 3
 * tree.findChildPath('bar/foo/bar'); returns 2
 * ```
 * @beta
 */
export class PathTree<TItem> {
  /**
   * The delimiter used to split paths
   */
  public readonly delimiter: string;
  /**
   * The root node of the tree, corresponding to the path ''
   */
  private readonly _root: IPathTreeNode<TItem>;

  /**
   * Constructs a new `PathTree`
   *
   * @param entries - Initial path-value pairs to populate the tree.
   */
  public constructor(entries?: Iterable<[string, TItem]>, delimiter?: string) {
    this._root = {
      fullPath: '',
      value: undefined,
      children: undefined
    };

    this.delimiter = delimiter ?? '/';

    if (entries) {
      for (const [path, item] of entries) {
        this.setItem(path, item);
      }
    }
  }

  /**
   * Iterates over the segments of a serialized path.
   *
   * @example
   *
   * `PathTree.iteratePathSegments('foo/bar/baz')` yields 'foo', 'bar', 'baz'
   *
   * `PathTree.iteratePathSegments('foo\\bar\\baz', '\\')` yields 'foo', 'bar', 'baz'
   */
  public static *iteratePathSegments(serializedPath: string, delimiter: string = '/'): Iterable<string> {
    if (!serializedPath) {
      return;
    }

    let nextIndex: number = serializedPath.indexOf(delimiter);
    let previousIndex: number = 0;
    while (nextIndex >= 0) {
      yield serializedPath.slice(previousIndex, nextIndex);

      previousIndex = nextIndex + 1;
      nextIndex = serializedPath.indexOf(delimiter, previousIndex);
    }

    if (previousIndex + 1 < serializedPath.length) {
      yield serializedPath.slice(previousIndex);
    }
  }

  /**
   * Associates the value with the specified serialized path.
   * If a value is already associated, will overwrite.
   *
   * @returns this, for chained calls
   */
  public setItem(serializedPath: string, value: TItem): this {
    return this.setItemFromSegments(PathTree.iteratePathSegments(serializedPath, this.delimiter), value);
  }

  /**
   * Associates the value with the specified path.
   * If a value is already associated, will overwrite.
   *
   * @returns this, for chained calls
   */
  public setItemFromSegments(pathSegments: Iterable<string>, value: TItem): this {
    let node: IPathTreeNode<TItem> = this._root;
    let fullPath: string = '';
    for (const segment of pathSegments) {
      fullPath += this.delimiter + segment;
      if (!node.children) {
        node.children = new Map();
      }
      let child: IPathTreeNode<TItem> | undefined = node.children.get(segment);
      if (!child) {
        node.children.set(
          segment,
          (child = {
            fullPath,
            value: undefined,
            children: undefined
          })
        );
      }
      node = child;
    }
    node.value = value;

    return this;
  }

  /**
   * Searches for the item associated with `childPath`, or the nearest ancestor of that path that
   * has an associated item.
   *
   * @returns the found item, or `undefined` if no item was found
   *
   * @example
   * ```ts
   * const tree = new PathTree([['foo', 1], ['foo/bar', 2]]);
   * tree.findChildPath('foo/baz'); // returns 1
   * tree.findChildPath('foo/bar/baz'); // returns 2
   * ```
   */
  public findChildPath(childPath: string): TItem | undefined {
    return this.findChildPathFromSegments(PathTree.iteratePathSegments(childPath, this.delimiter));
  }

  /**
   * Searches for the item associated with `childPathSegments`, or the nearest ancestor of that path that
   * has an associated item.
   *
   * @returns the found item, or `undefined` if no item was found
   *
   * @example
   * ```ts
   * const tree = new PathTree([['foo', 1], ['foo/bar', 2]]);
   * tree.findChildPathFromSegments(['foo', 'baz']); // returns 1
   * tree.findChildPathFromSegments(['foo','bar', 'baz']); // returns 2
   * ```
   */
  public findChildPathFromSegments(childPathSegments: Iterable<string>): TItem | undefined {
    let node: IPathTreeNode<TItem> = this._root;
    let best: TItem | undefined = node.value;
    // Trivial cases
    if (node.children) {
      for (const segment of childPathSegments) {
        const child: IPathTreeNode<TItem> | undefined = node.children.get(segment);
        if (!child) {
          break;
        }
        node = child;
        best = node.value ?? best;
        if (!node.children) {
          break;
        }
      }
    }

    return best;
  }

  /**
   * Iterates over all leaf nodes in the tree, i.e. all nodes that do not have children.
   * If the tree is populated with file paths, this will be a list of all file paths.
   */
  public iterateLeafNodes(): Iterable<[string, TItem]> {
    return this._iterateLeafNodes(this._root);
  }

  /**
   * Iterates over all nodes in the tree that have children but not grandchildren.
   * If the tree is populated with file paths, this will be a list of all parent directories.
   */
  public iterateParentNodes(): Iterable<string> {
    return this._iterateParentNodes(this._root);
  }

  private *_iterateLeafNodes(node: IPathTreeNode<TItem>): Iterable<[string, TItem]> {
    if (node.children) {
      for (const child of node.children.values()) {
        yield* this._iterateLeafNodes(child);
      }
    } else {
      yield [node.fullPath, node.value!];
    }
  }

  private *_iterateParentNodes(node: IPathTreeNode<TItem>): Iterable<string> {
    if (node.children) {
      let hasGrandChildren: boolean = false;
      for (const child of node.children.values()) {
        if (child.children) {
          yield* this._iterateParentNodes(child);
          hasGrandChildren = true;
        }
      }

      if (!hasGrandChildren) {
        yield node.fullPath;
      }
    }
  }
}
