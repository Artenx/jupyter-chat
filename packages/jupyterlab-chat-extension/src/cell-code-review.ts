import {
  Compartment,
  Extension,
  Facet,
  RangeSetBuilder,
  StateEffect
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate
} from '@codemirror/view';
import {
  cellDiffSource,
  createCellDiffLines,
  type CellDiffLine,
  type CellReplacementHandler,
  type IActiveCellManager,
  TRANSLATION_DOMAIN
} from '@jupyter/chat';
import {
  JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker, type NotebookPanel } from '@jupyterlab/notebook';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IActiveCellManagerToken } from 'jupyterlab-chat';

const PLUGIN_ID = 'jupyterlab-chat-extension:toolbar-buttons';
const ACCEPT_CELL_CODE = 'toolbar-button:chat-accept-cell-code';
const REJECT_CELL_CODE = 'toolbar-button:chat-reject-cell-code';

type PendingCellReview = {
  panel: NotebookPanel;
  cellId: string;
  originalSource: string;
  replacementSource: string;
};

type ReviewCell = {
  node: HTMLElement;
  model: {
    id: string;
    type: string;
    sharedModel: {
      getSource(): string;
      setSource(source: string): void;
    };
  };
  editor?: unknown;
};

type CellWidget = ReviewCell;

const diffLinesFacet = Facet.define<CellDiffLine[], CellDiffLine[]>({
  combine: values => values[0] ?? []
});

const removedLineDecoration = Decoration.line({
  attributes: { class: 'jp-chat-cell-diff-removed' }
});
const insertedLineDecoration = Decoration.line({
  attributes: { class: 'jp-chat-cell-diff-inserted' }
});

const diffTheme = EditorView.baseTheme({
  '.jp-chat-cell-diff-removed': {
    backgroundColor:
      'color-mix(in srgb, var(--jp-error-color1) 26%, transparent)'
  },
  '.jp-chat-cell-diff-inserted': {
    backgroundColor:
      'color-mix(in srgb, var(--jp-success-color1) 28%, transparent)'
  }
});

function diffDecorations(view: EditorView): DecorationSet {
  const rows = view.state.facet(diffLinesFacet);
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to; ) {
      const line = view.state.doc.lineAt(position);
      const row = rows[line.number - 1];
      if (row?.kind === 'removed') {
        builder.add(line.from, line.from, removedLineDecoration);
      } else if (row?.kind === 'inserted') {
        builder.add(line.from, line.from, insertedLineDecoration);
      }
      position = line.to + 1;
    }
  }

  return builder.finish();
}

function createDiffExtension(lines: CellDiffLine[]): Extension {
  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = diffDecorations(view);
      }

      update(update: ViewUpdate): void {
        this.decorations = diffDecorations(update.view);
      }
    },
    { decorations: value => value.decorations }
  );

  return [diffTheme, diffLinesFacet.of(lines), decorations];
}

function cellKey(panel: NotebookPanel, cellId: string): string {
  return `${panel.id}:${cellId}`;
}

function editorViewForCell(cell: ReviewCell): EditorView | null {
  if (cell.model.type !== 'code') {
    return null;
  }
  const editor = cell.editor as { editor?: EditorView } | null | undefined;
  return editor?.editor ?? null;
}

function cellById(panel: NotebookPanel, cellId: string): CellWidget | null {
  const cell = panel.content.widgets.find(widget => widget.model.id === cellId);
  return (cell as unknown as CellWidget | undefined) ?? null;
}

const cellCodeReview: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Preview and review code applied from chat code blocks.',
  autoStart: true,
  requires: [INotebookTracker, IActiveCellManagerToken],
  optional: [ITranslator, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    activeCellManager: IActiveCellManager,
    translator_: ITranslator | null,
    settingRegistry: ISettingRegistry | null
  ) => {
    const trans = (translator_ ?? nullTranslator).load(TRANSLATION_DOMAIN);
    const pending = new Map<string, PendingCellReview>();
    const compartments = new Map<string, Compartment>();

    const isActiveCellPending = (): boolean => {
      const panel = notebookTracker.currentWidget;
      const cell = notebookTracker.activeCell;
      return !!(
        panel &&
        cell &&
        cell.model.type === 'code' &&
        pending.has(cellKey(panel, cell.model.id))
      );
    };

    const configureCellDiff = (
      panel: NotebookPanel,
      cell: ReviewCell,
      lines: CellDiffLine[]
    ): boolean => {
      const view = editorViewForCell(cell);
      if (!view) {
        return false;
      }

      const key = cellKey(panel, cell.model.id);
      let compartment = compartments.get(key);
      const extension = createDiffExtension(lines);
      if (!compartment) {
        compartment = new Compartment();
        compartments.set(key, compartment);
        view.dispatch({
          effects: StateEffect.appendConfig.of(compartment.of(extension))
        });
      } else {
        view.dispatch({ effects: compartment.reconfigure(extension) });
      }
      return true;
    };

    const clearCellDiff = (panel: NotebookPanel, cellId: string): void => {
      const key = cellKey(panel, cellId);
      const compartment = compartments.get(key);
      const cell = cellById(panel, cellId);
      const view = cell ? editorViewForCell(cell) : null;
      if (compartment && view) {
        view.dispatch({ effects: compartment.reconfigure([]) });
      }
      compartments.delete(key);
    };

    const settleReview = (
      panel: NotebookPanel,
      cellId: string,
      accept: boolean
    ): void => {
      const review = pending.get(cellKey(panel, cellId));
      if (!review) {
        return;
      }
      const cell = cellById(panel, cellId);
      if (!cell) {
        return;
      }
      clearCellDiff(panel, cellId);
      cell.model.sharedModel.setSource(
        accept ? review.replacementSource : review.originalSource
      );
      pending.delete(cellKey(panel, cellId));
      removeReviewBar(panel, cellId);
    };

    const reviewBars = new Map<string, HTMLElement>();

    const removeReviewBar = (panel: NotebookPanel, cellId: string): void => {
      const bar = reviewBars.get(cellKey(panel, cellId));
      if (bar) {
        bar.remove();
        reviewBars.delete(cellKey(panel, cellId));
      }
    };

    const attachReviewBar = (panel: NotebookPanel, cellId: string): void => {
      const cell = cellById(panel, cellId);
      if (!cell) {
        return;
      }
      removeReviewBar(panel, cellId);
      const bar = document.createElement('div');
      bar.className = 'jp-chat-cell-review-bar';
      const makeButton = (
        className: string,
        title: string,
        accept: boolean
      ): HTMLButtonElement => {
        const button = document.createElement('button');
        button.className = className;
        button.title = title;
        button.innerHTML = accept
          ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
          : '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        button.addEventListener('click', (event: MouseEvent) => {
          event.stopPropagation();
          settleReview(panel, cellId, accept);
        });
        return button;
      };
      bar.appendChild(
        makeButton('jp-chat-cell-review-bar-accept', '接受本次代码替换', true)
      );
      bar.appendChild(
        makeButton(
          'jp-chat-cell-review-bar-reject',
          '还原为替换前的代码',
          false
        )
      );
      cell.node.appendChild(bar);
      reviewBars.set(cellKey(panel, cellId), bar);
    };

    const previewReplacement: CellReplacementHandler = async (
      content,
      activeCell,
      panel
    ) => {
      if (activeCell.model.type !== 'code') {
        return false;
      }

      const key = cellKey(panel, activeCell.model.id);
      const existing = pending.get(key);
      const originalSource =
        existing?.originalSource ?? activeCell.model.sharedModel.getSource();

      if (content === originalSource) {
        if (existing) {
          clearCellDiff(panel, activeCell.model.id);
          activeCell.model.sharedModel.setSource(originalSource);
          pending.delete(key);
          removeReviewBar(panel, activeCell.model.id);
        }
        return true;
      }

      const lines = createCellDiffLines(originalSource, content);
      if (!lines.some(line => line.kind !== 'unchanged')) {
        return true;
      }

      // Apply decorations before changing the document: the following Yjs/code
      // editor update will then render the added and removed rows in one pass.
      if (
        !configureCellDiff(panel, activeCell as unknown as ReviewCell, lines)
      ) {
        return false;
      }

      pending.set(key, {
        panel,
        cellId: activeCell.model.id,
        originalSource,
        replacementSource: content
      });
      activeCell.model.sharedModel.setSource(cellDiffSource(lines));
      attachReviewBar(panel, activeCell.model.id);
      return true;
    };

    activeCellManager.registerReplaceHandler?.(previewReplacement);

    const settleActiveReview = (accept: boolean): void => {
      const panel = notebookTracker.currentWidget;
      const cell = notebookTracker.activeCell;
      if (!panel || !cell || cell.model.type !== 'code') {
        return;
      }
      settleReview(panel, cell.model.id, accept);
    };

    app.commands.addCommand(ACCEPT_CELL_CODE, {
      label: trans.__('Accept'),
      caption: trans.__('Accept the code replacement'),
      className: 'jp-chat-cell-review-accept',
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => settleActiveReview(true),
      isVisible: isActiveCellPending
    });

    app.commands.addCommand(REJECT_CELL_CODE, {
      label: trans.__('Reject'),
      caption: trans.__(
        'Restore the code that was in this cell before replacement'
      ),
      className: 'jp-chat-cell-review-reject',
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => settleActiveReview(false),
      isVisible: isActiveCellPending
    });

    // Fetch this plugin's schema into the frontend settings registry. The
    // notebook toolbar factory aggregates `jupyter.lab.toolbars.Cell`
    // contributions from plugins present in the registry; without this load
    // the Accept/Reject items never reach the cell toolbar. The schema must
    // not declare `jupyter.lab.transform` (no transformer registers for it),
    // otherwise this load would time out.
    void settingRegistry
      ?.load(PLUGIN_ID)
      .catch((error: unknown) => {
        console.warn(
          '[jupyterlab-chat] Failed to load cell code review settings:',
          error
        );
      });
  }
};

export default cellCodeReview;
