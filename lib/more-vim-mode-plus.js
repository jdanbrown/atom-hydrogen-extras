'use babel'

export const configDir = atom.getConfigDirPath();
export const {Operator} = require(`${configDir}/packages/vim-mode-plus/lib/operator`);
export const {MoveToNextParagraph} = require(`${configDir}/packages/vim-mode-plus/lib/motion`);
export const {TextObject} = require(`${configDir}/packages/vim-mode-plus/lib/text-object`);

// TODO package.json so we don't break if these packages aren't installed
export const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`)

export const {getCellPoint, getCellRange} = require('./cells');

export const disposables = new CompositeDisposable();

//
// run-code Operators
//

// vim-mode-plus:run-code
//  - Ref: lib/operator.js
//  - TODO Take hydrogenNotebook as arg
export class RunCode extends Operator {
  trackChange = true; // [What is this for?]
  stayAtSamePosition = true; // Unlike delete/yank
  mutateSelection(selection) {
    const range = selection.getBufferRange(); // Capture range for async runCode
    const notebook = atom.packages.getLoadedPackage('hydrogen-extras').mainModule.notebookModules.notebookHydrogen;
    notebook.getActiveNotebook().runCode({}, range);
  }
}

export class RunCodeInpane extends Operator {
  trackChange = true; // [What is this for?]
  stayAtSamePosition = true; // Unlike delete/yank
  mutateSelection(selection) {
    const range = selection.getBufferRange(); // Capture range for async runCode
    const notebook = atom.packages.getLoadedPackage('hydrogen-extras').mainModule.notebookModules.notebookHydrogen;
    notebook.getActiveNotebook().runCode({inpane: true}, range);
  }
}

disposables.add(
  RunCode.registerCommand(),
  RunCodeInpane.registerCommand(),
);

//
// Cell Motion and TextObject
//

// Motion
//  - Ref: lib/motion.js
export class MoveToNextCell extends MoveToNextParagraph {
  getPoint(from) {
    return getCellPoint(this.editor, this.direction, from);
  }
}
export class MoveToPreviousCell extends MoveToNextCell {
  direction = "previous";
}
disposables.add(
  MoveToNextCell.registerCommand(),
  MoveToPreviousCell.registerCommand(),
);

// TextObject
//  - Ref: lib/text-object.js
//  - TODO Fix repetition (v ac ac ac)
//  - TODO Leading/trailing is inconsistent with Paragraph when starting from blank line
export class Cell extends TextObject {
  wise = 'linewise';
  supportCount = true; // TODO This doesn't work (but it does work with Paragraph...?)
  getRange(selection) {
    const range = getCellRange(this.editor, this.getCursorPositionForSelection(selection));
    return range.translate(
      [0, 0],
      [this.isA(), 0],
    );
  }
}
export const {InnerCell, ACell} = Cell.deriveClass(true);
disposables.add(
  InnerCell.registerCommand(),
  ACell.registerCommand(),
);
