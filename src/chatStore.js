// Conversations for the chat panel, kept outside React so switching left-rail
// tabs (which unmounts the panel) doesn't throw a conversation away, and
// mirrored to localStorage so restarting the app doesn't either.

const KEY = (projectPath) => `avb.chats.${projectPath}`;
const MAX_CHATS = 20;
const MAX_TEXT = 20000; // per message; agent output can run long

const cache = new Map(); // projectPath -> chats[]

const newChat = () => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: '', messages: [] });

export function loadChats(projectPath) {
  if (cache.has(projectPath)) return cache.get(projectPath);
  let chats = [];
  try {
    chats = JSON.parse(localStorage.getItem(KEY(projectPath)) || '[]');
  } catch {
    chats = [];
  }
  if (!Array.isArray(chats) || chats.length === 0) chats = [newChat()];
  cache.set(projectPath, chats);
  return chats;
}

export function saveChats(projectPath, chats) {
  cache.set(projectPath, chats);
  const trimmed = chats.slice(-MAX_CHATS).map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({ ...m, text: String(m.text || '').slice(0, MAX_TEXT) })),
  }));
  try {
    localStorage.setItem(KEY(projectPath), JSON.stringify(trimmed));
  } catch {
    /* quota — the in-memory copy still holds this session */
  }
}

export { newChat };

// The first thing asked, which is what makes a conversation recognisable.
export function titleOf(chat, index) {
  if (chat.title) return chat.title;
  const first = chat.messages.find((m) => m.role === 'you');
  if (!first) return `Chat ${index + 1}`;
  const line = first.text.split('\n')[0].trim();
  return line.length > 38 ? `${line.slice(0, 38)}…` : line;
}
