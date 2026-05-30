require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- HELPERS ---
async function getUserProfile(normalizedUsername) {
  if (!normalizedUsername) return null;
  const { data } = await supabase.from('users').select('*').eq('username', normalizedUsername).maybeSingle();
  return data;
}

async function getDocumentsWithLockState(normalizedUsername) {
  const { data: docs } = await supabase.from('documents').select('*').order('id', { ascending: false });
  if (!docs) return [];

  let unlockedIds = [];
  if (normalizedUsername) {
    const { data: unlocked } = await supabase.from('unlocked_docs').select('doc_id').eq('username', normalizedUsername);
    unlockedIds = (unlocked || []).map(r => r.doc_id);
  }

  const { data: allVotes } = await supabase.from('votes').select('*');

  const result = [];
  for (const doc of docs) {
    const { data: comments } = await supabase.from('comments').select('user, text').eq('doc_id', doc.id);
    const isAuthor = normalizedUsername && doc.author.toLowerCase() === normalizedUsername;

    const docVotes = (allVotes || []).filter(v => v.doc_id === doc.id);
    const upCount = docVotes.filter(v => v.direction === 'up').length;
    const downCount = docVotes.filter(v => v.direction === 'down').length;
    const effectiveScore = doc.score + upCount - downCount;

    const userVote = normalizedUsername ? (docVotes.find(v => v.username === normalizedUsername)?.direction || null) : null;

    result.push({
      id: doc.id,
      subject: doc.subject,
      title: doc.title,
      author: doc.author,
      score: effectiveScore,
      userVote,
      hasFile: !!doc.file_path,
      comments: comments || [],
      locked: isAuthor ? false : !unlockedIds.includes(doc.id)
    });
  }
  return result;
}

async function getBounties() {
  const { data: bounties } = await supabase.from('bounties').select('*').eq('settled', false).order('id', { ascending: false });
  if (!bounties) return [];

  const result = [];
  for (const b of bounties) {
    const { data: rawAnswers } = await supabase.from('answers').select('*').eq('bounty_id', b.id);
    const answers = (rawAnswers || []).map(a => ({ ...a, fileName: a.file_name }));
    result.push({ ...b, fileName: b.file_name, settled: !!b.settled, answers });
  }
  return result;
}

// --- AUTH ---
app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const normalizedName = username.trim().toLowerCase();
  const { data: existing } = await supabase.from('users').select('username').eq('username', normalizedName).maybeSingle();
  if (existing) {
    return res.status(400).json({ error: "Username already registered." });
  }

  await supabase.from('users').insert({ username: normalizedName, email: email || null, password, tokens: 0, uploadsCount: 0 });
  res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const rawInput = username.trim().toLowerCase();

  const { data: user } = await supabase.from('users').select('*').or(`username.eq.${rawInput},email.eq.${rawInput}`).maybeSingle();

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid username/email or password." });
  }
  res.json({ success: true, username: user.username });
});

// --- VAULT DATA ---
app.get('/api/vault-data', async (req, res) => {
  const { user } = req.query;
  const normalizedName = user ? user.trim().toLowerCase() : null;
  const profile = await getUserProfile(normalizedName);

  res.json({
    state: {
      tokens: profile ? profile.tokens : 0,
      uploadsCount: profile ? profile.uploadsCount : 0,
      user: normalizedName || null
    },
    documents: await getDocumentsWithLockState(normalizedName),
    bounties: await getBounties()
  });
});

// --- UPLOAD DOCUMENT ---
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  const { title, subject, author } = req.body;
  if (!author) return res.status(401).json({ error: "Authentication required." });

  const normalizedName = author.trim().toLowerCase();
  const profile = await getUserProfile(normalizedName);
  if (!profile) return res.status(404).json({ error: "User not found." });
  if (!req.file) return res.status(400).json({ error: "PDF file is required." });

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const { data: existing } = await supabase.from('documents').select('id').eq('file_hash', fileHash).eq('author', normalizedName).maybeSingle();
  if (existing) {
    return res.status(400).json({ error: "You already uploaded this file. Duplicate uploads are not allowed." });
  }

  const fileName = `doc-${Date.now()}.pdf`;
  const { error: uploadError } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: 'application/pdf', upsert: true });
  if (uploadError) return res.status(500).json({ error: "File upload failed: " + uploadError.message });

  const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(fileName);

  await supabase.from('users').update({ tokens: profile.tokens + 5, uploadsCount: profile.uploadsCount + 1 }).eq('username', normalizedName);

  const docId = `doc-${Date.now()}`;
  await supabase.from('documents').insert({ id: docId, subject, title, author, score: 0, file_path: publicUrl, file_hash: fileHash });

  const updatedProfile = await getUserProfile(normalizedName);
  res.json({ success: true, tokens: updatedProfile.tokens, documents: await getDocumentsWithLockState(normalizedName) });
});

// --- DOWNLOAD DOCUMENT ---
app.get('/api/documents/download/:docId', async (req, res) => {
  const { docId } = req.params;
  const { user } = req.query;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const normalizedName = user.trim().toLowerCase();
  const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).maybeSingle();
  if (!doc) return res.status(404).json({ error: "Document not found." });

  const isAuthor = doc.author.toLowerCase() === normalizedName;
  const { data: hasUnlocked } = await supabase.from('unlocked_docs').select('doc_id').eq('username', normalizedName).eq('doc_id', docId).maybeSingle();

  if (!isAuthor && !hasUnlocked) {
    return res.status(403).json({ error: "You must unlock this document first." });
  }

  if (!doc.file_path) {
    return res.status(404).json({ error: "No file attached." });
  }

  // doc.file_path is the Supabase public URL — redirect the client
  res.redirect(doc.file_path);
});

// --- DELETE DOCUMENT ---
app.delete('/api/documents/delete/:docId', async (req, res) => {
  const { docId } = req.params;
  const { user } = req.query;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const normalizedName = user.trim().toLowerCase();
  const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).maybeSingle();
  if (!doc) return res.status(404).json({ error: "Document not found." });
  if (doc.author.toLowerCase() !== normalizedName) return res.status(403).json({ error: "Only the author can delete this document." });

  const fileName = doc.file_path?.split('/').pop();
  if (fileName) {
    await supabase.storage.from('documents').remove([fileName]);
  }

  await supabase.from('votes').delete().eq('doc_id', docId);
  await supabase.from('comments').delete().eq('doc_id', docId);
  await supabase.from('unlocked_docs').delete().eq('doc_id', docId);
  await supabase.from('documents').delete().eq('id', docId);

  const profile = await getUserProfile(normalizedName);
  res.json({ success: true, tokens: profile ? profile.tokens : 0, documents: await getDocumentsWithLockState(normalizedName) });
});

// --- UNLOCK DOCUMENT ---
app.post('/api/documents/unlock', async (req, res) => {
  const { docId, user } = req.body;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const normalizedName = user.trim().toLowerCase();
  const profile = await getUserProfile(normalizedName);
  if (!profile) return res.status(404).json({ error: "User not found." });
  if (profile.tokens < 1) return res.status(400).json({ error: "Insufficient tokens." });

  const { data: alreadyUnlocked } = await supabase.from('unlocked_docs').select('doc_id').eq('username', normalizedName).eq('doc_id', docId).maybeSingle();
  if (!alreadyUnlocked) {
    await supabase.from('users').update({ tokens: profile.tokens - 1 }).eq('username', normalizedName);
    await supabase.from('unlocked_docs').insert({ username: normalizedName, doc_id: docId });
  }

  const updatedProfile = await getUserProfile(normalizedName);
  res.json({ success: true, tokens: updatedProfile.tokens, documents: await getDocumentsWithLockState(normalizedName) });
});

// --- COMMENT ---
app.post('/api/documents/comment', async (req, res) => {
  const { docId, text, user } = req.body;
  const { data: doc } = await supabase.from('documents').select('id').eq('id', docId).maybeSingle();
  if (!doc) return res.status(404).json({ error: "Document not found." });

  await supabase.from('comments').insert({ doc_id: docId, user: user || "Anonymous", text });

  const normalizedName = user ? user.trim().toLowerCase() : null;
  res.json({ success: true, documents: await getDocumentsWithLockState(normalizedName) });
});

// --- VOTE ---
app.post('/api/documents/vote', async (req, res) => {
  const { docId, user, direction } = req.body;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const normalizedName = user.trim().toLowerCase();

  if (direction === null) {
    await supabase.from('votes').delete().eq('doc_id', docId).eq('username', normalizedName);
  } else if (direction === 'up' || direction === 'down') {
    await supabase.from('votes').upsert({ doc_id: docId, username: normalizedName, direction }, { onConflict: 'doc_id, username' });
  }

  res.json({ success: true, documents: await getDocumentsWithLockState(normalizedName) });
});

// --- CREATE BOUNTY ---
app.post('/api/bounties/create', async (req, res) => {
  const { title, subject, desc, fileName, author } = req.body;
  const normalizedName = author.trim().toLowerCase();
  const profile = await getUserProfile(normalizedName);
  if (!profile) return res.status(404).json({ error: "User not found." });
  if (profile.tokens < 3) return res.status(400).json({ error: "Insufficient tokens." });

  await supabase.from('users').update({ tokens: profile.tokens - 3 }).eq('username', normalizedName);

  const bountyId = `bounty-${Date.now()}`;
  await supabase.from('bounties').insert({ id: bountyId, subject, title, desc: desc, file_name: fileName || 'Specs_Attached.pdf', author });

  const updatedProfile = await getUserProfile(normalizedName);
  res.json({ success: true, tokens: updatedProfile.tokens, bounties: await getBounties() });
});

// --- FULFILL BOUNTY (submit answer, no tokens yet) ---
app.post('/api/bounties/fulfill', upload.single('file'), async (req, res) => {
  const { bountyId, text, user } = req.body;
  const normalizedName = user.trim().toLowerCase();

  const { data: bounty } = await supabase.from('bounties').select('id, settled').eq('id', bountyId).maybeSingle();
  if (!bounty) return res.status(404).json({ error: "Bounty not found." });
  if (bounty.settled) return res.status(400).json({ error: "This bounty is already settled." });

  let fileUrl = 'Solution_Breakdown.pdf';
  if (req.file) {
    const fileName = `answer-${Date.now()}.pdf`;
    const { error: uploadError } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(fileName);
      fileUrl = publicUrl;
    }
  }

  await supabase.from('answers').insert({ bounty_id: bountyId, user, text, file_name: fileUrl });

  const profile = await getUserProfile(normalizedName);
  res.json({ success: true, tokens: profile ? profile.tokens : 0, bounties: await getBounties() });
});

// --- ACCEPT ANSWER (author picks winner, +3 tokens to answerer) ---
app.post('/api/bounties/accept', async (req, res) => {
  try {
    const { bountyId, answerId, user } = req.body;
    const normalizedName = user.trim().toLowerCase();

    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', bountyId).maybeSingle();
    if (!bounty) return res.status(404).json({ error: "Bounty not found." });
    if (bounty.author.toLowerCase() !== normalizedName) return res.status(403).json({ error: "Only the bounty author can accept an answer." });
    if (bounty.settled) return res.status(400).json({ error: "Bounty already settled." });

    const { data: answer } = await supabase.from('answers').select('*').eq('id', answerId).eq('bounty_id', bountyId).maybeSingle();
    if (!answer) return res.status(404).json({ error: "Answer not found." });

    const answererProfile = await getUserProfile(answer.user.toLowerCase());
    if (answererProfile) {
      await supabase.from('users').update({ tokens: answererProfile.tokens + 3 }).eq('username', answer.user.toLowerCase());
    }

    await supabase.from('bounties').update({ settled: true }).eq('id', bountyId);
    await supabase.from('answers').update({ winner: true }).eq('id', answerId);

    const profile = await getUserProfile(normalizedName);
    res.json({ success: true, tokens: profile ? profile.tokens : 0, bounties: await getBounties() });
  } catch (err) {
    console.error('Accept error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n=============================================`);
  console.log(`📡 P2P Core Engine running at: http://localhost:${PORT}`);
  console.log(`=============================================\n`);
});
