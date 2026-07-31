import React, { useEffect, useRef, useState } from 'react';
import Dropdown from '../ui/Dropdown.jsx';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import { ChatIcon, CopyIcon, CheckIcon, ArrowUpIcon, StopIcon, ResetIcon, PlusIcon } from '../ui/Icons.jsx';
import { loadChats, saveChats, newChat, titleOf } from '../chatStore.js';

// Left-rail panel: talk to whatever CLI coding harness the user has installed
// (Claude Code or Codex). The harness runs with the open project as
// its cwd and edits files directly — the src/ watcher in electron/main.js
// pulls those edits back into the canvas.

// Harnesses print progress with colour and cursor tricks even under NO_COLOR;
// the log is plain text, so the escapes have to go.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r(?!\n)/g;
const clean = (s) => s.replace(ANSI, '');

const elapsed = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

// A canvas pick travels to the harness as plain prose. It names one node:
// the ancestor trail plus the sibling index and the literal opening tag
// disambiguate repeated markup, which a class alone would not.
const describe = (s) =>
  [
    'Work on this exact element (picked on the canvas):',
    `File: ${s.file}`,
    s.chain ? `Path: ${s.chain}` : null,
    s.nth ? `Position: child #${s.nth} of its parent` : null,
    s.open ? `Opening tag (verbatim in the file): ${s.open}` : `Node: ${s.tag}`,
    s.text ? `Contains text: ${JSON.stringify(s.text)}` : null,
    'Do not touch other elements that look similar.',
  ]
    .filter(Boolean)
    .join('\n');

export default function ChatPanel({ project, showToast, selection }) {
  const [harnesses, setHarnesses] = useState([]);
  const [harnessId, setHarnessId] = useState(() => localStorage.getItem('avb.harness') || '');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [chats, setChats] = useState(() => loadChats(project.path));
  const [chatId, setChatId] = useState(() => loadChats(project.path).at(-1).id);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [copied, setCopied] = useState(-1);
  const [detached, setDetached] = useState(''); // selection key the user dismissed

  const bodyRef = useRef(null);
  const stickRef = useRef(true); // was the log scrolled to the bottom?
  const lastRunRef = useRef(''); // `${chatId}:${harnessId}` of the last run
  const runChatRef = useRef(null); // chat the in-flight run belongs to

  const chat = chats.find((c) => c.id === chatId) || chats.at(-1);
  const messages = chat?.messages || [];

  // Edits always target one conversation by id: live output has to land in
  // the chat that started the run, even if the user switched away meanwhile.
  const updateChat = (id, fn) =>
    setChats((list) => {
      const next = list.map((c) =>
        c.id === id ? { ...c, messages: typeof fn === 'function' ? fn(c.messages) : fn } : c
      );
      saveChats(project.path, next);
      return next;
    });

  const setMessages = (fn) => updateChat(chatId, fn);

  useEffect(() => {
    window.avb
      .listHarnesses()
      .then((list) => {
        setHarnesses(list || []);
        setHarnessId((id) => (list?.some((h) => h.id === id) ? id : list?.[0]?.id || ''));
      })
      .catch((e) => setProbeError(String(e?.message || e)));
  }, []);

  // Model catalog per harness. Empty list = the CLI has no listing command,
  // so the field falls back to free text.
  useEffect(() => {
    if (!harnessId) return;
    localStorage.setItem('avb.harness', harnessId);
    setModel(localStorage.getItem(`avb.model.${harnessId}`) || '');
    setModels([]);
    let live = true;
    window.avb
      .listAgentModels(harnessId)
      .then((list) => live && setModels(list || []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [harnessId]);

  // Conversations are per-project.
  useEffect(() => {
    const list = loadChats(project.path);
    lastRunRef.current = '';
    setChats(list);
    setChatId(list.at(-1).id);
  }, [project.path]);

  // Live output. 'text' is the answer; reasoning and tool activity go to the
  // fold-away notes, so the bubble only ever shows what the model said.
  useEffect(
    () =>
      window.avb.onAgentChunk(({ kind, text }) => {
        const body = clean(text);
        if (!body.trim()) return;
        updateChat(runChatRef.current, (m) => {
          const last = m[m.length - 1];
          if (!last || last.role !== 'agent') return m;
          // Anything not explicitly marked as work is treated as the answer:
          // an unlabelled chunk belongs in the reply, not hidden in the notes.
          const next =
            kind !== 'thinking' && kind !== 'tool'
              ? { ...last, text: last.text + (last.text ? '\n\n' : '') + body }
              : { ...last, notes: [...(last.notes || []), { kind, text: body }] };
          return [...m.slice(0, -1), next];
        });
      }),
    []
  );

  // Follow the output, but stop fighting the user once they scroll up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const pickModel = (value) => {
    setModel(value);
    if (harnessId) localStorage.setItem(`avb.model.${harnessId}`, value);
    // A different model means a different session for most CLIs.
    lastRunRef.current = '';
  };

  const current = harnesses.find((h) => h.id === harnessId);
  // Dismissing only hides the current pick; selecting something else attaches again.
  const attached = selection && selection.key !== detached ? selection : null;

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy || !harnessId) return;
    setInput('');
    stickRef.current = true;
    setMessages((m) => [
      ...m,
      { role: 'you', text: prompt, attached: attached?.label },
      { role: 'agent', text: '', notes: [], name: current?.name || harnessId },
    ]);
    setBusy(true);
    runChatRef.current = chatId;
    const started = Date.now();
    // --continue resumes whatever ran last in this cwd, so it's only correct
    // when the last run came from this same chat and harness.
    const key = `${chatId}:${harnessId}`;
    const resume = lastRunRef.current === key;
    lastRunRef.current = key;
    const res = await window.avb.runAgent({
      harnessId,
      prompt: attached ? `${describe(attached)}\n\n${prompt}` : prompt,
      cwd: project.path,
      resume,
      model: model || undefined,
    });
    setBusy(false);
    const ms = Date.now() - started;
    updateChat(runChatRef.current, (m) => {
      const last = m[m.length - 1];
      if (!last || last.role !== 'agent') return m;
      // A harness whose output we couldn't classify still has to be readable:
      // if nothing came back as the answer, the notes become the answer.
      const notes = last.notes || [];
      const rescued = !last.text.trim() && notes.length;
      return [
        ...m.slice(0, -1),
        {
          ...last,
          ms,
          failed: !res?.ok && !res?.cancelled,
          snapshotId: res?.snapshotId,
          changes: res?.changes || [],
          text: rescued ? notes.map((n) => n.text).join('\n') : last.text,
          notes: rescued ? [] : notes,
        },
      ];
    });
    if (res?.error) showToast(res.error, 'error');
  };

  const stop = () => window.avb.cancelAgent();

  const clear = () => {
    lastRunRef.current = '';
    setMessages([]);
  };

  const startChat = () => {
    const chat = newChat();
    lastRunRef.current = '';
    setChats((list) => {
      const next = [...list, chat];
      saveChats(project.path, next);
      return next;
    });
    setChatId(chat.id);
  };

  const deleteChat = () => {
    lastRunRef.current = '';
    setChats((list) => {
      const rest = list.filter((c) => c.id !== chatId);
      const next = rest.length ? rest : [newChat()];
      saveChats(project.path, next);
      setChatId(next.at(-1).id);
      return next;
    });
  };

  const copy = (text, i) => {
    navigator.clipboard.writeText(text);
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1200);
  };

  // Undo a run: only the files it changed go back to their pre-run content.
  const revert = async (msgIndex) => {
    const msg = messages[msgIndex];
    if (!msg?.snapshotId) return;
    const res = await window.avb.revertAgentRun({
      snapshotId: msg.snapshotId,
      cwd: project.path,
      files: msg.changes,
    });
    if (!res?.ok) return showToast(res?.error || 'Could not revert', 'error');
    showToast(`Reverted ${res.files} file${res.files > 1 ? 's' : ''}`, 'info');
    // Reverting invalidates the harness's idea of the files, so the next
    // message starts a fresh session instead of resuming a stale one.
    lastRunRef.current = '';
    setMessages((m) =>
      m.map((x, i) => (i >= msgIndex ? { ...x, snapshotId: null, reverted: true } : x))
    );
  };

  // Esc stops a run without reaching for the button.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e) => e.key === 'Escape' && stop();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  return (
    <div className="panel-section grow chat-panel">
      <div className="panel-header">
        <h2>
          <ChatIcon size={13} /> Chat
        </h2>
        {harnesses.length > 0 && (
          <button className="ghost" title="New chat" onClick={startChat} disabled={busy}>
            <PlusIcon size={14} />
          </button>
        )}
      </div>

      {harnesses.length === 0 ? (
        <div className="chat-empty">
          {probeError
            ? `Could not reach the harness probe — restart Stacki. (${probeError})`
            : 'No coding CLI found on your PATH. Install Claude Code or Codex, then reopen Stacki.'}
        </div>
      ) : (
        <>
          <div className="chat-harness">
            {chats.length > 1 && (
              <Dropdown
                className="chat-list"
                value={chat.id}
                options={chats.map((c, i) => ({ value: c.id, label: titleOf(c, i) }))}
                onChange={(id) => {
                  lastRunRef.current = '';
                  setChatId(id);
                }}
                livePreview={false}
              />
            )}
            <Dropdown
              value={harnessId}
              options={harnesses.map((h) => ({ value: h.id, label: h.name }))}
              onChange={setHarnessId}
              livePreview={false}
            />
            {current?.canPickModel &&
              (models.length ? (
                <Dropdown
                  value={model}
                  options={[
                    { value: '', label: 'Default model' },
                    ...models.map((m) => ({ value: m, label: m })),
                  ]}
                  onChange={pickModel}
                  livePreview={false}
                />
              ) : (
                <input
                  value={model}
                  placeholder="Default model"
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={(e) => pickModel(e.target.value.trim())}
                />
              ))}
          </div>

          <div className="chat-log" ref={bodyRef} onScroll={onScroll}>
            {messages.length === 0 && (
              <div className="chat-empty">
                Ask for a change and {current?.name || 'the harness'} applies it to{' '}
                {project.name || 'this project'} on disk. The canvas updates as files land.
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'you' ? (
                <div key={i} className="chat-msg you">
                  {m.attached && <span className="chat-attached">{m.attached}</span>}
                  {m.text}
                </div>
              ) : (
                <div key={i} className={`chat-msg agent ${m.failed ? 'failed' : ''}`}>
                  <div className="chat-msg-head">
                    <ChatIcon size={12} />
                    <span className="chat-msg-name">{m.name}</span>
                    {m.ms != null && <span className="chat-msg-time">{elapsed(m.ms)}</span>}
                    {!!m.text && (
                      <button
                        className="ghost chat-copy"
                        title="Copy output"
                        onClick={() => copy(m.text, i)}
                      >
                        {copied === i ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                      </button>
                    )}
                  </div>
                  {m.notes?.length > 0 && (
                    <details className="chat-notes">
                      <summary>
                        {m.notes.length} step{m.notes.length > 1 ? 's' : ''}
                      </summary>
                      {m.notes.map((n, j) => (
                        <div key={j} className={`chat-note ${n.kind || 'tool'}`}>
                          {n.text}
                        </div>
                      ))}
                    </details>
                  )}
                  {m.text ? (
                    <pre className="chat-msg-body">{m.text}</pre>
                  ) : (
                    <div className="chat-dots">
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  {m.changes?.length > 0 && (
                    <div className="chat-diff">
                      {m.changes.map((f) => (
                        <details key={f.path}>
                          <summary>
                            <span className={`chat-diff-status ${f.status}`} />
                            <span className="chat-diff-path">{f.path}</span>
                            {f.added > 0 && <span className="chat-diff-add">+{f.added}</span>}
                            {f.removed > 0 && <span className="chat-diff-del">−{f.removed}</span>}
                          </summary>
                          {f.preview.map((l, k) => (
                            <div key={k} className={l.sign === '+' ? 'chat-diff-add' : 'chat-diff-del'}>
                              {l.sign} {l.text}
                            </div>
                          ))}
                        </details>
                      ))}
                    </div>
                  )}
                  {m.snapshotId && !busy && (
                    <button className="ghost chat-revert" onClick={() => revert(i)}>
                      <ResetIcon size={11} /> Revert {m.changes.length} file
                      {m.changes.length > 1 ? 's' : ''}
                    </button>
                  )}
                  {m.reverted && <div className="chat-note">reverted</div>}
                </div>
              )
            )}
          </div>

          {(messages.length > 0 || chats.length > 1) && (
            <div className="chat-actions">
              {chats.length > 1 && (
                <button className="ghost" onClick={deleteChat} disabled={busy}>
                  Delete chat
                </button>
              )}
              {messages.length > 0 && (
                <button className="ghost" onClick={clear} disabled={busy}>
                  Clear
                </button>
              )}
            </div>
          )}

          {attached && (
            <div className="chat-attach">
              <span className="chat-attach-chip" title={`${attached.tag} in ${attached.file}`}>
                {attached.label}
                <button className="ghost" title="Detach" onClick={() => setDetached(attached.key)}>
                  ×
                </button>
              </span>
              <span className="chat-attach-file">{attached.file}</span>
            </div>
          )}
          <div className="chat-input">
            <AutoTextarea
              minRows={2}
              value={input}
              placeholder={`Describe a change… (${busy ? 'Esc stops' : 'Enter sends'})`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {busy ? (
              <button className="chat-send stop" title="Stop (Esc)" onClick={stop}>
                <StopIcon size={13} />
              </button>
            ) : (
              <button
                className="chat-send primary"
                title="Send (Enter)"
                onClick={send}
                disabled={!input.trim()}
              >
                <ArrowUpIcon size={14} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
