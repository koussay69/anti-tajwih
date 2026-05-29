document.addEventListener('DOMContentLoaded', () => {

    // --- APP STATE ENGINE ---
    let state = {
        tokens: 10,
        uploadsCount: 0,
        user: localStorage.getItem('p2p-vault-user') || null
    };

    let activeTicketForAnswer = null;
    const API_URL = window.location.origin + '/api';

    // --- LIVE SYNCHRONIZER: DATABASE TO UI ---
    async function loadVaultData() {
        try {
            if (state.user) {
                if (navAuthBtn) navAuthBtn.innerText = `Hi, ${state.user}`;
                const profileHeader = document.querySelector('.account-user-name');
                if (profileHeader) profileHeader.innerText = state.user;
            }

            // FIXED: Fired dynamic matching query parameters with context signatures
            const response = await fetch(`${API_URL}/vault-data?user=${encodeURIComponent(state.user || '')}`);
            if (!response.ok) throw new Error("Server communication degradation.");
            const data = await response.json();

            state.tokens = data.state.tokens;
            state.uploadsCount = data.state.uploadsCount;

            updateTokenUI();

            if (data.documents) {
                renderDocuments(data.documents);
            }
            if (data.bounties) {
                renderBounties(data.bounties);
            }
        } catch (err) {
            showToast("Failed to sync with backend ledger database. Running offline.", "error");
        }
    }

    function updateTokenUI() {
        document.getElementById('global-token-count').innerText = state.tokens;
        document.getElementById('account-token-display').innerText = state.tokens;
        document.getElementById('account-upload-display').innerText = state.uploadsCount;
    }

    // --- TOAST NOTIFICATION UTILITY FUNCTION ---
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        let prefix = "⚡ Info: ";
        if (type === 'error') prefix = "❌ Error: ";
        if (type === 'bounty') prefix = "💰 Vault Alert: ";

        toast.innerText = `${prefix}${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 4000);
    }

    // --- REAL-TIME DARK / LIGHT THEME CONTROLLER ---
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const htmlRoot = document.documentElement;

    const savedTheme = localStorage.getItem('p2p-vault-theme') || 'light';
    htmlRoot.setAttribute('data-theme', savedTheme);

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = htmlRoot.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

            htmlRoot.setAttribute('data-theme', newTheme);
            localStorage.setItem('p2p-vault-theme', newTheme);
            showToast(`Theme changed to ${newTheme} mode!`, 'info');
        });
    }

    // --- ROUTING & NAV SYSTEM ---
    const navLinks = document.querySelectorAll('.nav-link, #nav-account-btn, #logo-btn');
    const sections = document.querySelectorAll('.view-section');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('data-target') || 'browse-view';

            document.querySelectorAll('.nav-link').forEach(nl => nl.classList.remove('active'));
            if (link.classList.contains('nav-link')) {
                link.classList.add('active');
            }

            sections.forEach(section => section.classList.add('hidden'));
            const activeSection = document.getElementById(targetId);
            if (activeSection) activeSection.classList.remove('hidden');
        });
    });

    // --- REFACTORED MODAL SYSTEM (GUARDED INTERCEPTIONS) ---
    const authModal = document.getElementById('auth-modal');
    const uploadModal = document.getElementById('upload-modal');
    const helpModal = document.getElementById('help-modal');
    const answerModal = document.getElementById('answer-modal');

    const navAuthBtn = document.getElementById('nav-auth-btn');
    const navUploadBtn = document.getElementById('nav-upload-btn');
    const openHelpModalBtn = document.getElementById('open-help-modal-btn');

    const closeAuth = document.getElementById('close-auth-modal');
    const closeUpload = document.getElementById('close-upload-modal');
    const closeHelp = document.getElementById('close-help-modal');
    const closeAnswer = document.getElementById('close-answer-modal');

    if (navAuthBtn) navAuthBtn.addEventListener('click', () => authModal.classList.add('open'));

    if (navUploadBtn) {
        navUploadBtn.addEventListener('click', () => {
            if (!state.user) {
                showToast("Please sign in to upload architectural assets.", "error");
                authModal.classList.add('open');
            } else {
                uploadModal.classList.add('open');
            }
        });
    }

    if (openHelpModalBtn) {
        openHelpModalBtn.addEventListener('click', () => {
            if (!state.user) {
                showToast("Please sign in to launch an SOS bounty ticket.", "error");
                authModal.classList.add('open');
            } else {
                helpModal.classList.add('open');
            }
        });
    }

    if (closeAuth) closeAuth.addEventListener('click', () => authModal.classList.remove('open'));
    if (closeUpload) closeUpload.addEventListener('click', () => uploadModal.classList.remove('open'));
    if (closeHelp) closeHelp.addEventListener('click', () => helpModal.classList.remove('open'));
    if (closeAnswer) closeAnswer.addEventListener('click', () => answerModal.classList.remove('open'));

    window.addEventListener('click', (e) => {
        if (e.target === authModal) authModal.classList.remove('open');
        if (e.target === uploadModal) uploadModal.classList.remove('open');
        if (e.target === helpModal) helpModal.classList.remove('open');
        if (e.target === answerModal) answerModal.classList.remove('open');
    });

    // --- DYNAMIC CARD BUILDER GENERATORS ---
    function renderDocuments(documents) {
        const targetContainer = document.getElementById('primary-feed-target');
        const myUploadsSection = document.getElementById('user-uploads-target-container');
        const savedContainer = document.getElementById('saved-docs-target-container');

        const placeholderUploads = document.getElementById('no-uploads-placeholder');
        const placeholderSaved = document.getElementById('no-saved-placeholder');

        if (targetContainer) targetContainer.innerHTML = '';
        if (myUploadsSection) myUploadsSection.innerHTML = '';
        if (savedContainer) savedContainer.innerHTML = '';

        let hasUploads = false;
        let hasSaved = false;
        const currentSignature = state.user ? state.user : null;

        documents.forEach(doc => {
            const isDocLockedForSession = state.user ? doc.locked : true;

            const card = document.createElement('div');
            card.className = 'doc-card';
            card.dataset.id = doc.id;
            card.dataset.userVote = doc.userVote || '';

            const upActive = doc.userVote === 'up' ? ' active' : '';
            const downActive = doc.userVote === 'down' ? ' active' : '';

            card.innerHTML = `
                <div class="card-meta-top">
                    <span class="doc-subject">${doc.subject}</span>
                    <span class="lock-indicator status-text" style="${!isDocLockedForSession ? 'color: green;' : ''}">${isDocLockedForSession ? '🔒 LOCKED' : '✓ UNLOCKED'}</span>
                </div>
                <h3 class="doc-title">${doc.title}</h3>
                <p class="doc-author">By: ${doc.author} • 🌟 ${doc.score ? doc.score + '/5 (' + doc.comments.length + ' reviews)' : 'No reviews yet'}</p>
                <button class="toggle-comments-btn">// View Reviews & Comments (${doc.comments ? doc.comments.length : 0})</button>
                <div class="card-comments-tray hidden">
                    <div class="comments-list">
                        ${doc.comments ? doc.comments.map(c => `<div class="comment-item"><strong>${c.user}:</strong> ${c.text}</div>`).join('') : ''}
                    </div>
                    <div class="comment-input-box">
                        <input type="text" placeholder="Ask a question or leave a review..." class="inline-comment-input">
                        <button class="post-comment-btn">Send</button>
                    </div>
                </div>
                <div class="card-footer">
                    <div class="voting-system">
                        <button class="vote-arrow up${upActive}">▲</button>
                        <span class="vote-count">${doc.score || 0}</span>
                        <button class="vote-arrow down${downActive}">▼</button>
                    </div>
                    ${isDocLockedForSession ? `<button class="buy-document-trigger unlock-action-btn">Unlock (-1 Token)</button>` : ''}
                    ${!isDocLockedForSession && doc.hasFile ? `<a class="unlock-action-btn download-btn" href="${API_URL}/documents/download/${doc.id}?user=${encodeURIComponent(state.user || '')}" target="_blank" style="text-decoration:none; display:inline-block;">⬇ Download PDF</a>` : ''}
                </div>
            `;

            setupDocumentCardInteractions(card);

            if (targetContainer) targetContainer.appendChild(card);

            if (currentSignature && doc.author === currentSignature) {
                hasUploads = true;
                if (myUploadsSection) {
                    const clone = card.cloneNode(true);
                    const insideBuyBtn = clone.querySelector('.buy-document-trigger');
                    if (insideBuyBtn) insideBuyBtn.remove();
                    const insideStatusText = clone.querySelector('.status-text');
                    if (insideStatusText) {
                        insideStatusText.innerText = "✓ ACTIVE SHARED";
                        insideStatusText.style.color = "green";
                    }
                    myUploadsSection.appendChild(clone);
                    setupDocumentCardInteractions(clone);
                }
            }

            if (currentSignature && !doc.locked && doc.author !== currentSignature) {
                hasSaved = true;
                if (savedContainer) {
                    const clone = card.cloneNode(true);
                    const insideBuyBtn = clone.querySelector('.buy-document-trigger');
                    if (insideBuyBtn) insideBuyBtn.remove();
                    savedContainer.appendChild(clone);
                    setupDocumentCardInteractions(clone);
                }
            }
        });

        if (placeholderUploads) {
            if (hasUploads) placeholderUploads.classList.add('hidden');
            else placeholderUploads.classList.remove('hidden');
        }
        if (placeholderSaved) {
            if (hasSaved) placeholderSaved.classList.add('hidden');
            else placeholderSaved.classList.remove('hidden');
        }
    }

    function renderBounties(bounties) {
        const helpBoardGrid = document.getElementById('help-board-grid');
        if (!helpBoardGrid) return;
        helpBoardGrid.innerHTML = '';

        bounties.forEach(bounty => {
            const ticketCard = document.createElement('div');
            ticketCard.className = 'help-ticket-card';
            ticketCard.dataset.id = bounty.id;

            ticketCard.innerHTML = `
                <div class="ticket-top">
                    <span class="ticket-badge-tag">${bounty.subject}</span>
                    <span class="ticket-bounty">Bounty Placed 💰</span>
                </div>
                <h3 class="ticket-title">${bounty.title}</h3>
                <p class="ticket-desc">${bounty.desc}</p>
                <div class="ticket-attachment-badge">📎 Reference Attached: <strong>${bounty.fileName || 'Specs_Attached.pdf'}</strong></div>
                <div class="ticket-answers-list">
                    ${bounty.answers ? bounty.answers.map(ans => `
                        <div class="comment-item" style="padding: 12px; background: var(--bg-tray); border-left: 3px solid var(--glow-secondary); margin-top: 10px;">
                            <strong>${ans.user}:</strong> ${ans.text}
                            <div style="font-size:12px; margin-top:6px; color:var(--text-main); font-weight:500;">📎 Shared Answer: <span style="text-decoration:underline; cursor:pointer; color:var(--glow-color);">${ans.fileName}</span></div>
                            <span style="color:green; font-size:11px; display:block; margin-top:6px; font-weight:600;">[Bounty Settled ✓ +3 Tokens Paid]</span>
                        </div>
                    `).join('') : ''}
                </div>
                <div class="ticket-footer">
                    <span class="ticket-user">By: ${bounty.author === state.user ? 'You' : bounty.author}</span>
                    ${(!bounty.answers || bounty.answers.length === 0) ? `<button class="unlock-action-btn provide-answer-trigger">Manage Request</button>` : ''}
                </div>
            `;
            setupHelpTicketInteractions(ticketCard);
            helpBoardGrid.appendChild(ticketCard);
        });
    }

    // --- VOTING ENGINE ---
    async function submitVote(cardElement, direction) {
        const docId = cardElement.dataset.id;
        try {
            const res = await fetch(`${API_URL}/documents/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docId, user: state.user, direction })
            });
            const data = await res.json();
            if (res.ok) {
                renderDocuments(data.documents);
            }
        } catch (err) {
            showToast("Vote submission failed.", "error");
        }
    }

    function initializeVotingSystem(cardElement) {
        const upBtn = cardElement.querySelector('.vote-arrow.up');
        const downBtn = cardElement.querySelector('.vote-arrow.down');

        if (!upBtn || !downBtn) return;

        upBtn.addEventListener('click', () => {
            if (!state.user) {
                showToast("Please sign in to vote on documents.", "error");
                authModal.classList.add('open');
                return;
            }
            const currentVote = cardElement.dataset.userVote;
            const newDirection = currentVote === 'up' ? null : 'up';
            submitVote(cardElement, newDirection);
        });

        downBtn.addEventListener('click', () => {
            if (!state.user) {
                showToast("Please sign in to vote on documents.", "error");
                authModal.classList.add('open');
                return;
            }
            const currentVote = cardElement.dataset.userVote;
            const newDirection = currentVote === 'down' ? null : 'down';
            submitVote(cardElement, newDirection);
        });
    }

    // --- CARD INTERACTION MECHANICS ---
    function setupDocumentCardInteractions(card) {
        initializeVotingSystem(card);

        const buyBtn = card.querySelector('.buy-document-trigger');
        const toggleBtn = card.querySelector('.toggle-comments-btn');
        const tray = card.querySelector('.card-comments-tray');
        const postBtn = card.querySelector('.post-comment-btn');
        const inputField = card.querySelector('.inline-comment-input');
        const list = card.querySelector('.comments-list');
        const docId = card.dataset.id;

        if (buyBtn) {
            buyBtn.addEventListener('click', async () => {
                if (!state.user) {
                    showToast("Please sign in to unlock repository content.", "error");
                    authModal.classList.add('open');
                    return;
                }

                if (state.tokens < 1) {
                    showToast("Insufficient token balance to unlock document.", "error");
                    return;
                }

                try {
                    // FIXED: Now accurately ships active user profile context strings
                    const res = await fetch(`${API_URL}/documents/unlock`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ docId, user: state.user })
                    });
                    const data = await res.json();

                    if (res.ok) {
                        state.tokens = data.tokens;
                        updateTokenUI();
                        showToast("Document library access verified (-1 Token)", "info");
                        renderDocuments(data.documents);
                    } else {
                        showToast(data.error || "Unlock processing failed.", "error");
                    }
                } catch (err) {
                    showToast("Network pipeline transaction timeout.", "error");
                }
            });
        }

        if (toggleBtn && tray) {
            toggleBtn.addEventListener('click', () => tray.classList.toggle('hidden'));
        }

        if (postBtn && inputField && list) {
            postBtn.addEventListener('click', async () => {
                if (!state.user) {
                    showToast("Please sign in to submit peer reviews.", "error");
                    authModal.classList.add('open');
                    return;
                }

                const commentText = inputField.value.trim();
                if (commentText === "") return;

                const workingUser = state.user;

                try {
                    const res = await fetch(`${API_URL}/documents/comment`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ docId, text: commentText, user: workingUser })
                    });
                    const data = await res.json();

                    if (res.ok) {
                        renderDocuments(data.documents);
                        inputField.value = "";
                        showToast("Peer review submitted to pipeline", "info");
                    }
                } catch (err) {
                    const newComment = document.createElement('div');
                    newComment.className = 'comment-item';
                    newComment.innerHTML = `<strong>${workingUser}:</strong> ${commentText}`;
                    list.appendChild(newComment);
                    inputField.value = "";
                    showToast("Review attached to local session pipeline.", "info");
                }
            });
        }
    }

    // --- TICKET MANAGEMENT INTERFACES ---
    function setupHelpTicketInteractions(ticket) {
        const answerTrigger = ticket.querySelector('.provide-answer-trigger');
        if (!answerTrigger) return;

        answerTrigger.addEventListener('click', () => {
            if (!state.user) {
                showToast("Please sign in to provide solution proposals.", "error");
                authModal.classList.add('open');
                return;
            }

            const authorSignature = ticket.querySelector('.ticket-user').innerText;
            if (authorSignature.includes('By: You') || authorSignature.includes(`By: ${state.user}`)) {
                showToast("Self-bounty actions are locked on this node.", "error");
                return;
            }

            activeTicketForAnswer = ticket;
            answerModal.classList.add('open');
        });
    }

    // --- SHARE MATERIAL SUBMITTER ENGINE ---
    const uploadForm = document.getElementById('upload-form');
    if (uploadForm) {
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.user) return;

            const titleVal = document.getElementById('form-doc-title').value;
            const subjectVal = document.getElementById('form-doc-subject').value;
            const fileInput = document.getElementById('form-upload-file');
            const file = fileInput.files[0];
            if (!file) {
                showToast("Please select a PDF file to upload.", "error");
                return;
            }

            const formData = new FormData();
            formData.append('title', titleVal);
            formData.append('subject', subjectVal);
            formData.append('author', state.user);
            formData.append('file', file);

            try {
                const res = await fetch(`${API_URL}/documents/upload`, {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();

                if (res.ok) {
                    state.tokens = data.tokens;
                    state.uploadsCount += 1;

                    updateTokenUI();
                    showToast("Asset distribution complete! (+5 Tokens Reward)", "bounty");

                    renderDocuments(data.documents);
                    uploadForm.reset();
                    uploadModal.classList.remove('open');
                } else {
                    showToast(data.error || "Submission rejected by broker.", "error");
                }
            } catch (err) {
                showToast("Critical ledger dispatch framework error.", "error");
            }
        });
    }

    // --- SOS BROADCAST BOUNTY STATEMENT FORM ---
    const helpForm = document.getElementById('help-form');
    if (helpForm) {
        helpForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.user) return;

            if (state.tokens < 3) {
                showToast("Insufficient token reserve to clear statement processing fee.", "error");
                helpModal.classList.remove('open');
                return;
            }

            const hSubject = document.getElementById('form-help-subject').value;
            const hTitle = document.getElementById('form-help-title').value;
            const hDesc = document.getElementById('form-help-desc').value;
            const hFileInput = document.getElementById('form-help-file');

            const fileName = hFileInput.files[0] ? hFileInput.files[0].name : "Specs_Attached.pdf";
            const userDisplay = state.user;

            try {
                const res = await fetch(`${API_URL}/bounties/create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: hTitle,
                        subject: hSubject,
                        desc: hDesc,
                        fileName: fileName,
                        author: userDisplay
                    })
                });
                const data = await res.json();

                if (res.ok) {
                    state.tokens = data.tokens;
                    updateTokenUI();
                    showToast("Bounty network pool established (-3 Tokens)", "info");

                    renderBounties(data.bounties);
                    helpForm.reset();
                    helpModal.classList.remove('open');
                } else {
                    showToast(data.error || "Bounty verification rejected.", "error");
                }
            } catch (err) {
                showToast("Critical framework breakdown posting bounty ledger contract.", "error");
            }
        });
    }

    // --- SUBMIT ANSWER MODULE INTEGRATION ---
    const answerForm = document.getElementById('answer-form');
    if (answerForm) {
        answerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!activeTicketForAnswer || !state.user) return;

            const answerDesc = document.getElementById('form-answer-desc').value;
            const answerFileInput = document.getElementById('form-answer-file');
            const uploadedSolutionName = answerFileInput.files[0] ? answerFileInput.files[0].name : "Solution_Breakdown.pdf";
            const bountyId = activeTicketForAnswer.dataset.id;
            const activeNodeName = state.user;

            try {
                const res = await fetch(`${API_URL}/bounties/fulfill`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bountyId,
                        text: answerDesc,
                        fileName: uploadedSolutionName,
                        user: activeNodeName
                    })
                });
                const data = await res.json();

                if (res.ok) {
                    state.tokens = data.tokens;
                    updateTokenUI();
                    showToast("Bounty verified by network peer node (+3 Tokens)", "bounty");
                    renderBounties(data.bounties);

                    answerForm.reset();
                    answerModal.classList.remove('open'); // FIXED: Removed broken .open property reference
                    activeTicketForAnswer = null;
                }
            } catch (err) {
                // Network pipeline failure offline sandbox emulation state management
                state.tokens += 3;
                updateTokenUI();
                showToast("Bounty processed locally (+3 Tokens)", "bounty");

                const answersWrapper = activeTicketForAnswer.querySelector('.ticket-answers-list');
                if (answersWrapper) {
                    const responseBlock = document.createElement('div');
                    responseBlock.className = 'comment-item';
                    responseBlock.style.padding = '12px';
                    responseBlock.style.background = 'var(--bg-tray)';
                    responseBlock.style.borderLeft = '3px solid var(--glow-secondary)';
                    responseBlock.style.marginTop = '10px';

                    responseBlock.innerHTML = `
                        <strong>${activeNodeName}:</strong> ${answerDesc.trim()}
                        <div style="font-size:12px; margin-top:6px; color:var(--text-main); font-weight:500;">📎 Shared Answer: <span style="text-decoration:underline; cursor:pointer; color:var(--glow-color);">${uploadedSolutionName}</span></div>
                        <span style="color:green; font-size:11px; display:block; margin-top:6px; font-weight:600;">[Bounty Settled ✓ +3 Tokens Paid]</span>
                    `;
                    answersWrapper.appendChild(responseBlock);
                }

                const currentTriggerButton = activeTicketForAnswer.querySelector('.provide-answer-trigger');
                if (currentTriggerButton) currentTriggerButton.remove();

                answerForm.reset();
                answerModal.classList.remove('open');
                activeTicketForAnswer = null;
            }
        });
    }

    // --- LOCAL SEARCH ENGINE ---
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            const browseCards = document.querySelectorAll('#browse-view .feed-column .doc-card, #primary-feed-target .doc-card');

            browseCards.forEach(card => {
                const titleText = card.querySelector('.doc-title')?.innerText.toLowerCase() || '';
                const subjectText = card.querySelector('.doc-subject')?.innerText.toLowerCase() || '';

                if (titleText.includes(query) || subjectText.includes(query)) {
                    card.classList.remove('hidden');
                } else {
                    card.classList.add('hidden');
                }
            });
        });
    }

    // --- AUTHENTICATION LIFECYCLE ---
    const authForm = document.getElementById('auth-form');
    const authToggleLink = document.getElementById('auth-toggle-link');
    const authModalTitle = document.getElementById('auth-modal-title');
    const logoutMockBtn = document.getElementById('logout-mock-btn');
    let isSignUpMode = false;

    if (authToggleLink && authModalTitle) {
        authToggleLink.addEventListener('click', (e) => {
            e.preventDefault();
            isSignUpMode = !isSignUpMode;
            const label = document.getElementById('form-auth-label');
            const input = document.getElementById('form-auth-input');
            const emailGroup = document.getElementById('form-auth-email-group');
            if (isSignUpMode) {
                authModalTitle.innerText = "Create Your Account";
                authToggleLink.innerText = "Sign In instead";
                if (label) label.innerText = "Choose a Username";
                if (input) { input.type = "text"; input.placeholder = "your-username"; }
                if (emailGroup) emailGroup.style.display = "";
            } else {
                authModalTitle.innerText = "Sign In to Anti-Tajwih";
                authToggleLink.innerText = "Create an Account (Sign Up)";
                if (label) label.innerText = "Email or Username";
                if (input) { input.type = "text"; input.placeholder = "name@example.com or username"; }
                if (emailGroup) emailGroup.style.display = "none";
            }
        });
    }

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const rawValue = document.getElementById('form-auth-input').value;
            const password = document.getElementById('form-auth-password').value;
            const email = document.getElementById('form-auth-email')?.value || '';
            const parsedName = isSignUpMode ? rawValue.trim() : rawValue.trim();

            const endpoint = isSignUpMode ? `${API_URL}/auth/register` : `${API_URL}/auth/login`;
            const body = isSignUpMode
                ? { username: parsedName, password, email }
                : { username: parsedName, password };

            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                if (!res.ok) {
                    showToast(data.error || "Authentication failed.", "error");
                    return;
                }

                const loggedInName = data.username || parsedName;
                state.user = loggedInName;
                localStorage.setItem('p2p-vault-user', loggedInName);

                if (navAuthBtn) navAuthBtn.innerText = `Hi, ${loggedInName}`;

                const profileHeader = document.querySelector('.account-user-name');
                if (profileHeader) profileHeader.innerText = loggedInName;

                authForm.reset();
                authModal.classList.remove('open');
                showToast(`Logged in as ${loggedInName}`, "info");

                loadVaultData();
            } catch (err) {
                showToast("Network error during authentication.", "error");
            }
        });
    }

    if (logoutMockBtn) {
        logoutMockBtn.addEventListener('click', () => {
            state.user = null;
            localStorage.removeItem('p2p-vault-user');

            if (navAuthBtn) navAuthBtn.innerText = "Sign In";
            const profileHeader = document.querySelector('.account-user-name');
            if (profileHeader) profileHeader.innerText = "Anonymous Student";
            showToast("Session disconnected from node network.", "info");

            loadVaultData();
        });
    }

    // Boot execution sync pipeline
    loadVaultData();
});