require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public', { maxAge: 0, etag: false }));

// Track last active timestamp for any request with a user identifier
app.use((req, res, next) => {
  const user = req.query.user || req.body?.user;
  if (user && typeof user === 'string' && user.trim()) {
    const normalized = user.trim().toLowerCase();
    supabase.from('users').update({ last_active: new Date().toISOString() }).eq('username', normalized).then().catch(() => {});
  }
  next();
});

// Run migration on startup
(async () => {
  try {
    await supabase.rpc('exec_sql', { sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ' });
  } catch (_) {}
  try {
    await supabase.rpc('exec_sql', { sql: "ALTER TABLE documents ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT false" });
  } catch (_) {}
})();

// --- HELPERS ---
async function getUserProfile(normalizedUsername) {
  if (!normalizedUsername) return null;
  const { data } = await supabase.from('users').select('*').eq('username', normalizedUsername).maybeSingle();
  return data;
}

async function getDocumentsWithLockState(normalizedUsername) {
  let isAdmin = false;
  if (normalizedUsername) {
    const viewer = await getUserProfile(normalizedUsername);
    isAdmin = viewer && viewer.admin === true;
  }

  let query = supabase.from('documents').select('*').order('id', { ascending: false });
  // Non-admin sees only their own pending docs + all approved docs
  if (!isAdmin && normalizedUsername) {
    query = query.or(`approved.eq.true,author.eq.${normalizedUsername}`);
  } else if (!isAdmin) {
    query = query.eq('approved', true);
  }
  const { data: docs } = await query;
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
      locked: isAuthor ? false : !unlockedIds.includes(doc.id),
      filiere: doc.filiere,
      niveau: doc.niveau,
      matiere: doc.matiere,
      type: doc.type,
      approved: doc.approved === true
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
  if (user.banned) {
    return res.status(403).json({ error: "Your account has been banned." });
  }
  res.json({ success: true, username: user.username });
});

// --- CHANGE USERNAME ---
app.post('/api/auth/change-username', async (req, res) => {
  const { user, newUsername } = req.body;
  if (!user || !newUsername) return res.status(400).json({ error: "Current username and new username required." });
  const oldName = user.trim().toLowerCase();
  const newName = newUsername.trim().toLowerCase();
  if (oldName === newName) return res.status(400).json({ error: "New username is the same as current." });

  const { data: existing } = await supabase.from('users').select('username').eq('username', newName).maybeSingle();
  if (existing) return res.status(400).json({ error: "Username already taken." });

  const profile = await getUserProfile(oldName);
  if (!profile) return res.status(404).json({ error: "User not found." });

  // Update username in all tables
  await supabase.from('users').update({ username: newName }).eq('username', oldName);
  await supabase.from('documents').update({ author: newName }).eq('author', oldName);
  await supabase.from('unlocked_docs').update({ username: newName }).eq('username', oldName);
  await supabase.from('comments').update({ user: newName }).eq('user', oldName);
  await supabase.from('votes').update({ username: newName }).eq('username', oldName);
  await supabase.from('bounties').update({ author: newName }).eq('author', oldName);
  await supabase.from('answers').update({ user: newName }).eq('user', oldName);

  res.json({ success: true, username: newName });
});

// --- CHANGE PASSWORD ---
app.post('/api/auth/change-password', async (req, res) => {
  const { user, currentPassword, newPassword } = req.body;
  if (!user || !currentPassword || !newPassword) return res.status(400).json({ error: "All fields required." });
  const normalizedName = user.trim().toLowerCase();
  const profile = await getUserProfile(normalizedName);
  if (!profile) return res.status(404).json({ error: "User not found." });
  if (profile.password !== currentPassword) return res.status(400).json({ error: "Current password is incorrect." });
  await supabase.from('users').update({ password: newPassword }).eq('username', normalizedName);
  res.json({ success: true });
});

// --- AVATAR UPLOAD ---
app.post('/api/auth/avatar', upload.single('avatar'), async (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(401).json({ error: "Authentication required." });
  if (!req.file) return res.status(400).json({ error: "JPG file is required." });
  if (req.file.mimetype !== 'image/jpeg') return res.status(400).json({ error: "Only JPG images are allowed." });

  const normalizedName = user.trim().toLowerCase();
  const ext = 'jpg';
  const fileName = `avatar-${normalizedName}.${ext}`;
  const { error: uploadError } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) return res.status(500).json({ error: "Avatar upload failed: " + uploadError.message });

  const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(fileName);
  await supabase.from('users').update({ avatar_url: publicUrl }).eq('username', normalizedName);
  res.json({ success: true, avatar_url: publicUrl });
});

// --- USER PROFILE ---
app.get('/api/users/:username/profile', async (req, res) => {
  const { username } = req.params;
  const { user } = req.query;
  const normalizedName = username.trim().toLowerCase();
  const profile = await getUserProfile(normalizedName);
  if (!profile) return res.status(404).json({ error: "User not found." });

  // Track visit if viewer is not the profile owner
  if (!user || user.trim().toLowerCase() !== normalizedName) {
    await supabase.from('users').update({ profile_visits: (profile.profile_visits || 0) + 1 }).eq('username', normalizedName);
  }

  const docs = await getDocumentsWithLockState(user ? user.trim().toLowerCase() : null);
  const userDocs = docs.filter(d => d.author?.toLowerCase() === normalizedName);

  // Compute vote stats across all user's documents
  const { data: allUserDocVotes } = await supabase.from('votes').select('direction, doc_id');
  const userDocIds = userDocs.map(d => d.id);
  const userVotes = (allUserDocVotes || []).filter(v => userDocIds.includes(v.doc_id));
  const totalUpvotes = userVotes.filter(v => v.direction === 'up').length;
  const totalDownvotes = userVotes.filter(v => v.direction === 'down').length;

  // Count how many times user's docs were unlocked (bought)
  let totalDownloads = 0;
  for (const docId of userDocIds) {
    const { count } = await supabase.from('unlocked_docs').select('*', { count: 'exact', head: true }).eq('doc_id', docId);
    totalDownloads += count || 0;
  }

  res.json({
    username: profile.username,
    email: profile.email,
    avatar_url: profile.avatar_url,
    uploadsCount: userDocs.length,
    tokens: profile.tokens,
    profile_visits: (profile.profile_visits || 0) + (user && user.trim().toLowerCase() !== normalizedName ? 1 : 0),
    totalUpvotes,
    totalDownvotes,
    totalDownloads,
    documents: userDocs
  });
});

// --- VAULT DATA ---
app.get('/api/vault-data', async (req, res) => {
  const { user } = req.query;
  const normalizedName = user ? user.trim().toLowerCase() : null;
  const profile = await getUserProfile(normalizedName);

  if (profile && profile.banned) {
    return res.json({
      state: { tokens: 0, uploadsCount: 0, user: normalizedName, admin: false, banned: true },
      documents: [],
      bounties: []
    });
  }

  const docs = await getDocumentsWithLockState(normalizedName);
  const bounties = await getBounties();

  // Compute user stats
  let totalUpvotes = 0, totalDownvotes = 0, totalDownloads = 0;
  if (profile && docs.length > 0) {
    const userDocIds = docs.filter(d => d.author?.toLowerCase() === normalizedName).map(d => d.id);
    const { data: allUserDocVotes } = await supabase.from('votes').select('direction, doc_id');
    const userVotes = (allUserDocVotes || []).filter(v => userDocIds.includes(v.doc_id));
    totalUpvotes = userVotes.filter(v => v.direction === 'up').length;
    totalDownvotes = userVotes.filter(v => v.direction === 'down').length;
    for (const docId of userDocIds) {
      const { count } = await supabase.from('unlocked_docs').select('*', { count: 'exact', head: true }).eq('doc_id', docId);
      totalDownloads += count || 0;
    }
  }

  res.json({
    state: {
      tokens: profile ? profile.tokens : 0,
      uploadsCount: profile ? docs.filter(d => d.author?.toLowerCase() === normalizedName).length : 0,
      user: normalizedName || null,
      admin: profile ? !!profile.admin : false,
      banned: profile ? !!profile.banned : false,
      avatar_url: profile ? profile.avatar_url : null,
      profile_visits: profile ? (profile.profile_visits || 0) : 0,
      totalUpvotes,
      totalDownvotes,
      totalDownloads
    },
    documents: docs,
    bounties
  });
});

// --- AI CONTENT CHECK ---
async function checkDocumentContent(pdfBuffer, metadata) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: 'models/gemini-2.0-flash-lite' });
    const prompt = `You are a content moderator for an academic study platform. Users upload PDF documents to share educational materials with other students.
A document was uploaded with these details:
- Subject category: "${metadata.subject}"
- Filière (track): "${metadata.filiere || 'N/A'}"
- Level: "${metadata.niveau || 'N/A'}"
- Course/Matière: "${metadata.matiere || 'N/A'}"
- Type: "${metadata.type || 'N/A'}"
- Title: "${metadata.title}"

The actual PDF is attached below. Analyze its content — both text and images.

IMPORTANT: The actual PDF content must match the declared metadata. For example, if someone claims "Mathematics / Exam" but the PDF contains a cooking recipe, a magazine article, sports, entertainment, advertising, or anything non-academic, it must be rejected. The title and subject must honestly describe the content.

Determine if this PDF is genuinely academic/educational study material (exercises, exams, courses, lecture notes, problem sets, corrections, formulas, diagrams, etc.) AND the declared metadata accurately describes the actual content.

Reply with ONLY a single JSON object:
{"isAcademic": true/false, "reason": "brief one-line explanation"}

Set isAcademic to false if: the content doesn't match the declared subject/filière/type, or it contains spam, ads, malware, irrelevant personal content, non-educational entertainment, or anything that doesn't help students study.`;
    const result = await model.generateContent([
      { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { text: prompt }
    ]);
    const responseText = result.response.text().trim();
    const jsonMatch = responseText.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error('AI check error:', err.message);
    return null; // fall back to pending
  }
}

// --- UPLOAD DOCUMENT ---
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  const { title, subject, author, filiere, niveau, matiere, type } = req.body;
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

  const docId = `doc-${Date.now()}`;

  // AI check — sends the PDF directly to Gemini (handles both text and scanned docs)
  let aiResult = null;
  let approved = false;
  let rejectionReason = null;
  try {
    aiResult = await checkDocumentContent(req.file.buffer, { subject, filiere, niveau, matiere, type, title });
    if (aiResult) {
      if (aiResult.isAcademic === true) {
        approved = true;
      } else {
        rejectionReason = aiResult.reason || 'Content not recognized as academic study material.';
      }
    }
    // aiResult null → fall through to pending
  } catch (err) {
    console.error('AI check error:', err.message);
  }

  if (rejectionReason) {
    // AI rejected → delete the uploaded file and return error
    await supabase.storage.from('documents').remove([fileName]).catch(() => {});
    return res.status(400).json({ error: `Upload rejected: ${rejectionReason}` });
  }

  await supabase.from('documents').insert({ id: docId, subject, title, author, score: 0, file_path: publicUrl, file_hash: fileHash, filiere, niveau, matiere, type, approved });

  if (approved) {
    await supabase.from('users').update({ tokens: profile.tokens + 5, uploadsCount: profile.uploadsCount + 1 }).eq('username', normalizedName);
  } else {
    await supabase.from('users').update({ uploadsCount: profile.uploadsCount + 1 }).eq('username', normalizedName);
  }

  const updatedProfile = await getUserProfile(normalizedName);
  res.json({
    success: true,
    tokens: updatedProfile.tokens,
    uploadsCount: updatedProfile.uploadsCount,
    documents: await getDocumentsWithLockState(normalizedName),
    pending: !approved,
    approved
  });
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
  const { data: viewerProfile } = await supabase.from('users').select('admin').eq('username', normalizedName).maybeSingle();
  const isAdmin = viewerProfile && viewerProfile.admin === true;

  if (!isAuthor && !hasUnlocked && !isAdmin) {
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
  await supabase.from('users').update({ uploadsCount: supabase.raw('GREATEST(uploadsCount - 1, 0)') }).eq('username', normalizedName);

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

// --- ADMIN ROUTES ---
async function requireAdmin(user) {
  if (!user) return false;
  const profile = await getUserProfile(user.trim().toLowerCase());
  return profile && profile.admin === true;
}

app.get('/api/admin/users', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const { data: users } = await supabase.from('users').select('*').order('username');
  const enriched = [];
  for (const u of users || []) {
    const { count: docCount } = await supabase.from('documents').select('*', { count: 'exact', head: true }).eq('author', u.username);
    // Also count unsettled bounties posted by each user
    const { count: bountyCount } = await supabase.from('bounties').select('*', { count: 'exact', head: true }).eq('author', u.username).eq('settled', false);
    enriched.push({ ...u, uploadsCount: docCount || 0, bountiesCount: bountyCount || 0 });
  }
  res.json(enriched);
});

app.get('/api/admin/stats', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalDocs } = await supabase.from('documents').select('*', { count: 'exact', head: true });
  const { count: totalBounties } = await supabase.from('bounties').select('*', { count: 'exact', head: true }).eq('settled', false);
  res.json({ totalUsers, totalDocs, totalBounties });
});

app.get('/api/admin/online-count', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('last_active', thirtyMinAgo);
  res.json({ online: count || 0 });
});

app.get('/api/admin/pending-docs', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const { data: docs } = await supabase.from('documents').select('*').eq('approved', false).order('id', { ascending: false });
  res.json(docs || []);
});

app.post('/api/admin/documents/:docId/approve', async (req, res) => {
  if (!await requireAdmin(req.body.user)) return res.status(403).json({ error: "Admin access required." });
  const { docId } = req.params;
  const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).maybeSingle();
  if (!doc) return res.status(404).json({ error: "Document not found." });
  if (doc.approved) return res.status(400).json({ error: "Already approved." });
  await supabase.from('documents').update({ approved: true }).eq('id', docId);
  const authorName = doc.author?.toLowerCase();
  if (authorName) {
    const { data: authorProfile } = await supabase.from('users').select('tokens').eq('username', authorName).maybeSingle();
    if (authorProfile) {
      await supabase.from('users').update({ tokens: authorProfile.tokens + 5 }).eq('username', authorName);
    }
  }
  res.json({ success: true });
});

app.delete('/api/admin/documents/:docId', async (req, res) => {
  const { user } = req.query;
  if (!await requireAdmin(user)) return res.status(403).json({ error: "Admin access required." });
  const { docId } = req.params;
  const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).maybeSingle();
  if (!doc) return res.status(404).json({ error: "Document not found." });
  const fileName = doc.file_path?.split('/').pop();
  if (fileName) await supabase.storage.from('documents').remove([fileName]);
  await supabase.from('votes').delete().eq('doc_id', docId);
  await supabase.from('comments').delete().eq('doc_id', docId);
  await supabase.from('unlocked_docs').delete().eq('doc_id', docId);
  await supabase.from('documents').delete().eq('id', docId);
  const authorName = doc.author?.toLowerCase();
  if (authorName) {
    const { data: authorProfile } = await supabase.from('users').select('uploadsCount').eq('username', authorName).maybeSingle();
    if (authorProfile) {
      await supabase.from('users').update({ uploadsCount: Math.max(0, authorProfile.uploadsCount - 1) }).eq('username', authorName);
    }
  }
  res.json({ success: true });
});

app.delete('/api/admin/bounties/:bountyId', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const { bountyId } = req.params;
  await supabase.from('answers').delete().eq('bounty_id', bountyId);
  await supabase.from('bounties').delete().eq('id', bountyId);
  res.json({ success: true, bounties: await getBounties() });
});

app.post('/api/admin/users/tokens', async (req, res) => {
  if (!await requireAdmin(req.body.user)) return res.status(403).json({ error: "Admin access required." });
  const { targetUser, amount } = req.body;
  if (!targetUser || amount === undefined) return res.status(400).json({ error: "targetUser and amount required." });
  const profile = await getUserProfile(targetUser.trim().toLowerCase());
  if (!profile) return res.status(404).json({ error: "User not found." });
  await supabase.from('users').update({ tokens: profile.tokens + amount }).eq('username', targetUser.trim().toLowerCase());
  res.json({ success: true, newBalance: profile.tokens + amount });
});

app.post('/api/admin/users/ban', async (req, res) => {
  if (!await requireAdmin(req.body.user)) return res.status(403).json({ error: "Admin access required." });
  const { targetUser, banned } = req.body;
  if (!targetUser) return res.status(400).json({ error: "targetUser required." });
  const profile = await getUserProfile(targetUser.trim().toLowerCase());
  if (!profile) return res.status(404).json({ error: "User not found." });
  if (profile.admin) return res.status(400).json({ error: "Cannot ban another admin." });
  await supabase.from('users').update({ banned: !!banned }).eq('username', targetUser.trim().toLowerCase());
  res.json({ success: true, banned: !!banned });
});

app.delete('/api/admin/users/:username/documents', async (req, res) => {
  if (!await requireAdmin(req.query.user)) return res.status(403).json({ error: "Admin access required." });
  const { username } = req.params;
  const { data: docs } = await supabase.from('documents').select('id, file_path').eq('author', username);
  for (const doc of docs || []) {
    const fileName = doc.file_path?.split('/').pop();
    if (fileName) await supabase.storage.from('documents').remove([fileName]);
    await supabase.from('votes').delete().eq('doc_id', doc.id);
    await supabase.from('comments').delete().eq('doc_id', doc.id);
    await supabase.from('unlocked_docs').delete().eq('doc_id', doc.id);
  }
  await supabase.from('documents').delete().eq('author', username);
  await supabase.from('users').update({ uploadsCount: 0 }).eq('username', username);
  const { count: totalDocs } = await supabase.from('documents').select('*', { count: 'exact', head: true });
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalBounties } = await supabase.from('bounties').select('*', { count: 'exact', head: true }).eq('settled', false);
  res.json({ success: true, deleted: docs?.length || 0, totalDocs, totalUsers, totalBounties });
});

app.listen(PORT, () => {
  console.log(`\n=============================================`);
  console.log(`📡 P2P Core Engine running at: http://localhost:${PORT}`);
  console.log(`=============================================\n`);
});
