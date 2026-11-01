import { JupyterFrontEnd } from '@jupyterlab/application';
import { Cell } from '@jupyterlab/cells';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import { ActiveCellManager } from '../active-cell-manager';

describe('ActiveCellManager replacement handlers', () => {
  function makeManager() {
    const setSource = jest.fn();
    const cell = {
      model: { id: 'cell-1', type: 'code' },
      ready: Promise.resolve(),
      editor: { model: { sharedModel: { setSource } } }
    } as unknown as Cell;
    const panel = { isVisible: true } as NotebookPanel;
    const tracker = {
      activeCellChanged: { connect: jest.fn() },
      activeCell: cell,
      currentWidget: panel
    } as unknown as INotebookTracker;
    const manager = new ActiveCellManager({
      tracker,
      shell: {} as JupyterFrontEnd.IShell
    });
    return { manager, cell, panel, setSource };
  }

  it('lets a registered handler preview and intercept replacement', async () => {
    const { manager, cell, panel, setSource } = makeManager();
    const handler = jest.fn().mockResolvedValue(true);
    const registration = manager.registerReplaceHandler(handler);

    await manager.replace('generated code');

    expect(handler).toHaveBeenCalledWith('generated code', cell, panel);
    expect(setSource).not.toHaveBeenCalled();

    registration.dispose();
    await manager.replace('direct code');
    expect(setSource).toHaveBeenCalledWith('direct code');
  });

  it('falls back to direct replacement when a handler declines', async () => {
    const { manager, setSource } = makeManager();
    manager.registerReplaceHandler(() => false);

    await manager.replace('generated code');

    expect(setSource).toHaveBeenCalledWith('generated code');
  });
});
