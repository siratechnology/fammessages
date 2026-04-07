require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_IDS = (process.env.GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_URL   = (process.env.APP_URL || '').replace(/\/$/, '');
const PORT      = process.env.PORT || 3000;
const LOCAL_API = (process.env.LOCAL_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

const sessions = new Map();
function sid() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tg(method, body = {}) {
  const r = await fetch(`${LOCAL_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function tgForm(method, form) {
  const r = await fetch(`${LOCAL_API}/bot${BOT_TOKEN}/${method}`, { method: 'POST', body: form });
  return r.json();
}

async function sendFileMultipart(chatId, threadId, filePath, fileType, fileName, caption, parseMode) {
  const mime = fileType === 'photo' ? 'image/jpeg' : fileType === 'video' ? 'video/mp4' : 'application/octet-stream';
  const key = fileType === 'photo' ? 'photo' : fileType === 'video' ? 'video' : 'document';
  const method = 'send' + key[0].toUpperCase() + key.slice(1);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  form.append(key, fs.createReadStream(filePath), { filename: fileName || path.basename(filePath), contentType: mime });
  return tgForm(method, form);
}

// ── groups (parallel) ────────────────────────────────────────────────────────
app.get('/api/groups', async (req, res) => {
  try {
    const results = await Promise.all(GROUP_IDS.map(async id => {
      try {
        const r = await tg('getChat', { chat_id: parseInt(id) });
        if (r.ok) return { id: r.result.id, title: r.result.title || 'Unknown', type: r.result.type, is_forum: !!r.result.is_forum };
        return { id: parseInt(id), title: 'Chat ' + id, type: 'supergroup', is_forum: false, error: r.description };
      } catch(e) {
        return { id: parseInt(id), title: 'Chat ' + id, type: 'supergroup', is_forum: false, error: e.message };
      }
    }));
    res.json({ ok: true, groups: results });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── topics ───────────────────────────────────────────────────────────────────
app.get('/api/topics/:chatId', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    if (!GROUP_IDS.map(Number).includes(chatId)) return res.json({ ok: false, error: 'Not allowed' });
    const r = await tg('getForumTopics', { chat_id: chatId, limit: 100 });
    res.json(r);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── all topics at once ────────────────────────────────────────────────────────
app.post('/api/topics-bulk', async (req, res) => {
  try {
    const { chat_ids } = req.body;
    const allowed = GROUP_IDS.map(Number);
    const results = {};
    await Promise.all((chat_ids || []).map(async id => {
      if (!allowed.includes(id)) return;
      try {
        const r = await tg('getForumTopics', { chat_id: id, limit: 100 });
        results[id] = r.ok ? (r.result?.topics || []) : [];
      } catch(e) { results[id] = []; }
    }));
    res.json({ ok: true, results });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── session ───────────────────────────────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ ok: false, error: 'Session expired' });
  res.json({ ok: true, session: s });
});

// ── upload ───────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'No file received' });
  const mime = req.file.mimetype || '';
  const type = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : 'document';
  res.json({ ok: true, localPath: req.file.path, originalName: req.file.originalname, type, name: req.file.originalname, size: req.file.size });
});

// ── send ─────────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { chat_id, thread_id, items, layout, caption, parse_mode } = req.body;
    if (!GROUP_IDS.map(Number).includes(parseInt(chat_id))) return res.json({ ok: false, error: 'Not allowed' });

    const base = { chat_id };
    if (thread_id) base.message_thread_id = thread_id;
    const pm = parse_mode || '';

    // Text only
    if (!items || items.length === 0) {
      const r = await tg('sendMessage', { ...base, text: caption || '', ...(pm ? { parse_mode: pm } : {}) });
      return res.json(r);
    }

    async function sendOneItem(item, cap) {
      const fileId = item._cachedFileId || item.file_id;
      if (fileId) {
        const key = item.type === 'photo' ? 'photo' : item.type === 'video' ? 'video' : 'document';
        const method = 'send' + key[0].toUpperCase() + key.slice(1);
        return tg(method, { ...base, [key]: fileId, ...(cap ? { caption: cap } : {}), ...(pm ? { parse_mode: pm } : {}) });
      }
      if (item.localPath && fs.existsSync(item.localPath)) {
        const r = await sendFileMultipart(chat_id, thread_id, item.localPath, item.type, item.originalName, cap, pm);
        if (r.ok) {
          const msg = r.result;
          const fo = msg.photo ? msg.photo[msg.photo.length - 1] : msg.video || msg.document;
          if (fo?.file_id) item._cachedFileId = fo.file_id;
        }
        return r;
      }
      return { ok: false, description: 'No file source' };
    }

    if (items.length === 1) {
      const r = await sendOneItem(items[0], caption);
      return res.json(r.ok ? r : { ok: false, error: r.description });
    }

    // Multiple
    if (layout === 'album') {
      // Ensure all have file_ids first
      for (const item of items) {
        if (!item.file_id && !item._cachedFileId && item.localPath && fs.existsSync(item.localPath)) {
          const r = await sendFileMultipart(chat_id, null, item.localPath, item.type, item.originalName, '', '');
          if (r.ok) {
            const fo = r.result?.photo ? r.result.photo[r.result.photo.length-1] : r.result?.video || r.result?.document;
            if (fo?.file_id) {
              item._cachedFileId = fo.file_id;
              try { await tg('deleteMessage', { chat_id, message_id: r.result.message_id }); } catch(e) {}
            }
          }
        }
      }
      const chunks = [];
      for (let i = 0; i < items.length; i += 10) chunks.push(items.slice(i, i + 10));
      for (const chunk of chunks) {
        const media = chunk.map((item, idx) => ({
          type: item.type === 'photo' ? 'photo' : 'video',
          media: item._cachedFileId || item.file_id || '',
          ...(idx === 0 && caption ? { caption, ...(pm ? { parse_mode: pm } : {}) } : {})
        })).filter(m => m.media);
        if (media.length) { await tg('sendMediaGroup', { ...base, media }); await sleep(200); }
      }
    } else {
      for (const item of items) { await sendOneItem(item, item.caption || caption); await sleep(200); }
    }

    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── bot webhook ───────────────────────────────────────────────────────────────
app.post('/bot-webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text === '/start' || text === '/open') {
    await tg('sendMessage', { chat_id: chatId, text: '👇 کلیک بکە بۆ کردنەوەی ئەپ:',
      reply_markup: { inline_keyboard: [[{ text: '📨 کردنەوەی ئەپ', web_app: { url: APP_URL } }]] } });
    return;
  }

  let items = [], type = null;
  const cap = msg.caption || '';
  if (msg.photo) { const b = msg.photo[msg.photo.length-1]; items = [{type:'photo',file_id:b.file_id,name:'Photo'}]; type='photo'; }
  else if (msg.video) { items = [{type:'video',file_id:msg.video.file_id,name:msg.video.file_name||'Video'}]; type='video'; }
  else if (msg.document) { items = [{type:'document',file_id:msg.document.file_id,name:msg.document.file_name||'File'}]; type='document'; }

  if (items.length > 0) {
    const id = sid();
    sessions.set(id, { items, caption: cap, type });
    setTimeout(() => sessions.delete(id), 30*60*1000);
    await tg('sendMessage', { chat_id: chatId, text: `✅ فایل وەرگیرا!\n\nکام گروپ و تاپیک?`, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📨 هەڵبژاردن و ناردن', web_app: { url: APP_URL + '?session=' + id } }]] } });
    return;
  }

  if (text && !text.startsWith('/')) {
    const id = sid();
    sessions.set(id, { items: [], caption: text, type: 'text' });
    setTimeout(() => sessions.delete(id), 30*60*1000);
    await tg('sendMessage', { chat_id: chatId, text: `✅ پەیام ئامادەیە!\n\nکام گروپ و تاپیک?`,
      reply_markup: { inline_keyboard: [[{ text: '📨 هەڵبژاردن و ناردن', web_app: { url: APP_URL + '?session=' + id } }]] } });
  }
});

app.get('/setup-webhook', async (req, res) => {
  const r = await tg('setWebhook', { url: APP_URL + '/bot-webhook', allowed_updates: ['message'] });
  res.json(r);
});

['uploads','public/uploads','public/fonts'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });
app.listen(PORT, () => { console.log(`✅ Server on port ${PORT}\n📡 API: ${LOCAL_API}`); });
