'use babel'

import clipboard from 'clipboard';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const chance = require(`${atom.packages.resolvePackagePath('random')}/node_modules/chance`).Chance();

//
// package
//

const packageName = 'hydrogen-extras';

//
// js
//

// TODO Use npm promise [https://www.npmjs.com/package/promise]
Promise.prototype.finally = function (f) {
  return this.then(function (value) {
    return Promise.resolve(f()).then(function () {
      return value;
    });
  }, function (err) {
    return Promise.resolve(f()).then(function () {
      throw err;
    });
  });
};

export function joinIfArray(x) {
  return x instanceof Array ? x.join('') : x;
}

export function stripSuffix(str, suffix) {
  return str.endsWith(suffix) ? str.slice(0, -suffix.length) : str;
}

//
// fs
//

export function getPathComponents(path) {
  return path.split('/').filter(x => x);
}

export function mktemp({prefix, suffix, tmpdir}) {
  tmpdir = tmpdir || '/tmp';
  const random = chance.hash({length: 8});
  return `${tmpdir}/${prefix}${random}${suffix}`;
}

//
// dom
//

export function elementsFromHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  // Copy .childNodes in case div mutates, e.g. if you .append one of its children elsewhere in the
  // dom (since a node can't exist in multiple places in the dom)
  return Array.from(div.childNodes);
}

export function clipboardCopyImageFromDataURL(dataURL) {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
}

export function clipboardCopyImg(img) {
  if (!img.src.startsWith('data:')) {
    throw `Only data urls are supported: img.src[${img.src}]`;
  }
  clipboardCopyImageFromDataURL(img.src);
}

export async function svgToPngDataUrl(svg) {
  const [svgWidth, svgHeight] = [svg.clientWidth, svg.clientHeight];
  if (svgWidth === 0 || svgHeight === 0) {
    // This happens when the svg elem isn't visible (not sure how to get width/height in that case)
    throw `svg.clientWidth[${svgWidth}] and svg.clientHeight[${svgHeight}] must be nonzero`;
  }
  const canvas = document.createElement('canvas');
  canvas.width = svgWidth * devicePixelRatio; // devicePixelRatio=2 for retina displays
  canvas.height = svgHeight * devicePixelRatio;
  canvas.style.width = `${svgWidth}px`;
  canvas.style.height = `${svgHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const svgObjectUrl = URL.createObjectURL(new Blob([svg.outerHTML], {type: 'image/svg+xml'}));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(svgObjectUrl); // Deallocate object
      resolve(canvas.toDataURL("image/png"));
    };
    img.src = svgObjectUrl;
  });
}

//
// atom
//

// f might be called multiple times
export function onPackageByName(packageName, f) {
  // Catch it if it activates in the future
  const disposable = atom.packages.onDidActivatePackage(_package => {
    if (_package.name === packageName) {
      f(_package);
    }
  });
  // Catch it if it activated in the past
  const _package = atom.packages.getActivePackage(packageName);
  if (_package) {
    f(_package);
    disposable.dispose();
  }
  return disposable;
}

export function ifPackageActive(packageName, f) {
  const p = atom.packages.getActivePackage(packageName);
  if (p) {
    return f(p.mainModule);
  }
}

// TODO Why isn't https://github.com/atom/atom/issues/16454 fixed in atom-1.23.3?
export function warnIfTextEditorIdsAreNotUnique() {
  const editors = atom.workspace.getTextEditors();
  const dupeIds = _.chain(editors).countBy(x => x.id).flatMap((v, k) => v > 1 ? [k] : []).value();
  // Careful: dupeIds are string instead of int since js objects coerce keys via .toString()
  const dupeEditors = _.chain(dupeIds).flatMap(id => editors.filter(e => e.id.toString() === id)).value();
  if (_.size(dupeEditors) > 0) {
    atom.notifications.addWarning(
      "TextEditor id's are not unique! Try manually closing and reopening one of them. [https://github.com/atom/atom/issues/16454]",
      {
        dismissable: true,
        icon: 'bug',
        detail: dupeEditors.map(e => `${e.id} -> ${(e.buffer.file || {}).path}\n`).join(''),
      },
    );
  }
}

// TODO How to generically provide xterm.newTerm? (just hard depend on xterm package?)
// TODO How to generically pass in command? (pretty gnarly...)
function newTermWithCommand(command) {
  console.info('newTermWithCommand:', command);
  const xterm = atom.packages.getLoadedPackage('xterm').mainModule;
  xterm.newTerm({opts: {moreEnv: {'TMUX_NEW_SESSION_SHELL_COMMAND': command}}});
  // TODO Abstract into function `openInAdjacentPane`
  // TODO Package these commands up so we can declare a package dependency on them
  // Open term as new item in current pane, and require user to move it wherever they want; trying
  // to open the term in some adjacent pane too often produces a weird result that's more jarring
  // than helpful
  // atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right');
}