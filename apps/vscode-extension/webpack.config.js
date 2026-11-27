//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    clean: true
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          // The Python backend lives outside this package (<repo>/backend/src)
          // and ships inside the VSIX at the same dist path as before. The
          // context keeps the glob relative: with an absolute `from` outside
          // the compiler context the ignore patterns stop matching and
          // __pycache__ leaks into the VSIX. A missing backend is an error
          // here, never a VSIX without its analyzers.
          context: path.resolve(__dirname, '..', '..', 'backend'),
          from: 'src',
          to: 'code_analysis/python',
          globOptions: {
            ignore: ['**/*.ts', '**/__pycache__/**'],
          },
          noErrorOnMissing: false
        }
        // templates/ and examples/ are NOT copied here: the runtime reads them
        // at <extensionPath>/templates and <extensionPath>/examples, which the
        // package.json `files` allowlist ships as they are. A dist/ copy would
        // only ship them twice (test/packaging/packagedLayout.test.cjs).
      ],
    }),
  ],
  // Source maps help the F5 dev flow; the packaged VSIX must not carry them
  // (extension.js.map alone is ~3.5 MB). scripts/package-vsix.mjs sets this
  // variable for the vsce run, whose vscode:prepublish hook re-runs webpack.
  devtool: process.env.CODEXR_NO_SOURCEMAPS ? false : 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = config;

