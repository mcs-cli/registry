function copyInstall(e, cmd) {
  e.stopPropagation();
  e.preventDefault();
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = e.currentTarget;
    const textEl = btn.querySelector('.install-text');
    const original = textEl.textContent;
    textEl.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      textEl.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // -- Fade-in observer (same as main site) --
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add('visible');
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

  // -- Count-up animation --
  function animateCountUp(el, target, duration = 1200) {
    const start = parseInt(el.textContent, 10) || 0;
    if (start === target) return;
    const startTime = performance.now();
    function easeOutExpo(t) {
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(progress);
      el.textContent = Math.round(start + (target - start) * eased);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // -- State --
  let currentSort = 'stars';
  let debounceTimer = null;
  let isFirstLoad = true;
  let statsAnimated = false;
  const packsCache = new Map();

  // -- Elements --
  const searchInput = document.getElementById('search-input');
  const packsGrid = document.getElementById('packs-grid');
  const packsEmpty = document.getElementById('packs-empty');
  const packsLoading = document.getElementById('packs-loading');
  const sortBtns = document.querySelectorAll('.sort-btn');
  const submitForm = document.getElementById('submit-form');
  const submitResult = document.getElementById('submit-result');
  const submitBtn = document.getElementById('submit-btn');
  const packModal = document.getElementById('pack-modal');
  const packModalInner = packModal.querySelector('.pack-modal-inner');

  // -- Init: load from URL query or default --
  const params = new URLSearchParams(window.location.search);
  const initialQuery = params.get('q') || '';
  if (initialQuery) searchInput.value = initialQuery;
  loadPacks(initialQuery, currentSort);

  // -- Search --
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const query = searchInput.value.trim();
      updateUrlQuery(query);
      loadPacks(query, currentSort);
    }, 300);
  });

  // -- Sort --
  sortBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sortBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      loadPacks(searchInput.value.trim(), currentSort);
    });
  });

  // -- Submit form --
  submitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const repoUrl = document.getElementById('repo-url').value.trim();
    const honeypot = document.getElementById('website').value;

    if (!repoUrl) return;

    // Get Turnstile token
    const turnstileToken = typeof turnstile !== 'undefined'
      ? turnstile.getResponse()
      : '';

    if (!turnstileToken && typeof turnstile !== 'undefined') {
      showResult('error', 'Please complete the verification challenge.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const response = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, turnstileToken, honeypot }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        showResult('success', `Pack <strong>${escapeHtml(data.pack.displayName)}</strong> added to the registry!`);
        document.getElementById('repo-url').value = '';
        // Reload packs to update count and show the new pack
        loadPacks(searchInput.value.trim(), currentSort);
      } else {
        let msg = escapeHtml(data.error || 'Submission failed.');
        if (data.details && data.details.length > 0) {
          msg += '<ul>' + data.details.map(d => `<li>${escapeHtml(d)}</li>`).join('') + '</ul>';
        }
        showResult('error', msg);
      }
    } catch (err) {
      showResult('error', 'Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Pack';
      if (typeof turnstile !== 'undefined') {
        turnstile.reset();
      }
    }
  });

  // -- Functions --

  async function loadPacks(query, sort) {
    // First load: show skeleton
    if (isFirstLoad) {
      packsGrid.style.display = 'none';
      packsEmpty.style.display = 'none';
      packsLoading.style.display = 'grid';
    }

    try {
      const params = new URLSearchParams({ sort, limit: '24' });
      if (query) params.set('q', query);

      const response = await fetch(`/api/packs?${params}`);
      const data = await response.json();

      packsLoading.style.display = 'none';

      if (data.packs.length === 0) {
        if (!isFirstLoad) {
          await exitCards();
        }
        packsGrid.style.display = 'none';
        packsEmpty.style.display = 'block';
        isFirstLoad = false;
        return;
      }

      data.packs.forEach(p => packsCache.set(p.slug, p));

      const newHtml = data.packs.map(renderPackCard).join('');

      if (isFirstLoad) {
        packsGrid.innerHTML = newHtml;
        packsGrid.style.display = 'grid';
        enterCards();
      } else {
        await transitionCards(newHtml);
      }

      // Animate total registered count on first load
      if (!statsAnimated && data.totalRegistered) {
        animateCountUp(document.getElementById('stat-packs'), data.totalRegistered);
        statsAnimated = true;
      }

      isFirstLoad = false;
      checkDeepLink();
    } catch (err) {
      packsLoading.style.display = 'none';
      packsGrid.innerHTML = '<p style="color:var(--text-muted)">Failed to load packs.</p>';
      packsGrid.style.display = 'grid';
      isFirstLoad = false;
    }
  }

  function enterCards() {
    const cards = packsGrid.querySelectorAll('.pack-card');
    cards.forEach((card, i) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(12px) scale(0.97)';
      requestAnimationFrame(() => {
        card.style.transition = `opacity 0.3s ease ${i * 30}ms, transform 0.3s ease ${i * 30}ms`;
        card.style.opacity = '1';
        card.style.transform = 'translateY(0) scale(1)';
      });
    });
  }

  async function exitCards() {
    const cards = packsGrid.querySelectorAll('.pack-card');
    if (cards.length === 0) return;

    cards.forEach((card, i) => {
      card.style.transition = `opacity 0.2s ease ${i * 20}ms, transform 0.2s ease ${i * 20}ms`;
      card.style.opacity = '0';
      card.style.transform = 'translateY(-8px) scale(0.97)';
    });

    const lastDelay = (cards.length - 1) * 20;
    await wait(200 + lastDelay);
  }

  async function transitionCards(newHtml) {
    // Get current card identifiers for diffing
    const oldCards = packsGrid.querySelectorAll('.pack-card');
    const oldIds = new Set([...oldCards].map(c => c.dataset.id));

    // Parse new cards to get their IDs
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = newHtml;
    const newCards = tempDiv.querySelectorAll('.pack-card');
    const newIds = new Set([...newCards].map(c => c.dataset.id));

    // Find cards to exit (in old but not in new)
    const exitingCards = [...oldCards].filter(c => !newIds.has(c.dataset.id));
    // Find cards staying
    const stayingIds = new Set([...oldIds].filter(id => newIds.has(id)));

    // Phase 1: exit removed cards
    if (exitingCards.length > 0) {
      exitingCards.forEach((card, i) => {
        card.style.transition = `opacity 0.2s ease ${i * 20}ms, transform 0.2s ease ${i * 20}ms`;
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
      });
      const exitDelay = (exitingCards.length - 1) * 20;
      await wait(200 + exitDelay);
    }

    // Phase 2: swap content
    packsGrid.innerHTML = newHtml;
    packsGrid.style.display = 'grid';

    // Phase 3: enter new cards with stagger
    const updatedCards = packsGrid.querySelectorAll('.pack-card');
    let enterIndex = 0;
    updatedCards.forEach((card) => {
      if (stayingIds.has(card.dataset.id)) {
        // Staying cards: subtle fade to show updated position
        card.style.opacity = '0.7';
        card.style.transform = 'scale(1)';
        requestAnimationFrame(() => {
          card.style.transition = 'opacity 0.25s ease';
          card.style.opacity = '1';
        });
      } else {
        // New cards: staggered enter
        card.style.opacity = '0';
        card.style.transform = 'translateY(12px) scale(0.97)';
        const delay = enterIndex * 40;
        requestAnimationFrame(() => {
          card.style.transition = `opacity 0.3s ease ${delay}ms, transform 0.3s ease ${delay}ms`;
          card.style.opacity = '1';
          card.style.transform = 'translateY(0) scale(1)';
        });
        enterIndex++;
      }
    });
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function renderPackCard(pack) {
    const badges = renderBadges(pack.components);
    const dotColor = getDotColor(pack.components);
    const updated = timeAgo(pack.pushedAt);
    const banner = renderBanner(pack.status);
    const ownerRepo = pack.repoUrl.replace('https://github.com/', '');
    const installCmd = `mcs pack add ${ownerRepo}`;

    return `
      <div class="pack-card" data-id="${escapeHtml(pack.slug)}" data-repo="${escapeHtml(pack.repoUrl)}" role="button" tabindex="0">
        ${banner}
        <div class="pack-card-link">
          <div class="pack-card-header">
            <span class="pack-dot pack-dot--${dotColor}"></span>
            <span class="pack-card-name">${escapeHtml(pack.displayName)}</span>
            ${pack.stargazerCount ? `<span class="star-count">
              <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              ${pack.stargazerCount}
            </span>` : ''}
          </div>
          <p class="pack-card-desc">${escapeHtml(pack.description)}</p>
          ${pack.author ? `<div class="pack-card-author" style="color:var(--${dotColor})">by ${escapeHtml(pack.author)}</div>` : ''}
          <div class="pack-card-badges">${badges}</div>
        </div>
        <div class="pack-card-meta">
          <span class="pack-card-updated">Updated ${updated}</span>
          <button class="pack-card-copy" onclick="copyInstall(event, '${escapeHtml(installCmd)}')" aria-label="Copy install command">
            <span class="copy-tooltip">${escapeHtml(installCmd)}</span>
            <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>
            <span class="install-text">Copy</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderBadges(components) {
    const badges = [];
    const map = {
      mcpServers: { label: 'MCP Server', cls: 'mcp' },
      hooks: { label: 'Hook', cls: 'hooks' },
      skills: { label: 'Skill', cls: 'skills' },
      commands: { label: 'Command', cls: 'commands' },
      agents: { label: 'Agent', cls: 'agents' },
      brewPackages: { label: 'Brew', cls: 'brew' },
      plugins: { label: 'Plugin', cls: 'plugins' },
      templates: { label: 'Template', cls: 'templates' },
    };

    for (const [key, { label, cls }] of Object.entries(map)) {
      const count = components[key];
      if (count > 0) {
        const plural = count > 1 ? 's' : '';
        badges.push(`<span class="component-badge component-badge--${cls}">${count} ${label}${plural}</span>`);
      }
    }
    return badges.join('');
  }

  function getDotColor(components) {
    if (components.mcpServers > 0) return 'purple';
    if (components.hooks > 0 || components.skills > 0) return 'teal';
    if (components.commands > 0 || components.agents > 0) return 'blue';
    if (components.brewPackages > 0) return 'amber';
    return 'purple';
  }

  function renderBanner(status) {
    if (status === 'unavailable') {
      return '<div class="pack-card-banner pack-card-banner--unavailable">This pack\'s repository is currently unavailable</div>';
    }
    if (status === 'invalid') {
      return '<div class="pack-card-banner pack-card-banner--invalid">This pack\'s manifest has validation errors</div>';
    }
    return '';
  }

  function timeAgo(isoDate) {
    const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
  }

  function updateUrlQuery(query) {
    const url = new URL(window.location);
    if (query) {
      url.searchParams.set('q', query);
    } else {
      url.searchParams.delete('q');
    }
    history.replaceState(null, '', url);
  }

  function showResult(type, html) {
    submitResult.style.display = 'block';
    submitResult.className = `submit-result submit-result--${type}`;
    submitResult.innerHTML = html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // -- Pack detail modal --

  // Card click → open modal (delegated)
  packsGrid.addEventListener('click', (e) => {
    if (e.target.closest('.pack-card-copy')) return;
    const card = e.target.closest('.pack-card');
    if (!card) return;
    const pack = packsCache.get(card.dataset.id);
    if (pack) openPackModal(pack);
  });

  packsGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.pack-card-copy')) return;
    const card = e.target.closest('.pack-card');
    if (!card) return;
    e.preventDefault();
    const pack = packsCache.get(card.dataset.id);
    if (pack) openPackModal(pack);
  });

  // Backdrop click → close
  packModal.addEventListener('click', (e) => {
    if (e.target === packModal) closePackModal();
  });

  // Intercept Escape to use animated close
  packModal.addEventListener('cancel', (e) => {
    e.preventDefault();
    closePackModal();
  });

  // Clean URL on close
  packModal.addEventListener('close', () => {
    document.body.style.overflow = '';
    packModal.classList.remove('closing');
    const url = new URL(window.location);
    if (url.searchParams.has('pack')) {
      url.searchParams.delete('pack');
      history.replaceState(null, '', url);
    }
  });

  function closePackModal() {
    packModal.classList.add('closing');
    packModal.addEventListener('transitionend', () => {
      packModal.close();
    }, { once: true });
  }

  // Browser back button
  window.addEventListener('popstate', () => {
    const slug = new URLSearchParams(window.location.search).get('pack');
    if (!slug && packModal.open) {
      packModal.close();
    } else if (slug && !packModal.open) {
      const pack = packsCache.get(slug);
      if (pack) openPackModal(pack, true);
    }
  });

  function openPackModal(pack, skipPush) {
    packModalInner.innerHTML = renderModalContent(pack);
    packModal.showModal();
    document.body.style.overflow = 'hidden';

    // Wire close button and remove auto-focus outline
    const closeBtn = packModalInner.querySelector('.pack-modal-close');
    closeBtn.addEventListener('click', () => closePackModal());
    closeBtn.blur();

    // Wire install copy button
    const copyBtn = packModalInner.querySelector('.pack-modal-install-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const cmd = copyBtn.dataset.cmd;
        navigator.clipboard.writeText(cmd).then(() => {
          const textEl = copyBtn.querySelector('.install-text');
          textEl.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            textEl.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 1500);
        });
      });
    }

    if (!skipPush) {
      const url = new URL(window.location);
      url.searchParams.set('pack', pack.slug);
      history.pushState(null, '', url);
    }
  }

  function renderModalContent(pack) {
    const dotColor = getDotColor(pack.components);
    const badges = renderBadges(pack.components);
    const banner = renderBanner(pack.status);
    const ownerRepo = pack.repoUrl.replace('https://github.com/', '');
    const installCmd = `mcs pack add ${ownerRepo}`;
    const updated = timeAgo(pack.pushedAt);

    const metaRight = [];
    if (pack.stargazerCount) {
      metaRight.push(`<span class="pack-modal-meta-item star-count"><svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:var(--amber)"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>${pack.stargazerCount}</span>`);
    }
    metaRight.push(`<span class="pack-modal-meta-item">Updated ${updated}</span>`);
    if (pack.latestTag) metaRight.push(`<span class="pack-modal-meta-item">${escapeHtml(pack.latestTag)}</span>`);
    const metaRightHtml = metaRight.join('<span class="pack-modal-meta-sep">&middot;</span>');

    const keywordsHtml = pack.keywords && pack.keywords.length > 0
      ? `<div class="pack-modal-section">
          <div class="pack-modal-section-title">Keywords</div>
          <div class="pack-modal-keywords">${pack.keywords.map(k => `<span class="pack-modal-keyword">${escapeHtml(k)}</span>`).join('')}</div>
        </div>`
      : '';

    return `
      <div class="pack-modal-header">
        <span class="pack-dot pack-dot--${dotColor}"></span>
        <span class="pack-modal-name">${escapeHtml(pack.displayName)}</span>
        <button class="pack-modal-close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      ${banner}
      <p class="pack-modal-desc">${escapeHtml(pack.description)}</p>
      <div class="pack-modal-meta">
        ${pack.author ? `<span class="pack-modal-meta-item" style="color:var(--${dotColor})">by ${escapeHtml(pack.author)}</span>` : ''}
        <span class="pack-modal-meta-right">${metaRightHtml}</span>
      </div>
      <div class="pack-modal-install">
        <div class="pack-modal-install-cmd"><span>$ </span>${escapeHtml(installCmd)}</div>
        <button class="pack-modal-install-copy" data-cmd="${escapeHtml(installCmd)}">
          <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>
          <span class="install-text">Copy</span>
        </button>
      </div>
      ${badges ? `<div class="pack-modal-section">
        <div class="pack-modal-section-title">Components</div>
        <div class="pack-card-badges">${badges}</div>
      </div>` : ''}
      ${keywordsHtml}
      <div class="pack-modal-actions">
        <a href="${escapeHtml(pack.repoUrl)}" target="_blank" rel="noopener" class="pack-modal-gh">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          View on GitHub
        </a>
      </div>
    `;
  }

  function checkDeepLink() {
    const slug = new URLSearchParams(window.location.search).get('pack');
    if (!slug) return;

    const pack = packsCache.get(slug);
    if (pack) {
      openPackModal(pack, true);
      return;
    }

    // Fallback: fetch single pack if not in listing results
    fetch(`/api/packs/${slug}`)
      .then(r => r.ok ? r.json() : null)
      .then(p => {
        if (p && p.slug) {
          packsCache.set(p.slug, p);
          openPackModal(p, true);
        }
      });
  }
});
