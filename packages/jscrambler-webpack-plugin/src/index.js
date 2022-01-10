const {basename} = require('path');
const {readFileSync} = require('fs');
const client = require('jscrambler').default;
const {SourceMapSource} = require('webpack-sources');

const JSCRAMBLER_IGNORE = '.jscramblerignore';
const sourceMaps = !!client.config.sourceMaps;
const instrument = !!client.config.instrument;

class JscramblerPlugin {
  constructor(_options) {
    let options = _options;
    if (typeof options !== 'object' || Array.isArray(options)) options = {};

    this.options = Object.assign(options, {
      clientId: 2
    });

    this.instrument = instrument;
    if (typeof options.instrument === 'boolean') {
      this.instrument = options.instrument;
    }

    this.jscramblerOp = this.instrument
      ? client.instrumentAndDownload
      : client.protectAndDownload;
    this.processResult = this.processResult.bind(this);
    this.processSourceMaps = this.processSourceMaps.bind(this);

    if (client.config.filesSrc || client.config.filesDest || options.filesSrc || options.filesDest) {
      console.warn('(JscramblerPlugin) Options *filesSrc* and *filesDest* were ignored. Webpack entry and output fields will be used instead!')
    }

    if (typeof this.options.ignoreFile === 'string') {
      if (basename(this.options.ignoreFile) !== JSCRAMBLER_IGNORE) {
        throw new Error('(JscramblerPlugin) *ignoreFile* option must point to .jscramblerignore file');
      }
      this.ignoreFileSource = {content: readFileSync(this.options.ignoreFile, { encoding: 'utf-8'}), filename: JSCRAMBLER_IGNORE};
    }
  }

  apply(compiler) {
    const enable =
      this.options.enable !== undefined ? this.options.enable : true;

    if (!enable) {
      return;
    }

    const emitFn = compiler.hooks
      ? (arg) => compiler.hooks.emit.tapAsync("JscramblerPlugin", arg)
      : (arg) => compiler.plugin("emit", arg); // compatibility with webpack <=3

    emitFn((compilation, callback) => {
      const sources = [];
      compilation.chunks.forEach(chunk => {
        if (
          Array.isArray(this.options.chunks) &&
          !this.options.chunks.includes(chunk.name)
        ) {
          return;
        }

        chunk.files.forEach(filename => {
          if (/\.(js|html|htm)$/.test(filename)) {
            const content = compilation.assets[filename].source();

            sources.push({content, filename});
          }

          if ((this.instrument || sourceMaps) && /\.(js.map)$/.test(filename)) {
            const sourceMapContent = compilation.assets[filename].source();
            if (sourceMapContent) {
              sources.push({
                content: sourceMapContent,
                filename
              });
            }
          }
        });
      });

      if (sources.length > 0) {
        if (this.ignoreFileSource) {
          sources.push(this.ignoreFileSource);
        }
        Promise.resolve(
          this.jscramblerOp.call(
            client,
            Object.assign(this.options, {
              sources,
              stream: false
            }),
            res => {
              this.protectionResult = res.map(p => {
                // normalize name. F.e. if the original names starts with "./", the protected version must also be set with "./" prefix
                p.filename = (sources.find(({filename: oFilename}) => new RegExp(`^(./)*${p.filename}$`).test(oFilename)) ||  p).filename;
                return p;
              });
            }
          )
        )
          .then(protectionId =>
            this.processResult(protectionId, compilation, callback)
          )
          .catch(err => {
            callback(err);
          });
      } else {
        callback();
      }
    });
  }

  processSourceMaps(results, compilation, callback) {
    for (const result of results) {
      const sourceFilename = result.filename
        .slice(0, -4)
        .replace('jscramblerSourceMaps/', '');
      compilation.warnings.push(`Processing sourcemap: ${sourceFilename}`);

      const sm = JSON.parse(result.content);

      if (compilation.assets[sourceFilename]) {
        compilation.assets[`${sourceFilename}.map`] = {
          source() {
            return result.content;
          },
          size() {
            return result.content.length;
          }
        };

        const content = compilation.assets[sourceFilename].source();
        compilation.assets[sourceFilename] = new SourceMapSource(
          content,
          sourceFilename,
          sm
        );
      }
    }

    callback();
  }

  processResult(protectionId, compilation, callback) {
    const results = this.protectionResult;

    for (const result of results) {
      if (result.filename === JSCRAMBLER_IGNORE) {
        continue;
      }
      compilation.assets[result.filename] = {
        source() {
          return result.content;
        },
        size() {
          return result.content.length;
        }
      };
    }

    // turn off source-maps download if jscramblerOp is instrumentAndDowload
    if (!this.instrument && sourceMaps) {
      client.downloadSourceMaps(
        Object.assign({}, client.config, {stream: false, protectionId}),
        res => this.processSourceMaps(res, compilation, callback)
      );

      return;
    }

    callback();
  }
}

module.exports = JscramblerPlugin;
