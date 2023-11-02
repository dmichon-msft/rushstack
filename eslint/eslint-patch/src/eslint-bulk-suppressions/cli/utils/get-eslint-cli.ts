import path from 'path';

const SUPPORTED_VERSIONS = ['8.6.0', '8.7.0', '8.21.0', '8.22.0', '8.23.0', '8.23.1'];

export function getEslintCli(packagePath: string): string {
  // Try to find a local ESLint installation, the one that should be listed as a dev dependency in package.json
  // and installed in node_modules
  try {
    const localEslintApiPath = require.resolve('eslint', { paths: [packagePath] });
    const localEslintPath = path.dirname(path.dirname(localEslintApiPath));
    const eslintPackageJson = require(path.join(localEslintPath, 'package.json'));
    const localEslintVersion = eslintPackageJson.version;
    const eslintExecutable = path.join(localEslintPath, 'bin', 'eslint.js');

    if (!SUPPORTED_VERSIONS.includes(localEslintVersion)) {
      throw new Error(
        `@rushstack/eslint-bulk: Unable to find a supported local ESLint installation. Supported versions are ${SUPPORTED_VERSIONS.join(
          ', '
        )}`
      );
    }
    return `node ${eslintExecutable}`;
  } catch (e) {
    throw new Error(
      '@rushstack/eslint-bulk: eslint is specified as a dev dependency in package.json, but eslint-bulk cannot find it in node_modules.'
    );
  }
}
