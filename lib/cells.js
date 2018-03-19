'use babel'

import {Point, Range} from 'atom'

// TODO TODO Refactor to simplify and do less work during chunk parsing
//  - Implement codeChunksForRange like allCodeChunks
//  - Refactor allCodeChunks to use codeChunksForRange
//  - Migrate callers of _codeChunksForSelection_v0 to codeChunksForRange (figure out range args)
//  - Look for other cruft to remove

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
export const {findInEditor, scanEditor} = require(`${atom.packages.resolvePackagePath('vim-mode-plus')}/lib/utils`);
window.findInEditor = findInEditor; // XXX
window.scanEditor = scanEditor; // XXX

// [Used by HydrogenNotebook.updateCellDecorations]
// [Used by IpynbSync.syncViewFromIpynb]
export function allCodeChunks(type, editor) {
  const delims = codeChunkDelimsInDirection(type, editor, 'next', [0, 0]);
  const first = editor.buffer.getFirstPosition();
  const last = editor.buffer.getEndPosition();
  delims.unshift(Range.fromObject({start: first, end: first}));
  delims.push(Range.fromObject({start: last, end: last}));
  return _.zipWith(delims.slice(0, -1), delims.slice(1), (delim, nextDelim) => {
    return Range.fromObject({
      start: delim.start.translate({row: delim.start.row == 0 ? 0 : 1}),
      end: nextDelim.start,
    });
  });
}
window.allCodeChunks = allCodeChunks; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); allCodeChunks(type, editor).forEach(chunk => console.log(chunk.toString())) })
*/

// TODO TODO Implement range
export function codeChunksForRange(type, editor, range) {
  // ...
}
window.codeChunksForRange = codeChunksForRange; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); codeChunksForRange(type, editor).forEach(chunk => console.log(chunk.toString())) })
*/

// [Used by HydrogenNotebook.run*]
export function _codeChunksForSelection_v0(type, editor, options = {}) {
  return _codeChunksForRange_v0(
    type,
    editor,
    editor.getSelectedBufferRange(),
    options,
  );
}
window._codeChunksForSelection_v0 = _codeChunksForSelection_v0 // XXX dev

export function _codeChunksForRange_v0(type, editor, range, options = {}) {
  const chunks = [];
  if (range) {
    range = expandRangeToCodeChunks(type, editor, range);
    let row = 0;
    while (true) {
      const chunk = codeChunkContainingPoint(type, editor, Point(row, 0));
      const rows = chunk.getRows();
      const nextRow = rows[rows.length - 1];
      if (row >= nextRow) {
        break;
      }
      if (
        // TODO Refactor options to make sense with _codeChunksForRange_v0 (originally for _codeChunksForSelection_v0)
        //  - Start at range.start.row (-1?) instead of 0
        //  - Stop at range.end.row (+1?) instead of eof
        //  - Update caller(s) to choose a range based on all/above/below/selected
        //    - Or at least don't require caller to specify range when options.all
        options.all ||
        (options.above && chunk.end.isLessThanOrEqual(range.start)) ||
        (options.below && range.end.translate({row: -1}).isLessThanOrEqual(chunk.start)) ||
        (options.selected && range.containsRange(chunk))
      ) {
        chunks.push(chunk);
        // console.warn(chunk.toString(), editor.buffer.getTextInRange(chunk)); // XXX Debug
      } else {
        // console.error(chunk.toString(), editor.buffer.getTextInRange(chunk)); // XXX Debug
      }
      row = nextRow + 1;
    }
  }
  return chunks;
}
window._codeChunksForRange_v0 = _codeChunksForRange_v0 // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
_codeChunksForRange_v0('cell', editor, editor.buffer.getRange(), {'all':true}).forEach(chunk => console.log(chunk.toString()))
*/

export function expandRangeToCodeChunks(type, editor, range) {
  return Range(
    codeChunkContainingPoint(type, editor, range.start).start,
    codeChunkContainingPoint(type, editor, range.end).end,
  );
}

// [Used by more-vim-mode-plus Cell (TextObject)]
export function codeChunkContainingPoint(type, editor, point) {
  const pointPlusOne = editor.clipBufferPosition(Point.fromObject(point).translate({row: 1}));
  const prevDelim = codeChunkStartPointInDirection(type, editor, 'previous', pointPlusOne) || getLastResortPoint(editor, 'previous');
  const nextDelim = codeChunkStartPointInDirection(type, editor, 'next', point) || getLastResortPoint(editor, 'next');
  return Range(
    prevDelim,
    nextDelim.translate({row: nextDelim.row === editor.getLastBufferRow() ? 0 : -1}),
  );
}

export function getLastResortPoint(editor, direction) {
  if (direction === 'previous') {
    return editor.buffer.getFirstPosition();
  } else {
    return editor.buffer.clipPosition({row: editor.buffer.getLastRow()});
  }
}

// [Used by more-vim-mode-plus MoveToNextCell (Motion)]
export function codeChunkStartPointInDirection(type, editor, direction, from) {
  // Find next delim in direction
  return codeChunkFindInEditor(type, editor, direction, from, ({range}) => {
    // 1+row to skip the leading blank line
    //  - ...because both callers start delim with blankLine [TODO don't assume this]
    return editor.clipBufferPosition(range.start.translate({row: 1}));
  });
}
window.codeChunkStartPointInDirection = codeChunkStartPointInDirection // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['next', 'previous'].forEach(direction => ['para', 'cell'].forEach(type => [0,1,2,3,4].forEach(row => console.log(type, direction, row, codeChunkStartPointInDirection(type, editor, direction, [row,0])))))
*/

export function codeChunkDelimsInDirection(type, editor, direction, from) {
  const delims = [];
  codeChunkFindInEditor(type, editor, direction, from, ({range}) => {
    delims.push(range);
  });
  return delims;
}
window.codeChunkDelimsInDirection = codeChunkDelimsInDirection; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); codeChunkDelimsInDirection(type, editor, 'next', [0,0]).forEach(delim => console.log(delim.toString())) })
*/

export function codeChunkFindInEditor(type, editor, direction, from, f) {
  // If we're inside delim then we have to jump out of it if we want to find it:
  //  - If current line is blank and next line is delim then moving 'next' will jump over it. Jump
  //    to the previous line to avoid this.
  if (direction === 'next' && editor.isBufferRowBlank(from.row)) {
    from = editor.clipBufferPosition(Point.fromObject(from).translate({row: -1}));
  }
  //  - If current line [previous line?] is _not_ blank and we're in the middle of delim (e.g.
  //    multi-line delim) then moving 'previous' will jump over it. Jump to the next blank line to //
  //    avoid this.
  if (direction === 'previous' && !editor.isBufferRowBlank(from.row - 1)) {
    const nextBlankLine = findInEditor(editor, 'next', /^\s*$/g, {from}, ({range}) => {
      return range.start;
    });
    from = nextBlankLine || from; // in case there are no more blank lines in the buffer
  }
  // Add '/g' to workaround bug in findEditor: if `from` is blank line then it's the first result
  let chunkDelimRegex = codeChunkDelimRegex(type, editor);
  chunkDelimRegex = new RegExp(chunkDelimRegex.source, chunkDelimRegex.flags + 'g');
  // Find delims in direction
  return findInEditor(editor, direction, chunkDelimRegex, {from}, ({range}) => {
    // Skip `from` to workaround bug in findEditor: if `from` is blank line then it's the first result
    if (!range.start.isEqual(from)) {
      return f({range});
    }
  });
}

export function codeChunkDelimRegex(type, editor) {
  if (type === 'para') {
    const space = '[ \\t]*'; // Careful! \s matches \n, which we don't want
    const blankLine = `^${space}$`;
    const delim = blankLine;
    return new RegExp(delim);
  } else if (type === 'cell') {
    // TODO Still some bugs when delims are separated by non-empty blank lines instead of empties
    //  - e.g. '////\n\n////' works forward + backward, but '////\n  \n////' doesn't work backward
    const comment = getLineComment(editor.getGrammar(), editor);
    const space = '[ \\t]*'; // Careful! \s matches \n, which we don't want
    const begin = `^${space}`;
    const end = `${space}$`;
    const blankLine = `^${space}$`;
    const stuff = '(| .*)';
    const double = `${begin}${comment}${comment}${stuff}${end}`; // No trailing blankLine required
    const single = `${begin}${comment}${stuff}${end}`;
    const singleNoStuff = `${begin}${comment}${end}`;
    const heading = `${singleNoStuff}\\n(${single}\\n)*${singleNoStuff}\\n${blankLine}`; // Trailing blankLine required
    const jupyterCellMagic = `${begin}%%.*${end}`; // No trailing blankLine required
    const delim = `${blankLine}\\n(${double}|${heading}|${jupyterCellMagic})`;
    return new RegExp(delim, 'm');
  } else {
    throw `Unknown code chunk type: ${type}`;
  }
}

export function getLineComment(grammar, editor = null) {
  if (grammar) {
    if (
      editor &&
      editor.buffer.file &&
      '.ipynb' === path.extname(editor.buffer.file.path).toLowerCase() &&
      grammar.scopeName === 'source.python'
    ) {
      // HACK Use '%%' instead of '##' in .ipynb .py to avoid colliding with markdown h2's
      return '%%';
    } else if (grammar.tokenizeLines) {
      let result;
      knownLineComments.forEach(lineComment => {
        const [line] = grammar.tokenizeLines(lineComment);
        const [token, ...tokens] = line;
        if (
          token.scopes.findIndex(scope => scope.startsWith('comment.line.')) !== -1 &&
          tokens.length === 0
        ) {
          result = lineComment;
        }
      })
      return result && result.trim();
    }
  }
}
/* TODO Tests
getLineComment = notebookHydrogen.moreVmp.getLineComment; undefined
getLineComment(atom.grammars.grammarForScopeName('source.python'))
getLineComment(atom.grammars.grammarForScopeName('source.js'))
getLineComment(atom.grammars.grammarForScopeName('source.go'))
getLineComment(atom.grammars.grammarForScopeName('source.sql'))
getLineComment(atom.grammars.grammarForScopeName('text.md'))
getLineComment(atom.grammars.grammarForScopeName('source.r'))
getLineComment(atom.grammars.grammarForScopeName('text.xml'))
getLineComment(atom.grammars.grammarForScopeName('source.viml'))
getLineComment(atom.grammars.grammarForScopeName('source.clojure'))
*/

// TODO Can we avoid hardcoding these?
export const knownLineComments = [
  '#',
  '//',
  '--',
  '%',
  ';',
  '"',
];

export function trimCodeRange(buffer, range) {
  // TODO Trim all whitespace, not just \n
  while (buffer.getTextInRange(range).startsWith('\n')) {
    range = range.translate([1, 0], [0, 0]);
  }
  while (buffer.getTextInRange(range).endsWith('\n')) {
    range = range.translate([0, 0], [-1, buffer.rangeForRow(range.end.row - 1).end.column]);
  }
  // Allow a trailing blank line if we contain any blank lines, e.g. for cells vs. paragraphs
  //  - TODO Oops, doing this abuts our output with the top of the next cell, which is worse...
  //  - TODO How do we want this to look? Should we resort to css styling...?
  // if (/^\s*$/m.test(buffer.getTextInRange(range))) {
  //   range = range.translate([0, 0], [1, 0]);
  // }
  return range;
}
