module.exports = {
  mode: 'none', // Don't minify: minification of prettier breaks its parsing of SCSS
  entry: {
    heft: `${__dirname}/node_modules/@rushstack/heft/lib/start.js`,
    startSubprocess: `${__dirname}/node_modules/@rushstack/heft/lib/utilities/subprocess/startSubprocess.js`
  },
  externals: {
    fsevents: 'commonjs fsevents'
  },
  output: {
    path: `${__dirname}/dist`,
    filename: '[name].js'
  },
  module: {
    rules: [
      {
        test: /Plugin\.js$/,
        use: {
          loader: require.resolve('./lib/no-subprocess-loader.js')
        }
      },
      {
        test: /FileWriter\.js$/,
        use: {
          loader: require.resolve('./lib/no-import-lazy-loader.js')
        }
      }
    ]
  },
  plugins: [
    {
      apply(compiler) {
        const CommonJsRequireContextDependency = require('webpack/lib/dependencies/CommonJsRequireContextDependency');

        function processDependencies(block, cb) {
          for (let deps = block.dependencies, i = deps.length - 1; i >= 0; i--) {
            cb(deps[i], i, deps);
          }

          for (const child of block.blocks) {
            processDependencies(child, cb);
          }
        }

        function removeContextDependency(dep, i, dependencies) {
          if (dep instanceof CommonJsRequireContextDependency) {
            dependencies.splice(i, 1);
          }
        }

        compiler.hooks.thisCompilation.tap('FixDynamicRequire', (compilation) => {
          compilation.hooks.succeedModule.tap('FixDynamicRequire', (mod) => {
            processDependencies(mod, removeContextDependency);
          });
        });
      }
    }
  ],
  target: 'node'
};
