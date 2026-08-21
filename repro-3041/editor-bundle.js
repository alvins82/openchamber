// Repro for openchamber#3041 — bundle a CodeMirror editor the way the
// OpenChamber composer does (via @codemirror/state + @codemirror/view) so a
// plain browser page can mount it and we can inspect the real input surface.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export function mount(host) {
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [EditorView.lineWrapping],
    }),
    parent: host,
  });
  return view;
}
