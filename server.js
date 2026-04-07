require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const FormData = require('form-data');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Static class structure ────────────────────────────────────────────────────
const CLASS_STRUCTURE = [
  { grade: '1', groups: ['A','B','C','D','E','F','G','H','I','J'] },
  { grade: '2', groups: ['A','B','C','D','E','F','G','H'] },
  { grade: '3', groups: ['A','B','C','D','E','F','G','H'] },
  { grade: '4', groups: ['A','B','C','D','E','F','G','H'] },
  { grade: '5', groups: ['A','B','C','D','E','F'] },
  { grade: '6', groups: ['A','B','C','D','E'] },
  { grade: '7', groups: ['A','B','C','D'] },
  { grade: '8', groups: ['A','B','C','D'] },
  { grade: '9', groups: ['A','B','C'] }
];

const BOT_TOKEN   = process.env.BOT_TOKEN;
const RAW_IDS     = (process.env.GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_URL     = (process.env.APP_URL || '').replace(/\/$/, '');
const PORT        = process.env.PORT || 3000;
const LOCAL_API   = (process.env.LOCAL_API_URL || '').replace(/\/$/, '');

// Official API — always reliable
const OFFICIAL    = 'https://api.telegram.org';

// Build group map from class structure + IDs in order
const GROUP_MAP = [];
let idxMap = 0;
for (const cls of CLASS_STRUCTURE) {
  for (const letter of cls.groups) {
    if (idxMap < RAW_IDS.length) {
      GROUP_MAP.push({
        id:     parseInt(RAW_IDS[idxMap]),
        name:   cls.grade + letter,
        grade:  cls.grade,
        letter: letter
      });
      idxMap++;
    }
  }
}

const ALLOWED_IDS = new Set(GROUP_MAP.map(g => g.id));

// Topic cache: groupId -> [{id, name}]
const topicCache = new Map();

// Session store
const sessions = new Map();
function newSid() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API helpers ───────────────────────────────────────────────────────────────

// Use local API if configured, else official
function apiBase() { return LOCAL_API || OFFICIAL; }

async function tg(method, body = {}, useOfficial = false) {
  const base = useOfficial ? OFFICIAL : apiBase();
  const r = await fetch(`${base}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// Send file as buffer (most reliable)
async function sendFileBuffer(chatId, threadId, filePath, fileType, fileName, caption, parseMode, useOfficial = false) {
  const base = useOfficial ? OFFICIAL : apiBase();
  const key = fileType === 'photo' ? 'photo' : fileType === 'video' ? 'video' : 'document';
  const method = 'send' + key[0].toUpperCase() + key.slice(1);
  const mime = fileType === 'photo' ? 'image/jpeg' : fileType === 'video' ? 'video/mp4' : 'application/octet-stream';

  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  form.append(key, buf, { filename: fileName || path.basename(filePath), contentType: mime });

  const r = await fetch(`${base}/bot${BOT_TOKEN}/${method}`, { method: 'POST', body: form });
  return r.json();
}

// ── /api/groups — static, instant ────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  // Group by grade
  const grades = {};
  for (const g of GROUP_MAP) {
    if (!grades[g.grade]) grades[g.grade] = [];
    grades[g.grade].push({ id: g.id, name: g.name, grade: g.grade, letter: g.letter });
  }
  res.json({ ok: true, grades });
});

// ── /api/topics/:chatId — use official API always ─────────────────────────────
app.get('/api/topics/:chatId', async (req, res) => {
  const chatId = parseInt(req.params.chatId);
  if (!ALLOWED_IDS.has(chatId)) return res.json({ ok: false, error: 'Not allowed' });

  // Return cached if available
  if (topicCache.has(chatId)) return res.json({ ok: true, topics: topicCache.get(chatId) });

  try {
    const r = await tg('getForumTopics', { chat_id: chatId, limit: 100 }, true); // always official
    if (r.ok && r.result?.topics) {
      const topics = r.result.topics.map(t => ({ id: t.message_thread_id, name: t.name }));
      topicCache.set(chatId, topics);
      return res.json({ ok: true, topics });
    }
    // Not a forum or no topics
    topicCache.set(chatId, []);
    return res.json({ ok: true, topics: [] });
  } catch(e) {
    return res.json({ ok: true, topics: [] });
  }
});

// ── /api/topics-bulk ──────────────────────────────────────────────────────────
app.post('/api/topics-bulk', async (req, res) => {
  const { chat_ids } = req.body;
  const results = {};
  const toFetch = (chat_ids || []).filter(id => ALLOWED_IDS.has(id) && !topicCache.has(id));

  // Fetch uncached in parallel (batches of 5)
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    await Promise.all(batch.map(async id => {
      try {
        const r = await tg('getForumTopics', { chat_id: id, limit: 100 }, true);
        const topics = (r.ok && r.result?.topics) ? r.result.topics.map(t => ({ id: t.message_thread_id, name: t.name })) : [];
        topicCache.set(id, topics);
      } catch(e) { topicCache.set(id, []); }
    }));
    if (i + 5 < toFetch.length) await sleep(300); // avoid rate limit
  }

  for (const id of (chat_ids || [])) {
    if (ALLOWED_IDS.has(id)) results[id] = topicCache.get(id) || [];
  }
  res.json({ ok: true, results });
});

// ── /api/session ──────────────────────────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ ok: false, error: 'Session expired' });
  res.json({ ok: true, session: s });
});

// ── /api/upload ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'No file received' });
  const mime = req.file.mimetype || '';
  const type = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : 'document';
  res.json({ ok: true, localPath: req.file.path, originalName: req.file.originalname, type, name: req.file.originalname });
});

// ── /api/send ─────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { chat_id, thread_id, items, layout, caption, parse_mode } = req.body;
    const cid = parseInt(chat_id);
    if (!ALLOWED_IDS.has(cid)) return res.json({ ok: false, error: 'Not allowed' });

    const base = { chat_id: cid };
    if (thread_id) base.message_thread_id = thread_id;
    const pm = parse_mode || '';

    // ── Text only ──
    if (!items || items.length === 0) {
      const r = await tg('sendMessage', { ...base, text: caption || '', ...(pm ? { parse_mode: pm } : {}) });
      return res.json(r.ok ? { ok: true } : { ok: false, error: r.description });
    }

    // ── Helper: send one item ──
    async function sendOne(item, cap) {
      // Use cached file_id first
      const fid = item._cachedFileId || item.file_id;
      if (fid) {
        const key = item.type === 'photo' ? 'photo' : item.type === 'video' ? 'video' : 'document';
        const r = await tg('send' + key[0].toUpperCase() + key.slice(1), {
          ...base,
          [key]: fid,
          ...(cap ? { caption: cap } : {}),
          ...(pm ? { parse_mode: pm } : {})
        });
        return r;
      }

      // Local file — send as buffer
      if (item.localPath && fs.existsSync(item.localPath)) {
        // Try with current API first
        let r = await sendFileBuffer(cid, thread_id, item.localPath, item.type, item.originalName, cap, pm, false);

        // If failed, try official API
        if (!r.ok && apiBase() !== OFFICIAL) {
          console.log(`Local API failed for ${item.name}, trying official...`);
          r = await sendFileBuffer(cid, thread_id, item.localPath, item.type, item.originalName, cap, pm, true);
        }

        // Cache file_id for next targets
        if (r.ok) {
          const msg = r.result;
          const fo = msg?.photo ? msg.photo[msg.photo.length - 1] : msg?.video || msg?.document;
          if (fo?.file_id) item._cachedFileId = fo.file_id;
        } else {
          console.error('Send file failed:', r.description || JSON.stringify(r));
        }
        return r;
      }

      return { ok: false, description: 'No file source available' };
    }

    // ── Single item ──
    if (items.length === 1) {
      const r = await sendOne(items[0], caption);
      return res.json(r.ok ? { ok: true } : { ok: false, error: r.description });
    }

    // ── Multiple items: album ──
    if (layout === 'album') {
      // First pass: ensure all items have file_id by sending to this chat and deleting
      for (const item of items) {
        if (!item.file_id && !item._cachedFileId && item.localPath && fs.existsSync(item.localPath)) {
          const r = await sendFileBuffer(cid, null, item.localPath, item.type, item.originalName, '', '', true);
          if (r.ok) {
            const fo = r.result?.photo ? r.result.photo[r.result.photo.length-1] : r.result?.video || r.result?.document;
            if (fo?.file_id) {
              item._cachedFileId = fo.file_id;
              try { await tg('deleteMessage', { chat_id: cid, message_id: r.result.message_id }, true); } catch(e) {}
            }
          }
        }
      }

      const chunks = [];
      for (let i = 0; i < items.length; i += 10) chunks.push(items.slice(i, i + 10));
      for (const chunk of chunks) {
        const media = chunk.map((item, idx) => ({
          type: item.type === 'document' ? 'document' : item.type === 'video' ? 'video' : 'photo',
          media: item._cachedFileId || item.file_id || '',
          ...(idx === 0 && caption ? { caption, ...(pm ? { parse_mode: pm } : {}) } : {})
        })).filter(m => m.media);
        if (media.length) { await tg('sendMediaGroup', { ...base, media }); await sleep(300); }
      }
    } else {
      // Send separately
      for (const item of items) {
        await sendOne(item, item.caption || caption);
        await sleep(200);
      }
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('/api/send error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Bot Webhook ───────────────────────────────────────────────────────────────
app.post('/bot-webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text === '/start' || text === '/open') {
    await tg('sendMessage', {
      chat_id: chatId, text: '👇 کلیک بکە بۆ کردنەوەی ئەپ:',
      reply_markup: { inline_keyboard: [[{ text: '📨 کردنەوەی ئەپ', web_app: { url: APP_URL } }]] }
    });
    return;
  }

  let items = [], type = null, cap = msg.caption || '';
  if (msg.photo) { const b = msg.photo[msg.photo.length-1]; items=[{type:'photo',file_id:b.file_id,name:'Photo'}]; type='photo'; }
  else if (msg.video) { items=[{type:'video',file_id:msg.video.file_id,name:msg.video.file_name||'Video'}]; type='video'; }
  else if (msg.document) { items=[{type:'document',file_id:msg.document.file_id,name:msg.document.file_name||'File'}]; type='document'; }

  if (items.length > 0) {
    const id = newSid();
    sessions.set(id, { items, caption: cap, type });
    setTimeout(() => sessions.delete(id), 30*60*1000);
    await tg('sendMessage', {
      chat_id: chatId, text: `✅ فایل وەرگیرا! (${type})\n\nکام گروپ و تاپیک?`,
      reply_markup: { inline_keyboard: [[{ text: '📨 هەڵبژاردن و ناردن', web_app: { url: APP_URL + '?session=' + id } }]] }
    });
    return;
  }

  if (text && !text.startsWith('/')) {
    const id = newSid();
    sessions.set(id, { items: [], caption: text, type: 'text' });
    setTimeout(() => sessions.delete(id), 30*60*1000);
    await tg('sendMessage', {
      chat_id: chatId, text: `✅ پەیام ئامادەیە!\n\nکام گروپ و تاپیک?`,
      reply_markup: { inline_keyboard: [[{ text: '📨 هەڵبژاردن و ناردن', web_app: { url: APP_URL + '?session=' + id } }]] }
    });
  }
});

app.get('/setup-webhook', async (req, res) => {
  const r = await tg('setWebhook', { url: APP_URL + '/bot-webhook', allowed_updates: ['message'] }, true);
  res.json(r);
});

['uploads','public/uploads','public/fonts'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`📡 API: ${apiBase()}`);
  console.log(`📚 ${GROUP_MAP.length} groups loaded statically`);
});
