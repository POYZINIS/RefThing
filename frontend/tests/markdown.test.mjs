import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from '../src/canvas/nodes/markdown.ts';

const plain = (spans) => spans.map((span) => span.text).join('');

test('inline: bold, italic, strike, code, links', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' c' },
  ]);
  assert.deepEqual(parseInline('*i* and _j_'), [
    { text: 'i', italic: true },
    { text: ' and ' },
    { text: 'j', italic: true },
  ]);
  assert.deepEqual(parseInline('~~gone~~'), [{ text: 'gone', strike: true }]);
  assert.deepEqual(parseInline('run `npm test` now'), [
    { text: 'run ' },
    { text: 'npm test', code: true },
    { text: ' now' },
  ]);
  assert.deepEqual(parseInline('see [the docs](https://x.y/z)'), [
    { text: 'see ' },
    { text: 'the docs', link: true },
  ]);
  assert.deepEqual(parseInline('***both***'), [{ text: 'both', bold: true, italic: true }]);
});

test('inline: literal markers stay literal', () => {
  assert.equal(plain(parseInline('snake_case_name')), 'snake_case_name');
  assert.equal(plain(parseInline('2 * 3 * 4')), '2 * 3 * 4');
  assert.equal(plain(parseInline('\\*not italic\\*')), '*not italic*');
  assert.equal(plain(parseInline('**unclosed')), '**unclosed');
  assert.deepEqual(parseInline('a*b*c')[1], { text: 'b', italic: true }, 'star works mid-word');
});

test('blocks: one per line, with structure', () => {
  const blocks = parseMarkdown(
    [
      '# Title',
      'plain **text**',
      '',
      '- item',
      '  - nested',
      '1. first',
      '- [x] done',
      '- [ ] todo',
      '> quoted',
      '---',
      '```',
      'code  line',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    [
      'heading',
      'paragraph',
      'blank',
      'bullet',
      'bullet',
      'ordered',
      'task',
      'task',
      'quote',
      'rule',
      'code',
    ],
  );
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[4].depth, 1, 'two spaces per level');
  assert.equal(blocks[5].marker, '1.');
  assert.equal(blocks[6].checked, true);
  assert.equal(blocks[7].checked, false);
  assert.equal(blocks[10].text, 'code  line', 'code keeps its spaces, unparsed');
});

test('blocks: an unclosed fence still shows its code', () => {
  assert.deepEqual(parseMarkdown('```\nx'), [{ kind: 'code', text: 'x' }]);
});

test('note style: validated, defaults dropped when stored', async () => {
  const { noteStyle, storedStyle, DEFAULT_NOTE_STYLE } = await import(
    '../src/canvas/nodes/noteText.ts'
  );
  assert.deepEqual(noteStyle({ text: 'x' }), DEFAULT_NOTE_STYLE);
  const style = noteStyle({
    style: {
      font: 'serif',
      size: 28,
      bold: true,
      align: 'center',
      color: '#d9534f',
      markdown: false,
    },
  });
  assert.deepEqual(
    [style.font, style.size, style.bold, style.italic, style.align, style.color, style.markdown],
    ['serif', 28, true, false, 'center', '#d9534f', false],
  );
  assert.equal(noteStyle({ style: { font: 'comic', size: -3, color: 'red' } }).font, 'sans');
  assert.equal(noteStyle({ style: { size: -3 } }).size, 15);
  assert.equal(noteStyle({ style: { color: 'red' } }).color, null, 'only #rrggbb colours');
  assert.deepEqual(storedStyle({ ...DEFAULT_NOTE_STYLE, bold: true }), { bold: true });
  assert.deepEqual(storedStyle(DEFAULT_NOTE_STYLE), {});
});

test('note colours: no fill = the theme flipped; a fill picks contrasting text', async () => {
  const { noteColors } = await import('../src/canvas/nodes/noteText.ts');
  const dark = noteColors(null, null, 'dark');
  const light = noteColors(null, null, 'light');
  assert.equal(dark.fill, null, 'text only');
  assert.equal(dark.border, null);
  assert.equal(dark.text, '#eef2ee', 'light text on the dark theme');
  assert.equal(light.text, '#1f2622', 'dark text on the light theme');
  assert.equal(noteColors('#f5e7ad', null, 'dark').text, '#1f2622', 'dark text on a pale fill');
  assert.equal(noteColors('#2b2f2d', null, 'light').text, '#eef2ee', 'light text on a dark fill');
  assert.equal(noteColors('#2b2f2d', '#d9534f', 'light').text, '#d9534f', 'a chosen colour wins');
});
