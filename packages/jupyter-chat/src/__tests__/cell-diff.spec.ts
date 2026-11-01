import { cellDiffSource, createCellDiffLines } from '../cell-diff';

describe('createCellDiffLines', () => {
  it('marks replaced lines as removed then inserted', () => {
    expect(
      createCellDiffLines('before\nold line\nafter', 'before\nnew line\nafter')
    ).toEqual([
      { content: 'before', kind: 'unchanged' },
      { content: 'old line', kind: 'removed' },
      { content: 'new line', kind: 'inserted' },
      { content: 'after', kind: 'unchanged' }
    ]);
  });

  it('marks only new lines when replacing an empty cell', () => {
    expect(createCellDiffLines('', 'x = 1')).toEqual([
      { content: 'x = 1', kind: 'inserted' }
    ]);
  });

  it('preserves unchanged source and handles deletion', () => {
    const lines = createCellDiffLines('a\nb\nc', 'a\nc');
    expect(lines).toEqual([
      { content: 'a', kind: 'unchanged' },
      { content: 'b', kind: 'removed' },
      { content: 'c', kind: 'unchanged' }
    ]);
    expect(cellDiffSource(lines)).toBe('a\nb\nc');
  });

  it('returns all lines unchanged when the sources match', () => {
    expect(createCellDiffLines('x = 1', 'x = 1')).toEqual([
      { content: 'x = 1', kind: 'unchanged' }
    ]);
  });
});
