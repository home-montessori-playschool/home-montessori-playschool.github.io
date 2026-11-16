(() => {
  const DEFAULT_CONFIG = {
    configVersion: 5,
    businessName: 'Home Montessori Play-School',
    ownerEmail: 'homemontessorischool.missleah@gmail.com',
    emailConfigured: true,
    phone: '415-290-4736',
    address: '533 Rollins Rd, Burlingame, CA 94010',
    openingsNow: true,
    openingsBanner: 'Openings Now — Enrolling Infants, Toddlers & Preschoolers (Ages 4 Mos – 4 Yrs)',
    tuitionFullTime: 2650,
    tuitionPartTime: 2000,
  };

  const STORAGE_KEYS = {
    config: 'hmp_site_config',
    parents: 'hmp_parents_store',
    inquiries: 'hmp_inquiries_store',
    enrollments: 'hmp_enrollments_store',
    sessionEmail: 'hmp_session_email',
  };

  const state = {
    config: { ...DEFAULT_CONFIG },
    token: localStorage.getItem('hmp_token') || '',
    parent: null,
    ownerPin: '',
    staticMode: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCurrency(num) {
    return '$' + Number(num || 0).toLocaleString('en-US');
  }

  function buildMailtoHref(to, subject, bodyLines) {
    const sub = encodeURIComponent(subject);
    const body = encodeURIComponent(bodyLines.filter(Boolean).join('\n'));
    return `mailto:${encodeURIComponent(to)}?subject=${sub}&body=${body}`;
  }

  function readLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeLocal(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      // Ignore storage quota errors
    }
  }

  // Dual-mode API client: uses Node server when available, seamlessly falls back to serverless static mode (GitHub Pages / mobile static hosting)
  async function apiCall(path, options = {}) {
    if (!state.staticMode) {
      try {
        const res = await fetch(`.${path}`, options);
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const json = await res.json();
          return json;
        }
        state.staticMode = true;
      } catch {
        state.staticMode = true;
      }
    }
    return handleStaticApi(path, options);
  }

  function handleStaticApi(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = options.headers || {};
    const storedCfg = readLocal(STORAGE_KEYS.config, {});
    const cfg = storedCfg.configVersion === DEFAULT_CONFIG.configVersion
      ? { ...DEFAULT_CONFIG, ...storedCfg }
      : { ...DEFAULT_CONFIG };

    if (method === 'GET' && path === '/api/config') {
      return { ok: true, config: cfg };
    }

    if (method === 'POST' && path === '/api/auth/register') {
      const parentName = String(body.parentName || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (!parentName || !email.includes('@') || password.length < 6) {
        return { ok: false, error: 'Please enter your full name, a valid email, and a password of at least 6 characters.' };
      }
      const parents = readLocal(STORAGE_KEYS.parents, []);
      if (parents.some(p => p.email === email)) {
        return { ok: false, error: 'An account with this email already exists on this device. Please sign in.' };
      }
      const newParent = {
        id: `FAM-${Date.now().toString(36).toUpperCase()}`,
        parentName,
        email,
        phone,
        neighborhood: String(body.neighborhood || '').trim(),
        childSummary: String(body.childSummary || '').trim(),
        passwordB64: btoa(unescape(encodeURIComponent(password))),
        createdAt: new Date().toISOString(),
      };
      parents.unshift(newParent);
      writeLocal(STORAGE_KEYS.parents, parents);
      localStorage.setItem(STORAGE_KEYS.sessionEmail, email);
      const { passwordB64, ...safeParent } = newParent;
      return {
        ok: true,
        token: `static-${Date.now()}`,
        parent: safeParent,
        ownerEmail: cfg.ownerEmail,
        emailConfigured: Boolean(cfg.emailConfigured),
        smtpSent: false,
      };
    }

    if (method === 'POST' && path === '/api/auth/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const parents = readLocal(STORAGE_KEYS.parents, []);
      const found = parents.find(p => p.email === email);
      const expected = btoa(unescape(encodeURIComponent(password)));
      if (!found || found.passwordB64 !== expected) {
        return { ok: false, error: 'Invalid email or password.' };
      }
      localStorage.setItem(STORAGE_KEYS.sessionEmail, email);
      const inquiries = readLocal(STORAGE_KEYS.inquiries, []).filter(i => i.email.toLowerCase() === email);
      const enrollments = readLocal(STORAGE_KEYS.enrollments, []).filter(e => e.parentEmail.toLowerCase() === email);
      const { passwordB64, ...safeParent } = found;
      return { ok: true, token: `static-${Date.now()}`, parent: safeParent, inquiries, enrollments };
    }

    if (method === 'GET' && path === '/api/parent/me') {
      const email = localStorage.getItem(STORAGE_KEYS.sessionEmail) || '';
      const parents = readLocal(STORAGE_KEYS.parents, []);
      const found = parents.find(p => p.email === email);
      if (!found) return { ok: false, error: 'Not signed in.' };
      const inquiries = readLocal(STORAGE_KEYS.inquiries, []).filter(i => i.email.toLowerCase() === email);
      const enrollments = readLocal(STORAGE_KEYS.enrollments, []).filter(e => e.parentEmail.toLowerCase() === email);
      const { passwordB64, ...safeParent } = found;
      return { ok: true, parent: safeParent, inquiries, enrollments };
    }

    if (method === 'POST' && path === '/api/inquiries') {
      const inquiry = {
        id: `INQ-${Math.floor(1000 + Math.random() * 9000)}`,
        parentName: String(body.parentName || '').trim(),
        email: String(body.email || '').trim(),
        phone: String(body.phone || '').trim(),
        inquiryType: String(body.inquiryType || 'Schedule a Tour').trim(),
        childAge: String(body.childAge || '').trim(),
        preferredTourDate: String(body.preferredTourDate || '').trim(),
        preferredTourTime: String(body.preferredTourTime || '').trim(),
        message: String(body.message || '').trim(),
        status: 'New',
        createdAt: new Date().toISOString(),
      };
      const list = readLocal(STORAGE_KEYS.inquiries, []);
      list.unshift(inquiry);
      writeLocal(STORAGE_KEYS.inquiries, list);
      return {
        ok: true,
        inquiry,
        ownerEmail: cfg.ownerEmail,
        emailConfigured: Boolean(cfg.emailConfigured),
        smtpSent: false,
      };
    }

    if (method === 'POST' && path === '/api/enrollments') {
      const enrollment = {
        id: `HMP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
        ...body,
        status: 'Submitted',
        createdAt: new Date().toISOString(),
      };
      const list = readLocal(STORAGE_KEYS.enrollments, []);
      list.unshift(enrollment);
      writeLocal(STORAGE_KEYS.enrollments, list);
      return {
        ok: true,
        enrollment,
        ownerEmail: cfg.ownerEmail,
        emailConfigured: Boolean(cfg.emailConfigured),
        smtpSent: false,
      };
    }

    if (path.startsWith('/api/admin/')) {
      const pin = String(headers['x-owner-pin'] || '').trim();
      if (pin !== '4784') {
        return { ok: false, error: 'Incorrect Owner PIN. (Default PIN is 4784.)' };
      }
      if (method === 'GET' && path === '/api/admin/overview') {
        return {
          ok: true,
          config: cfg,
          inquiries: readLocal(STORAGE_KEYS.inquiries, []),
          enrollments: readLocal(STORAGE_KEYS.enrollments, []),
          parents: readLocal(STORAGE_KEYS.parents, []),
        };
      }
      if (method === 'POST' && path === '/api/admin/config') {
        const updated = {
          ...cfg,
          ownerEmail: String(body.ownerEmail || cfg.ownerEmail).trim(),
          emailConfigured: Boolean(body.ownerEmail && String(body.ownerEmail).includes('@')),
          phone: String(body.phone ?? cfg.phone).trim(),
          openingsNow: body.openingsNow !== undefined ? Boolean(body.openingsNow) : cfg.openingsNow,
          tuitionFullTime: Number(body.tuitionFullTime || cfg.tuitionFullTime),
          tuitionPartTime: Number(body.tuitionPartTime || cfg.tuitionPartTime),
        };
        writeLocal(STORAGE_KEYS.config, updated);
        return { ok: true, config: updated };
      }
      if (method === 'PATCH' && path === '/api/admin/status') {
        const storeKey = body.collection === 'enrollments' ? STORAGE_KEYS.enrollments : STORAGE_KEYS.inquiries;
        const items = readLocal(storeKey, []);
        const item = items.find(x => x.id === body.id);
        if (item) {
          item.status = body.status;
          writeLocal(storeKey, items);
        }
        return { ok: true, item };
      }
    }

    return { ok: false, error: 'Unsupported action.' };
  }

  // Zero-API-key email relay via FormSubmit when owner email is configured and SMTP wasn't used
  async function relayViaFormSubmitIfNeeded(ownerEmail, emailConfigured, smtpSent, payload) {
    const activeEmail = ownerEmail || state.config.ownerEmail;
    if (smtpSent || !activeEmail || activeEmail === 'hello@homemontessoriburlingame.com') {
      return false;
    }
    try {
      const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(activeEmail)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          _template: 'table',
          _captcha: 'false',
          ...payload,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function renderConfig() {
    const c = state.config;
    const bannerEl = $('#openingsBannerText');
    if (bannerEl) {
      bannerEl.textContent = c.openingsNow
        ? (c.openingsBanner || 'Openings Now — Enrolling Infants, Toddlers & Preschoolers')
        : 'Currently Full — Accepting Waitlist Registrations & Tours';
    }

    const fullEl = $('#tuitionFullDisplay');
    const partEl = $('#tuitionPartDisplay');
    if (fullEl) fullEl.textContent = formatCurrency(c.tuitionFullTime);
    if (partEl) partEl.textContent = formatCurrency(c.tuitionPartTime);

    const enrSelect = $('#enrProgram');
    if (enrSelect && enrSelect.options.length >= 2) {
      const ftFmt = formatCurrency(c.tuitionFullTime);
      const ptFmt = formatCurrency(c.tuitionPartTime);
      enrSelect.options[0].value = `Full-Time Montessori (${ftFmt}/mo)`;
      enrSelect.options[0].textContent = `Full-Time Montessori — ${ftFmt} / month (Mon–Fri, 8:30–4:30)`;
      enrSelect.options[1].value = `Part-Time Montessori (${ptFmt}/mo)`;
      enrSelect.options[1].textContent = `Part-Time Montessori — ${ptFmt} / month (Selected Days)`;
    }

    const emailLink = $('#directEmailLink');
    if (emailLink && c.ownerEmail) {
      emailLink.textContent = c.ownerEmail;
      emailLink.href = `mailto:${c.ownerEmail}`;
    }

    const phoneRow = $('#sidebarPhoneRow');
    const phoneText = $('#sidebarPhoneText');
    if (phoneRow && phoneText) {
      if (c.phone) {
        phoneRow.classList.remove('hidden');
        phoneText.innerHTML = `<a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a>`;
      } else {
        phoneRow.classList.add('hidden');
      }
    }
  }

  async function loadConfig() {
    const data = await apiCall('/api/config');
    if (data && data.ok && data.config) {
      state.config = { ...state.config, ...data.config };
    }
    renderConfig();
  }

  // Tab Switching inside #connect
  function switchConnectTab(tabName, scroll = false) {
    $$('.tab-btn').forEach(btn => {
      const isMatch = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', String(isMatch));
    });
    $$('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });
    if (scroll) {
      const section = $('#connect');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchConnectTab(btn.dataset.tab, false));
  });

  $$('[data-switch-tab]').forEach(el => {
    el.addEventListener('click', e => {
      const targetTab = el.dataset.switchTab;
      if (targetTab) {
        e.preventDefault();
        switchConnectTab(targetTab, true);
      }
    });
  });

  $$('[data-enroll-program]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prog = btn.dataset.enrollProgram;
      const select = $('#enrProgram');
      if (select && prog) {
        for (const opt of select.options) {
          if (opt.value.startsWith(prog.split(' ')[0])) {
            select.value = opt.value;
            break;
          }
        }
      }
      switchConnectTab('enroll', true);
    });
  });

  $$('[data-inquire-program]').forEach(btn => {
    btn.addEventListener('click', () => {
      const topic = btn.dataset.inquireProgram;
      const select = $('#inqType');
      if (select && topic) {
        select.value = topic;
        select.dispatchEvent(new Event('change'));
      }
      switchConnectTab('inquiry', true);
    });
  });

  // Navbar mobile toggle & account shortcut
  const navToggle = $('#navToggle');
  const navLinks = $('#navLinks');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const open = navLinks.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    $$('a', navLinks).forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));
  }

  const navAccountBtn = $('#navAccountBtn');
  if (navAccountBtn) {
    navAccountBtn.addEventListener('click', () => switchConnectTab('portal', true));
  }

  // Toggle Tour Date fields based on Inquiry Topic
  const inqType = $('#inqType');
  const tourFields = $('#tourScheduleFields');
  if (inqType && tourFields) {
    inqType.addEventListener('change', () => {
      const isTour = inqType.value.toLowerCase().includes('tour');
      tourFields.classList.toggle('hidden', !isTour);
    });
  }

  function prefillFormsFromMember() {
    if (!state.parent) return;
    const p = state.parent;
    const map = [
      ['#inqName', p.parentName],
      ['#inqEmail', p.email],
      ['#inqPhone', p.phone],
      ['#enrParentName', p.parentName],
      ['#enrParentEmail', p.email],
      ['#enrParentPhone', p.phone],
      ['#enrAddress', p.neighborhood],
    ];
    for (const [selector, val] of map) {
      const input = $(selector);
      if (input && !input.value && val) input.value = val;
    }
  }

  // Inquiry Form Submission
  const inquiryForm = $('#inquiryForm');
  const inquirySuccess = $('#inquirySuccess');
  if (inquiryForm) {
    inquiryForm.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#inqSubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Sending Inquiry...';

      const payload = {
        inquiryType: $('#inqType').value,
        childAge: $('#inqChildAge').value.trim(),
        preferredTourDate: $('#inqTourDate').value,
        preferredTourTime: $('#inqTourTime').value,
        parentName: $('#inqName').value.trim(),
        email: $('#inqEmail').value.trim(),
        phone: $('#inqPhone').value.trim(),
        message: $('#inqMessage').value.trim(),
      };

      try {
        const data = await apiCall('/api/inquiries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!data.ok) throw new Error(data.error || 'Could not submit inquiry.');

        await relayViaFormSubmitIfNeeded(data.ownerEmail, data.emailConfigured, data.smtpSent, {
          _subject: `[Website Inquiry: ${payload.inquiryType}] from ${payload.parentName}`,
          _replyto: payload.email,
          email: payload.email,
          Reference_ID: data.inquiry.id,
          Topic: payload.inquiryType,
          Parent_Name: payload.parentName,
          Parent_Email: payload.email,
          Phone: payload.phone || 'Not provided',
          Child_Age: payload.childAge,
          Preferred_Tour: payload.preferredTourDate ? `${payload.preferredTourDate} (${payload.preferredTourTime})` : 'N/A',
          Message: payload.message,
        });

        const mailtoUrl = buildMailtoHref(
          data.ownerEmail || state.config.ownerEmail,
          `[${payload.inquiryType}] ${payload.parentName} — Home Montessori Play-School`,
          [
            `Hello Miss Leah,`,
            ``,
            `Inquiry Reference: ${data.inquiry.id}`,
            `Topic: ${payload.inquiryType}`,
            `Child's Age: ${payload.childAge}`,
            payload.preferredTourDate ? `Preferred Tour Date: ${payload.preferredTourDate} (${payload.preferredTourTime})` : '',
            `Phone: ${payload.phone || 'Not provided'}`,
            ``,
            payload.message,
            ``,
            `Warmly,`,
            payload.parentName,
          ]
        );

        inquiryForm.classList.add('hidden');
        inquirySuccess.classList.remove('hidden');
        inquirySuccess.innerHTML = `
          <h4>✓ Inquiry Sent to Miss Leah! (Ref: ${escapeHtml(data.inquiry.id)})</h4>
          <p>Thank you, <strong>${escapeHtml(payload.parentName)}</strong>! Your request regarding <strong>${escapeHtml(payload.inquiryType)}</strong> has been recorded and routed to <strong>${escapeHtml(data.ownerEmail)}</strong>.</p>
          <div class="submission-result__actions">
            <a href="${mailtoUrl}" class="btn btn--secondary btn--sm">✉️ Open Direct Copy in Email App</a>
            <button type="button" class="btn btn--ghost btn--sm" id="resetInquiryBtn">Send Another Message</button>
          </div>
        `;

        $('#resetInquiryBtn').addEventListener('click', () => {
          inquiryForm.reset();
          prefillFormsFromMember();
          inquirySuccess.classList.add('hidden');
          inquiryForm.classList.remove('hidden');
        });

        if (state.token) refreshMemberPortal();
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Inquiry to Miss Leah';
      }
    });
  }

  // 4-Step Enrollment Wizard Logic
  let currentWizardStep = 1;
  const enrollmentForm = $('#enrollmentForm');
  const enrollmentSuccess = $('#enrollmentSuccess');

  function setWizardStep(step) {
    currentWizardStep = step;
    $$('.wizard-pane').forEach(pane => {
      pane.classList.toggle('active', Number(pane.dataset.wizardPane) === step);
    });
    $$('.wizard-step').forEach(ind => {
      const s = Number(ind.dataset.step);
      ind.classList.toggle('active', s === step);
      ind.classList.toggle('done', s < step);
    });
    if (step === 4) renderEnrollmentReviewSummary();
  }

  function validateWizardPane(step) {
    const pane = $(`.wizard-pane[data-wizard-pane="${step}"]`);
    if (!pane) return true;
    const requiredInputs = $$('input[required], select[required], textarea[required]', pane);
    for (const input of requiredInputs) {
      if (!input.reportValidity()) return false;
    }
    return true;
  }

  function collectEnrollmentPayload() {
    const days = $$('input[name="preferredDays"]:checked', enrollmentForm).map(cb => cb.value);
    return {
      childName: $('#enrChildName').value.trim(),
      childDob: $('#enrChildDob').value,
      program: $('#enrProgram').value,
      startDate: $('#enrStartDate').value,
      preferredDays: days,
      parentName: $('#enrParentName').value.trim(),
      parentEmail: $('#enrParentEmail').value.trim(),
      parentPhone: $('#enrParentPhone').value.trim(),
      homeAddress: $('#enrAddress').value.trim(),
      secondaryParentName: $('#enrSecondParent').value.trim(),
      secondaryParentPhone: $('#enrSecondPhone').value.trim(),
      emergencyContactName: $('#enrEmergName').value.trim(),
      emergencyContactRelation: $('#enrEmergRel').value.trim(),
      emergencyContactPhone: $('#enrEmergPhone').value.trim(),
      pottyStage: $('#enrPotty').value,
      homeLanguages: $('#enrLanguages').value.trim(),
      allergiesMedical: $('#enrAllergies').value.trim() || 'None reported',
      feedingNapNotes: $('#enrRoutines').value.trim(),
      parentGoals: $('#enrGoals').value.trim(),
      acknowledgedPolicies: $('#enrAck').checked,
    };
  }

  function renderEnrollmentReviewSummary() {
    const p = collectEnrollmentPayload();
    const box = $('#enrollmentReviewBox');
    if (!box) return;
    box.innerHTML = `
      <h4>Application Review Summary</h4>
      <div class="review-summary-grid">
        <div><strong>Child:</strong> ${escapeHtml(p.childName)} (DOB: ${escapeHtml(p.childDob)})</div>
        <div><strong>Program:</strong> ${escapeHtml(p.program)}</div>
        <div><strong>Desired Start:</strong> ${escapeHtml(p.startDate)}</div>
        <div><strong>Preferred Days:</strong> ${escapeHtml(p.preferredDays.join(', ') || 'Mon–Fri')}</div>
        <div><strong>Primary Parent:</strong> ${escapeHtml(p.parentName)} (${escapeHtml(p.parentPhone)})</div>
        <div><strong>Email:</strong> ${escapeHtml(p.parentEmail)}</div>
        <div><strong>Emergency Contact:</strong> ${escapeHtml(p.emergencyContactName)} (${escapeHtml(p.emergencyContactRelation)})</div>
        <div><strong>Allergies / Medical:</strong> ${escapeHtml(p.allergiesMedical)}</div>
      </div>
    `;
  }

  $$('[data-wizard-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = Number(btn.dataset.wizardNext);
      if (validateWizardPane(currentWizardStep)) {
        setWizardStep(next);
      }
    });
  });

  $$('[data-wizard-prev]').forEach(btn => {
    btn.addEventListener('click', () => {
      setWizardStep(Number(btn.dataset.wizardPrev));
    });
  });

  if (enrollmentForm) {
    enrollmentForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!validateWizardPane(4)) return;

      const submitBtn = $('#enrSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting Application...';

      const payload = collectEnrollmentPayload();

      try {
        const data = await apiCall('/api/enrollments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!data.ok) throw new Error(data.error || 'Could not submit enrollment.');

        await relayViaFormSubmitIfNeeded(data.ownerEmail, data.emailConfigured, data.smtpSent, {
          _subject: `[New Enrollment ${data.enrollment.id}] ${payload.childName} — ${payload.program}`,
          _replyto: payload.parentEmail,
          email: payload.parentEmail,
          Application_ID: data.enrollment.id,
          Child_Name: payload.childName,
          Date_Of_Birth: payload.childDob,
          Program: payload.program,
          Desired_Start_Date: payload.startDate,
          Preferred_Days: payload.preferredDays.join(', '),
          Parent_Name: payload.parentName,
          Parent_Email: payload.parentEmail,
          Parent_Phone: payload.parentPhone,
          Home_Address: payload.homeAddress,
          Emergency_Contact: `${payload.emergencyContactName} (${payload.emergencyContactRelation}) - ${payload.emergencyContactPhone}`,
          Allergies_Medical: payload.allergiesMedical,
          Potty_Stage: payload.pottyStage,
          Home_Languages: payload.homeLanguages,
          Routines_And_Notes: payload.feedingNapNotes,
        });

        const mailtoUrl = buildMailtoHref(
          data.ownerEmail || state.config.ownerEmail,
          `[Enrollment Application ${data.enrollment.id}] ${payload.childName}`,
          [
            `Hello Miss Leah,`,
            ``,
            `We just submitted an online Child Enrollment Application (${data.enrollment.id})!`,
            ``,
            `Child: ${payload.childName} (DOB: ${payload.childDob})`,
            `Program: ${payload.program}`,
            `Desired Start Date: ${payload.startDate}`,
            `Days: ${payload.preferredDays.join(', ')}`,
            `Parent: ${payload.parentName} | ${payload.parentPhone} | ${payload.parentEmail}`,
            `Allergies/Medical: ${payload.allergiesMedical}`,
            `Potty Stage: ${payload.pottyStage}`,
            ``,
            `Looking forward to connecting!`,
            payload.parentName,
          ]
        );

        enrollmentForm.classList.add('hidden');
        $('#wizardSteps').classList.add('hidden');
        enrollmentSuccess.classList.remove('hidden');
        enrollmentSuccess.innerHTML = `
          <h4>🎉 Enrollment Application Submitted! (${escapeHtml(data.enrollment.id)})</h4>
          <p>We have registered <strong>${escapeHtml(payload.childName)}</strong>’s application for <strong>${escapeHtml(payload.program)}</strong> (desired start: ${escapeHtml(payload.startDate)}) and sent your packet to Miss Leah at <strong>${escapeHtml(data.ownerEmail)}</strong>.</p>
          <div class="submission-result__actions">
            <button type="button" class="btn btn--primary btn--sm" id="printEnrollmentBtn">🖨️ Print Application Receipt</button>
            <a href="${mailtoUrl}" class="btn btn--secondary btn--sm">✉️ Email Direct Copy</a>
            <button type="button" class="btn btn--ghost btn--sm" id="newEnrollmentBtn">Enroll Another Child</button>
          </div>
        `;

        $('#printEnrollmentBtn').addEventListener('click', () => window.print());
        $('#newEnrollmentBtn').addEventListener('click', () => {
          enrollmentForm.reset();
          prefillFormsFromMember();
          setWizardStep(1);
          enrollmentSuccess.classList.add('hidden');
          $('#wizardSteps').classList.remove('hidden');
          enrollmentForm.classList.remove('hidden');
        });

        if (state.token) refreshMemberPortal();
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Enrollment Application';
      }
    });
  }

  // Family Registration & Login Portal
  $$('.auth-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.authMode;
      $$('.auth-toggle').forEach(b => b.classList.toggle('active', b === btn));
      $('#registerForm').classList.toggle('hidden', mode !== 'register');
      $('#loginForm').classList.toggle('hidden', mode !== 'login');
    });
  });

  function renderMemberPortal(data) {
    state.parent = data.parent;
    $('#portalGuestView').classList.add('hidden');
    $('#portalMemberView').classList.remove('hidden');
    if (navAccountBtn) {
      navAccountBtn.textContent = `Family: ${data.parent.parentName.split(' ')[0]}`;
    }

    $('#memberGreeting').textContent = `Welcome, ${data.parent.parentName}!`;
    $('#memberMeta').textContent = `${data.parent.email} · Family ID: ${data.parent.id}${data.parent.childSummary ? ` · ${data.parent.childSummary}` : ''}`;

    const enrBox = $('#memberEnrollmentsList');
    const enrollments = data.enrollments || [];
    enrBox.innerHTML = enrollments.length
      ? enrollments.map(e => `
        <div class="record-item">
          <div class="record-item__top">
            <strong>${escapeHtml(e.childName)} (${escapeHtml(e.id)})</strong>
            <span class="status-pill">${escapeHtml(e.status)}</span>
          </div>
          <div>${escapeHtml(e.program)} · Start: ${escapeHtml(e.startDate)}</div>
        </div>
      `).join('')
      : `<p class="small-muted">No child enrollment applications submitted yet. Click <strong>+ Enroll a Child</strong> above whenever you’re ready!</p>`;

    const inqBox = $('#memberInquiriesList');
    const inquiries = data.inquiries || [];
    inqBox.innerHTML = inquiries.length
      ? inquiries.map(i => `
        <div class="record-item">
          <div class="record-item__top">
            <strong>${escapeHtml(i.inquiryType)} (${escapeHtml(i.id)})</strong>
            <span class="status-pill">${escapeHtml(i.status)}</span>
          </div>
          <div>${escapeHtml(i.message)}</div>
        </div>
      `).join('')
      : `<p class="small-muted">No inquiries sent under this email yet.</p>`;

    prefillFormsFromMember();
  }

  async function refreshMemberPortal() {
    if (!state.token) return;
    const data = await apiCall('/api/parent/me', {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (data && data.ok) {
      renderMemberPortal(data);
    } else {
      localStorage.removeItem('hmp_token');
      state.token = '';
    }
  }

  const registerForm = $('#registerForm');
  if (registerForm) {
    registerForm.addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = $('#regError');
      errEl.classList.add('hidden');

      const payload = {
        parentName: $('#regName').value.trim(),
        email: $('#regEmail').value.trim(),
        phone: $('#regPhone').value.trim(),
        neighborhood: $('#regNeighborhood').value.trim(),
        childSummary: $('#regChild').value.trim(),
        password: $('#regPassword').value,
      };

      try {
        const data = await apiCall('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!data.ok) throw new Error(data.error || 'Registration failed.');

        state.token = data.token;
        localStorage.setItem('hmp_token', data.token);

        await relayViaFormSubmitIfNeeded(data.ownerEmail, data.emailConfigured, data.smtpSent, {
          _subject: `[New Family Registered] ${payload.parentName}`,
          Family_ID: data.parent.id,
          Parent_Name: payload.parentName,
          Email: payload.email,
          Phone: payload.phone,
          Neighborhood: payload.neighborhood || 'N/A',
          Child_Details: payload.childSummary || 'N/A',
        });

        await refreshMemberPortal();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  const loginForm = $('#loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = $('#loginError');
      errEl.classList.add('hidden');

      try {
        const data = await apiCall('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: $('#loginEmail').value.trim(),
            password: $('#loginPassword').value,
          }),
        });
        if (!data.ok) throw new Error(data.error || 'Login failed.');

        state.token = data.token;
        localStorage.setItem('hmp_token', data.token);
        renderMemberPortal(data);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('hmp_token');
      localStorage.removeItem(STORAGE_KEYS.sessionEmail);
      state.token = '';
      state.parent = null;
      if (navAccountBtn) navAccountBtn.textContent = 'Family Register / Sign In';
      $('#portalMemberView').classList.add('hidden');
      $('#portalGuestView').classList.remove('hidden');
    });
  }

  // Owner Admin Modal & Settings
  const ownerModal = $('#ownerModal');
  $('#openOwnerModalBtn')?.addEventListener('click', () => {
    ownerModal.classList.remove('hidden');
  });
  $('#closeOwnerModalBtn')?.addEventListener('click', () => {
    ownerModal.classList.add('hidden');
  });
  ownerModal?.addEventListener('click', e => {
    if (e.target === ownerModal) ownerModal.classList.add('hidden');
  });

  async function loadAdminOverview() {
    const data = await apiCall('/api/admin/overview', {
      headers: { 'x-owner-pin': state.ownerPin },
    });
    if (!data.ok) throw new Error(data.error || 'Unauthorized');

    state.config = data.config;
    renderConfig();

    $('#cfgEmail').value = data.config.ownerEmail || '';
    $('#cfgPhone').value = data.config.phone || '';
    $('#cfgFullTuition').value = data.config.tuitionFullTime || 2650;
    $('#cfgPartTuition').value = data.config.tuitionPartTime || 2000;
    $('#cfgOpenings').value = String(Boolean(data.config.openingsNow));

    $('#adminStats').innerHTML = `
      <div class="stat-box"><strong>${data.enrollments.length}</strong><span>Enrollment Applications</span></div>
      <div class="stat-box"><strong>${data.inquiries.length}</strong><span>Parent Inquiries</span></div>
      <div class="stat-box"><strong>${data.parents.length}</strong><span>Registered Families</span></div>
    `;

    $('#adminEnrollmentsList').innerHTML = data.enrollments.length
      ? data.enrollments.map(e => `
        <div class="record-item">
          <div class="record-item__top">
            <strong>${escapeHtml(e.childName)} (DOB: ${escapeHtml(e.childDob)}) · ${escapeHtml(e.id)}</strong>
            <select data-status-update="enrollments" data-id="${escapeHtml(e.id)}">
              ${['Submitted', 'Under Review', 'Accepted', 'Waitlisted'].map(s => `<option value="${s}" ${e.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div><strong>${escapeHtml(e.program)}</strong> · Start: ${escapeHtml(e.startDate)} · Days: ${escapeHtml((e.preferredDays || []).join(', '))}</div>
          <div>Parent: ${escapeHtml(e.parentName)} · <a href="mailto:${escapeHtml(e.parentEmail)}">${escapeHtml(e.parentEmail)}</a> · ${escapeHtml(e.parentPhone)}</div>
          <div>Allergies: ${escapeHtml(e.allergiesMedical)} · Potty: ${escapeHtml(e.pottyStage)}</div>
        </div>
      `).join('')
      : `<p class="small-muted">No child enrollment applications yet.</p>`;

    $('#adminInquiriesList').innerHTML = data.inquiries.length
      ? data.inquiries.map(i => `
        <div class="record-item">
          <div class="record-item__top">
            <strong>${escapeHtml(i.inquiryType)} — ${escapeHtml(i.parentName)} (${escapeHtml(i.id)})</strong>
            <select data-status-update="inquiries" data-id="${escapeHtml(i.id)}">
              ${['New', 'Tour Scheduled', 'Replied'].map(s => `<option value="${s}" ${i.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>Child Age: ${escapeHtml(i.childAge)} ${i.preferredTourDate ? `· Tour: ${escapeHtml(i.preferredTourDate)} (${escapeHtml(i.preferredTourTime)})` : ''}</div>
          <div>Contact: <a href="mailto:${escapeHtml(i.email)}">${escapeHtml(i.email)}</a> · ${escapeHtml(i.phone || 'No phone')}</div>
          <div style="margin-top:4px;color:#0F2942;">“${escapeHtml(i.message)}”</div>
        </div>
      `).join('')
      : `<p class="small-muted">No inquiries received yet.</p>`;

    $('#adminParentsList').innerHTML = data.parents.length
      ? data.parents.map(p => `
        <div class="record-item">
          <strong>${escapeHtml(p.parentName)}</strong> (${escapeHtml(p.id)}) · <a href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a> · ${escapeHtml(p.phone || 'No phone')}
          ${p.childSummary ? `<div>Child: ${escapeHtml(p.childSummary)} · ${escapeHtml(p.neighborhood || '')}</div>` : ''}
        </div>
      `).join('')
      : `<p class="small-muted">No registered family accounts yet.</p>`;

    $$('[data-status-update]', ownerModal).forEach(sel => {
      sel.addEventListener('change', async () => {
        await apiCall('/api/admin/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-owner-pin': state.ownerPin,
          },
          body: JSON.stringify({
            collection: sel.dataset.statusUpdate,
            id: sel.dataset.id,
            status: sel.value,
          }),
        });
      });
    });
  }

  $('#ownerPinForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#ownerPinError');
    errEl.classList.add('hidden');
    state.ownerPin = $('#ownerPinInput').value.trim();

    try {
      await loadAdminOverview();
      $('#ownerPinForm').classList.add('hidden');
      $('#ownerAdminContent').classList.remove('hidden');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  $('#ownerSettingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = await apiCall('/api/admin/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': state.ownerPin,
      },
      body: JSON.stringify({
        ownerEmail: $('#cfgEmail').value.trim(),
        phone: $('#cfgPhone').value.trim(),
        tuitionFullTime: Number($('#cfgFullTuition').value),
        tuitionPartTime: Number($('#cfgPartTuition').value),
        openingsNow: $('#cfgOpenings').value === 'true',
      }),
    });
    if (data.ok) {
      state.config = data.config;
      renderConfig();
      const badge = $('#cfgSaveMsg');
      badge.classList.remove('hidden');
      setTimeout(() => badge.classList.add('hidden'), 3000);
    }
  });

  // Floating Video Bubble & Narrated Video Tour Modal
  const videoBubbleWrap = $('#videoBubbleWrap');
  const videoRestorePill = $('#videoRestorePill');
  const videoTourModal = $('#videoTourModal');
  const fullTourVideo = $('#fullTourVideo');
  let bubbleWasDragged = false;

  function openVideoTour() {
    if (bubbleWasDragged) return;
    if (!videoTourModal) return;
    videoTourModal.classList.remove('hidden');
    if (fullTourVideo) {
      fullTourVideo.muted = false;
      fullTourVideo.volume = 1;
      fullTourVideo.currentTime = 0;
      fullTourVideo.play().catch(() => {});
    }
  }

  function closeVideoTour() {
    if (!videoTourModal) return;
    videoTourModal.classList.add('hidden');
    if (fullTourVideo) {
      fullTourVideo.pause();
    }
  }

  $('#openVideoBubbleBtn')?.addEventListener('click', openVideoTour);
  $('#openVideoLabelBtn')?.addEventListener('click', openVideoTour);
  $('#heroWatchVideoBtn')?.addEventListener('click', openVideoTour);
  $('#closeVideoModalBtn')?.addEventListener('click', closeVideoTour);

  videoTourModal?.addEventListener('click', e => {
    if (e.target === videoTourModal) closeVideoTour();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && videoTourModal && !videoTourModal.classList.contains('hidden')) {
      closeVideoTour();
    }
  });

  $('#dismissBubbleBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    videoBubbleWrap?.classList.add('hidden');
    videoRestorePill?.classList.remove('hidden');
  });

  videoRestorePill?.addEventListener('click', () => {
    videoRestorePill.classList.add('hidden');
    videoBubbleWrap?.classList.remove('hidden');
    openVideoTour();
  });

  $('#videoBookTourBtn')?.addEventListener('click', () => {
    closeVideoTour();
    const select = $('#inqType');
    if (select) {
      select.value = 'Schedule an In-Person Tour';
      select.dispatchEvent(new Event('change'));
    }
    switchConnectTab('inquiry', true);
  });

  $('#videoEnrollBtn')?.addEventListener('click', () => {
    closeVideoTour();
    switchConnectTab('enroll', true);
  });

  // Allow dragging the floating video bubble anywhere on screen
  if (videoBubbleWrap) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    videoBubbleWrap.addEventListener('pointerdown', e => {
      if (e.target.closest('#dismissBubbleBtn')) return;
      dragging = true;
      bubbleWasDragged = false;
      const rect = videoBubbleWrap.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
    });

    window.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 8) {
        bubbleWasDragged = true;
        videoBubbleWrap.classList.add('dragging');
        const maxLeft = window.innerWidth - videoBubbleWrap.offsetWidth - 8;
        const maxTop = window.innerHeight - videoBubbleWrap.offsetHeight - 8;
        const nextLeft = Math.max(8, Math.min(maxLeft, origLeft + dx));
        const nextTop = Math.max(8, Math.min(maxTop, origTop + dy));
        videoBubbleWrap.style.left = `${nextLeft}px`;
        videoBubbleWrap.style.top = `${nextTop}px`;
        videoBubbleWrap.style.right = 'auto';
        videoBubbleWrap.style.bottom = 'auto';
      }
    });

    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      setTimeout(() => {
        bubbleWasDragged = false;
      }, 60);
    });
  }

  // Set helpful default minimum date on date inputs (except DOB)
  const todayStr = new Date().toISOString().split('T')[0];
  if ($('#inqTourDate')) $('#inqTourDate').min = todayStr;
  if ($('#enrStartDate')) $('#enrStartDate').min = todayStr;
  if ($('#enrChildDob')) $('#enrChildDob').max = todayStr;

  // Boot
  loadConfig();
  refreshMemberPortal();
})();
