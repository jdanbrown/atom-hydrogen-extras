'use babel'

import {File} from 'atom';
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {readableString, writableString} = require('./util');

export function pyPathForIpynbPath(ipynbPath) {
  return `${ipynbPath}.py`;
}

// For TextBuffer.setFile
export class IpynbPyFile {

  // TODO Change into a `new` so we can have a `.destroy()`
  static installIntoTextBuffer(buffer) {
    const ipynbPyFile = new IpynbPyFile(buffer.file);
    console.debug('IpynbPyFile.installIntoTextBuffer: buffer.setFile');
    // Have to .setFile(null) first, since .setFile(file) noops if file.getPath() is the same as the
    // buffer's existing file.getPath()
    buffer.setFile(null);
    buffer.setFile(ipynbPyFile);
    window.buffer = buffer; // XXX
    window.ipynbPyFile = ipynbPyFile; // XXX
    return ipynbPyFile;
  }

  constructor(file) {
    this.file = file;
    // this.pyFile = new File(pyPathForIpynbPath(file.path));
    console.debug('IpynbPyFile.constructor', this.file);
    window.file = this.file; // XXX
    // window.pyFile = this.pyFile; // XXX
  }

  //
  // API expected by TextBuffer
  //

  // The String path to the file
  getPath() {
    // console.debug('IpynbPyFile.getPath'); // XXX dev
    return this.file.getPath();
  }

  // A stream.Readable that can be used to load the file's content
  createReadStream() {
    console.debug('IpynbPyFile.createReadStream'); // XXX dev
    const ipynbSource = this.file.readSync();

    // TODO TODO
    const pySource = JSON.parse(ipynbSource).cells[0].source.join('\n');

    return readableString(pySource, {encoding: 'utf8'});
  }

  // A stream.Writable that can be used to save content to the file
  createWriteStream() {
    console.debug('IpynbPyFile.createWriteStream'); // XXX dev
    return writableString({encoding: 'utf8', onFinish: pySource => {
      console.debug('IpynbPyFile.createWriteStream: onFinish'); // XXX dev

      // TODO TODO
      const ipynbSource = JSON.stringify(
        {
          cells: [
            {source: [pySource]}
          ],
        },
        null,
        ' ',
      );

      this.file.writeSync(ipynbSource);
    }});
  }

  // true if the file exists, false otherwise
  existsSync() {
    console.debug('IpynbPyFile.existsSync'); // XXX dev
    return this.file.existsSync();
  }

  // (optional) Invokes its callback argument when the file changes. The method should return a
  // Disposable that can be used to prevent further calls to the callback.
  onDidChange(f) {
    console.debug('IpynbPyFile.onDidChange'); // XXX dev
    return this.file.onDidChange(f);
  }

  // (optional) Invokes its callback argument when the file is deleted. The method should return a
  // Disposable that can be used to prevent further calls to the callback.
  onDidDelete(f) {
    console.debug('IpynbPyFile.onDidDelete'); // XXX dev
    return this.file.onDidDelete(f);
  }

  // (optional) Invokes its callback argument when the file is renamed. The method should return a
  // Disposable that can be used to prevent further calls to the callback.
  onDidRename(f) {
    console.debug('IpynbPyFile.onDidRename'); // XXX dev
    return this.file.onDidRename(f);
  }

  //
  // Private API
  //

}
