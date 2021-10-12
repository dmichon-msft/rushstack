// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Unique identifiers for messages reported by API Extractor during its analysis.
 *
 * @remarks
 *
 * These strings are possible values for the {@link ExtractorMessage.messageId} property
 * when the `ExtractorMessage.category` is {@link ExtractorMessageCategory.Extractor}.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const ExtractorMessageId = {
  /**
   * "The doc comment should not contain more than one release tag."
   */
  ExtraReleaseTag: 'ae-extra-release-tag',

  /**
   * "This symbol has another declaration with a different release tag."
   */
  DifferentReleaseTags: 'ae-different-release-tags',

  /**
   * "The symbol ___ is marked as ___, but its signature references ___ which is marked as ___."
   */
  IncompatibleReleaseTags: 'ae-incompatible-release-tags',

  /**
   * "___ is exported by the package, but it is missing a release tag (`@alpha`, `@beta`, `@public`, or `@internal`)."
   */
  MissingReleaseTag: 'ae-missing-release-tag',

  /**
   * "The `@packageDocumentation` comment must appear at the top of entry point *.d.ts file."
   */
  MisplacedPackageTag: 'ae-misplaced-package-tag',

  /**
   * "The symbol ___ needs to be exported by the entry point ___."
   */
  ForgottenExport: 'ae-forgotten-export',

  /**
   * "The name ___ should be prefixed with an underscore because the declaration is marked as `@internal`."
   */
  InternalMissingUnderscore: 'ae-internal-missing-underscore',

  /**
   * "Mixed release tags are not allowed for ___ because one of its declarations is marked as `@internal`."
   */
  InternalMixedReleaseTag: 'ae-internal-mixed-release-tag',

  /**
   * "The `@preapproved` tag cannot be applied to ___ because it is not a supported declaration type."
   */
  PreapprovedUnsupportedType: 'ae-preapproved-unsupported-type',

  /**
   * "The `@preapproved` tag cannot be applied to ___ without an `@internal` release tag."
   */
  PreapprovedBadReleaseTag: 'ae-preapproved-bad-release-tag',

  /**
   * "The `@inheritDoc` reference could not be resolved."
   */
  UnresolvedInheritDocReference: 'ae-unresolved-inheritdoc-reference',

  /**
   * "The `@inheritDoc` tag needs a TSDoc declaration reference; signature matching is not supported yet."
   *
   * @privateRemarks
   * In the future, we will implement signature matching so that you can write `{@inheritDoc}` and API Extractor
   * will find a corresponding member from a base class (or implemented interface).  Until then, the tag
   * always needs an explicit declaration reference such as `{@inhertDoc MyBaseClass.sameMethod}`.
   */
  UnresolvedInheritDocBase: 'ae-unresolved-inheritdoc-base',

  /**
   * "The `@inheritDoc` tag for ___ refers to its own declaration."
   */
  CyclicInheritDoc: 'ae-cyclic-inherit-doc',

  /**
   * "The `@link` reference could not be resolved."
   */
  UnresolvedLink: 'ae-unresolved-link',

  /**
   * "The doc comment for the property ___ must appear on the getter, not the setter."
   */
  SetterWithDocs: 'ae-setter-with-docs',

  /**
   * "The property ___ has a setter but no getter."
   */
  MissingGetter: 'ae-missing-getter'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace ExtractorMessageId {
  /**
   * "The doc comment should not contain more than one release tag."
   */
  export type ExtraReleaseTag = typeof ExtractorMessageId.ExtraReleaseTag;

  /**
   * "This symbol has another declaration with a different release tag."
   */
  export type DifferentReleaseTags = typeof ExtractorMessageId.DifferentReleaseTags;

  /**
   * "The symbol ___ is marked as ___, but its signature references ___ which is marked as ___."
   */
  export type IncompatibleReleaseTags = typeof ExtractorMessageId.IncompatibleReleaseTags;

  /**
   * "___ is exported by the package, but it is missing a release tag (`@alpha`, `@beta`, `@public`, or `@internal`)."
   */
  export type MissingReleaseTag = typeof ExtractorMessageId.MissingReleaseTag;

  /**
   * "The `@packageDocumentation` comment must appear at the top of entry point *.d.ts file."
   */
  export type MisplacedPackageTag = typeof ExtractorMessageId.MisplacedPackageTag;

  /**
   * "The symbol ___ needs to be exported by the entry point ___."
   */
  export type ForgottenExport = typeof ExtractorMessageId.ForgottenExport;

  /**
   * "The name ___ should be prefixed with an underscore because the declaration is marked as `@internal`."
   */
  export type InternalMissingUnderscore = typeof ExtractorMessageId.InternalMissingUnderscore;

  /**
   * "Mixed release tags are not allowed for ___ because one of its declarations is marked as `@internal`."
   */
  export type InternalMixedReleaseTag = typeof ExtractorMessageId.InternalMixedReleaseTag;

  /**
   * "The `@preapproved` tag cannot be applied to ___ because it is not a supported declaration type."
   */
  export type PreapprovedUnsupportedType = typeof ExtractorMessageId.PreapprovedUnsupportedType;

  /**
   * "The `@preapproved` tag cannot be applied to ___ without an `@internal` release tag."
   */
  export type PreapprovedBadReleaseTag = typeof ExtractorMessageId.PreapprovedBadReleaseTag;

  /**
   * "The `@inheritDoc` reference could not be resolved."
   */
  export type UnresolvedInheritDocReference = typeof ExtractorMessageId.UnresolvedInheritDocReference;

  /**
   * "The `@inheritDoc` tag needs a TSDoc declaration reference; signature matching is not supported yet."
   *
   * @privateRemarks
   * In the future, we will implement signature matching so that you can write `{@inheritDoc}` and API Extractor
   * will find a corresponding member from a base class (or implemented interface).  Until then, the tag
   * always needs an explicit declaration reference such as `{@inhertDoc MyBaseClass.sameMethod}`.
   */
  export type UnresolvedInheritDocBase = typeof ExtractorMessageId.UnresolvedInheritDocBase;

  /**
   * "The `@inheritDoc` tag for ___ refers to its own declaration."
   */
  export type CyclicInheritDoc = typeof ExtractorMessageId.CyclicInheritDoc;

  /**
   * "The `@link` reference could not be resolved."
   */
  export type UnresolvedLink = typeof ExtractorMessageId.UnresolvedLink;

  /**
   * "The doc comment for the property ___ must appear on the getter, not the setter."
   */
  export type SetterWithDocs = typeof ExtractorMessageId.SetterWithDocs;

  /**
   * "The property ___ has a setter but no getter."
   */
  export type MissingGetter = typeof ExtractorMessageId.MissingGetter;
}
export type ExtractorMessageId = typeof ExtractorMessageId[keyof typeof ExtractorMessageId];

export const allExtractorMessageIds: Set<string> = new Set<string>(Object.values(ExtractorMessageId));
