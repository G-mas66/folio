import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/style.css';
import { ReaderNote, ReaderNotesPanel } from '../src/ReaderNotesPanel';

type HarnessWindow = Window & {
  workbench: { openExternal: (url: string) => Promise<boolean> };
  openedExternal?: string;
};

const harnessWindow = window as HarnessWindow;
harnessWindow.openedExternal = '';
harnessWindow.workbench = {
  openExternal: async (url) => {
    harnessWindow.openedExternal = url;
    return true;
  },
};

const startingText = [
  '# Reading note',
  '',
  'Keep this draft while switching notes.',
  '',
  '[A safe link](https://example.test/paper)',
  '',
  '![remote image](https://example.test/remote.png)',
].join('\n');

function NotesHarness() {
  const [notes, setNotes] = useState<ReaderNote[]>([
    { id: 'first', title: '阅读笔记', text: startingText },
    { id: 'second', title: '方法理解', text: '## Second note\n\nKeep this one too.' },
  ]);
  const [activeId, setActiveId] = useState('first');
  const [texts, setTexts] = useState<Record<string, string>>({ first: startingText, second: '## Second note\n\nKeep this one too.' });
  const [saveStatus, setSaveStatus] = useState('已保存');
  const activeText = texts[activeId] || '';

  function changeText(text: string) {
    setTexts((previous) => ({ ...previous, [activeId]: text }));
    setNotes((previous) => previous.map((note) => note.id === activeId ? { ...note, text } : note));
    setSaveStatus('未保存');
  }

  function createNote() {
    const note = { id: `created-${Date.now()}`, title: '新笔记', text: '' };
    setNotes((previous) => [...previous, note]);
    setTexts((previous) => ({ ...previous, [note.id]: '' }));
    setActiveId(note.id);
    setSaveStatus('已保存');
  }

  function deleteNote(id: string) {
    const remaining = notes.filter((note) => note.id !== id);
    setNotes(remaining);
    const next = remaining[0];
    if (next) setActiveId(next.id);
  }

  Object.assign(harnessWindow, { notes, activeId, texts });

  return <div id="panel" className="reader-notes-panel">
    <ReaderNotesPanel
      paperId="reader-notes-harness"
      notes={notes}
      activeNoteId={activeId}
      text={activeText}
      saveStatus={saveStatus}
      onChange={changeText}
      onSelectNote={(id) => { setActiveId(id); setSaveStatus('已保存'); }}
      onCreateNote={createNote}
      onRenameNote={(id, title) => setNotes((previous) => previous.map((note) => note.id === id ? { ...note, title } : note))}
      onDeleteNote={deleteNote}
      onSave={() => setSaveStatus('已保存')}
    >
      <div className="reader-annotations-heading"><h3>标注</h3><span>2 条</span></div>
      <div className="reader-annotations-list">
        <article className="reader-annotation-card">Annotation content stays in the lower pane.</article>
        <article className="reader-annotation-card">Another annotation.</article>
      </div>
    </ReaderNotesPanel>
  </div>;
}

createRoot(document.getElementById('harness')!).render(<NotesHarness />);
