'use babel'

import {Point, Range} from 'atom'

// TODO package.json so we don't break if these packages aren't installed
export const configDir = atom.getConfigDirPath();
export const {findInEditor} = require(`${configDir}/packages/vim-mode-plus/lib/utils`);

export function getCellRanges(editor, options = {}) {
  const cursorCellRange = getCellRange(editor, editor.getCursorBufferPosition());
  let row = 0;
  const ranges = [];
  while (true) {
    const range = getCellRange(editor, Point(row, 0));
    const rows = range.getRows();
    const nextRow = rows[rows.length - 1];
    if (row >= nextRow) {
      break;
    }
    if (
      options.all ||
      (options.above && range.end.isLessThanOrEqual(cursorCellRange.start)) ||
      (options.below && cursorCellRange.end.translate({row: -1}).isLessThanOrEqual(range.start)) ||
      (options.current && cursorCellRange.isEqual(range))
    ) {
      ranges.push(range);
    }
    row = nextRow + 1;
  }
  return ranges;
}

export function getCellRange(editor, currPosition) {
  const nextPosition = editor.clipBufferPosition(currPosition.translate({row: 1}));
  const prevDelim = getCellPoint(editor, 'previous', nextPosition) || getLastResortPoint(editor, 'previous');
  const nextDelim = getCellPoint(editor, 'next', currPosition) || getLastResortPoint(editor, 'next');
  return Range(
    // prevDelim.translate({row: prevDelim.row === 0 ? 0 : 1}),
    prevDelim,
    // nextDelim,
    nextDelim.translate({row: nextDelim.row === editor.getLastBufferRow() ? 0 : -1}),
  );
}

export function getCellPoint(editor, direction, from) {

  // TODO Still some bugs when delims are separated by non-empty blank lines instead of empties
  //  - e.g. '////\n\n////' works forward + backward, but '////\n  \n////' doesn't work backward
  const comment = getLineComment(editor.getGrammar());
  const space = '[ \\t]*'; // Careful! \s matches \n, which we don't want
  const begin = `^${space}`;
  const end = `${space}$`;
  const blank = `^${space}$`;
  const stuff = '(| .*)';
  const double = `${begin}${comment}${comment}${stuff}${end}`; // No trailing blank required
  const single = `${begin}${comment}${stuff}${end}`;
  const singleNoStuff = `${begin}${comment}${end}`;
  const heading = `${singleNoStuff}\\n(${single}\\n)*${singleNoStuff}\\n${blank}`; // Trailing blank required
  const jupyterCellMagic = `${begin}%%.*${end}`; // No trailing blank required
  const delim = `${blank}\\n(${double}|${heading}|${jupyterCellMagic})`;
  const pattern = new RegExp(delim, 'm');

  if (direction === 'previous' && !editor.isBufferRowBlank(from.row - 1)) {
    const nextBlankLine = findInEditor(editor, 'next', /^\s*$/g, {from}, ({range}) => {
      return range.start;
    });
    from = nextBlankLine || from; // in case there are no more blank lines in the buffer
  }
  return findInEditor(editor, direction, pattern, {from}, ({range}) => {
    return editor.clipBufferPosition(range.start.translate({row: 1}));
  });

}

export function getLastResortPoint(editor, direction) {
  if (direction === 'previous') {
    return editor.buffer.getFirstPosition();
  } else {
    return editor.buffer.clipPosition({row: editor.buffer.getLastRow()});
  }
}

// TODO Can we avoid hardcoding these?
export const knownLineComments = [
  '#',
  '//',
  '--',
  '%',
  ';',
  '"',
];

export function getLineComment(grammar) {
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
/* TODO "Tests"
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
