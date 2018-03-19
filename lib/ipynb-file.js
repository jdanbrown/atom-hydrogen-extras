'use babel'

import {File} from 'atom';
import assert from 'assert';
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const {CompositeDisposable, Disposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {cloneClass, readableString, writableString} = require('./util');

// TODO TODO Try using again? I fixed the confounding bugs, and they weren't due to FileLike.
// Reuse implementation without subtyping
//  - ipynbPyFile needs to act like a File without `x instanceof File` being true, since TextBuffer
//    switches behavior based on that (ugh, leaky abstractions)
export const FileLike = cloneClass(File);

// A File-like object for TextBuffer.setFile
//  - References:
//    - https://github.com/atom/text-buffer/blob/56a61d9/src/text-buffer.coffee#L573
//    - https://github.com/atom/node-pathwatcher/blob/master/src/file.coffee
// export class IpynbPyFile extends FileLike { // TODO TODO
export class IpynbPyFile {

  // API expected by TextBuffer:
  //  - getPath()
  //  - createReadStream()
  //  - createWriteStream()
  //  - existsSync()
  //  - onDidChange(f)
  //  - onDidDelete(f)
  //  - onDidRename(f)

  constructor(path, ipynbSync) {
    console.debug('IpynbPyFile.constructor');
    // super(editor.buffer.file.path); // TODO TODO
    this.file = new File(path); // The file we are a facade over
    this.path = this.file.path;
    this.ipynbSync = ipynbSync;
  }

  // TODO TODO Fold this back into constructor
  get editor() {
    return this.ipynbSync.editor;
  }

  // TODO TODO
  // async start() {
  //   console.debug('IpynbPyFile.start');
  //   await this.toggle(true);
  //   return new Disposable(async () => {
  //     await this.toggle(false);
  //   });
  // }

  // TODO TODO
  // async toggle(on = null) {
  //   window.ipynbPyFile = this; // XXX
  //   // TODO Toggle based on buffer contents, not file contents, so we don't have to block on
  //   // isModified, which isn't 100% safe to have to do (e.g. package deactivate->activate -> errors)
  //   if (this.editor.buffer.isModified() && !this.editor.buffer.isEmpty()) {
  //     atom.notifications.addWarning("Can't toggle, is modified");
  //   } else {
  //     const curr = this.editor.buffer.file !== this.file;
  //     on = on !== null ? on : !curr;
  //     console.debug(`IpynbPyFile.toggle: ${curr} -> ${on}`);
  //     // Have to .setFile(null) first, since .setFile(file) noops if file.getPath() is the same as the
  //     // buffer's existing file.getPath()
  //     this.editor.buffer.setFile(null);
  //     this.editor.buffer.setFile(on ? this : this.file);
  //     await this.editor.buffer.reload(); // Else buffer contents don't update to reflect setFile
  //   }
  // }

  // A stream.Readable that can be used to load the file's content
  createReadStream() {
    console.debug('IpynbPyFile.createReadStream'); // XXX dev
    window.file = this.file; // XXX
    const ipynbSource = this.file.readSync();
    const pySource = this.ipynbSync.getPyFromIpynbSource(ipynbSource);
    return readableString(pySource, {encoding: 'utf8'});
  }

  // A stream.Writable that can be used to save content to the file
  createWriteStream() {
    console.debug('IpynbPyFile.createWriteStream'); // XXX dev
    return writableString({encoding: 'utf8', onFinish: pySource => {
      console.debug('IpynbPyFile.createWriteStream: onFinish'); // XXX dev
      // We're going to read straight from this.editor and ignore pySource, so make sure they match
      window.pySource = pySource; // XXX
      window.text = this.editor.getText(); // XXX
      window.editor = this.editor; // XXX
      assert.equal(pySource, this.editor.getText());
      // Get .ipynb from the .py editor, since it has to read both .py source and notebook outputs
      const ipynbSource = this.ipynbSync.getIpynbFromPyEditor();
      window.ipynbSource = ipynbSource; // XXX
      window.file = this.file; // XXX
      this.file.writeSync(ipynbSource);
      new File('/tmp/x').writeSync(ipynbSource); // XXX
    }});
  }

  // Delegation methods
  getPath() { return this.file.getPath(); }
  getParent() { return this.file.getParent(); }
  existsSync() { return this.file.existsSync(); }
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

}
