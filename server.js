const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load optional .env file if present
const envPath = path.join(__dirname, '.env');
if (fsSync.existsSync(envPath)) {
  const envContent = fsSync.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {
  // Optional dependency; FormSubmit & local persistence still work without it
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  parents: path.join(DATA_DIR, 'parents.json'),
  inquiries: path.join(DATA_DIR, 'inquiries.json'),
  enrollments: path.join(DATA_DIR, 'enrollments.json'),
};

// Active parent sessions in memory (token -> email)
const sessions = new Map();

// Ephemeral one-time Owner Portal OTP & short-lived single-visit admin sessions
let adminOtp = { hash: null, expiresAt: 0, attempts: 0 };
const adminSessions = new Map();

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [key, filePath] of Object.entries(FILES)) {
    if (!fsSync.existsSync(filePath)) {
      const initial = key === 'config' ? {
        configVersion: 5,
        businessName: 'Home Montessori Play-School',
        directorName: 'Miss Leah',
        ownerEmail: 'homemontessorischool.missleah@gmail.com',
        emailConfigured: true,
        phone: '415-290-4736',
        address: '533 Rollins Rd, Burlingame, CA 94010',
        neighborhood: 'Oak Grove Manor',
        cityStateZip: 'Burlingame, CA 94010',
        landmarks: '533 Rollins Rd, Burlingame, CA 94010',
        licenseNumber: '414004784',
        licensedCapacity: 8,
        typicalGroupSize: '4–6 children',
        hours: 'Monday – Friday · 8:30 AM – 4:30 PM',
        tourHours: 'Monday – Friday · 4:30 PM – 5:00 PM Only',
        agesServed: '4 Months – 4 Years',
        openingsNow: true,
        openingsBanner: 'Openings Now — Enrolling Infants, Toddlers & Preschoolers (Ages 4 Mos – 4 Yrs)',
        tuitionFullTime: 2650,
        tuitionPartTime: 2000,
      } : [];
      await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8');
    }
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored || '').split(':');
  if (!salt || !originalHash) return false;
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const origBuffer = Buffer.from(originalHash, 'hex');
  if (hashBuffer.length !== origBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, origBuffer);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendSmtpEmailIfConfigured({ to, replyTo, subject, html, text }) {
  if (!nodemailer || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { sentViaSmtp: false, reason: 'SMTP_NOT_CONFIGURED' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: `"Home Montessori Play-School Website" <${process.env.SMTP_USER}>`,
      to,
      replyTo,
      subject,
      text,
      html,
    });
    return { sentViaSmtp: true };
  } catch (err) {
    return { sentViaSmtp: false, reason: err.message };
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
};

async function handleApi(req, res, pathname) {
  const config = await readJson(FILES.config, {});

  // Public site configuration
  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, { ok: true, config });
  }

  // Register new parent / client account
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await parseBody(req);
    const parentName = String(body.parentName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    const childSummary = String(body.childSummary || '').trim();
    const neighborhood = String(body.neighborhood || '').trim();

    if (!parentName || !email || !email.includes('@') || password.length < 6) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Please provide your full name, a valid email address, and a password of at least 6 characters.',
      });
    }

    const parents = await readJson(FILES.parents, []);
    if (parents.some(p => p.email === email)) {
      return sendJson(res, 409, {
        ok: false,
        error: 'An account with this email already exists. Please sign in instead.',
      });
    }

    const newParent = {
      id: `FAM-${Date.now().toString(36).toUpperCase()}`,
      parentName,
      email,
      phone,
      neighborhood,
      childSummary,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    parents.unshift(newParent);
    await writeJson(FILES.parents, parents);

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, email);

    const smtpResult = await sendSmtpEmailIfConfigured({
      to: config.ownerEmail,
      replyTo: email,
      subject: `[New Family Registered] ${parentName} — Home Montessori Play-School`,
      text: `New Parent Registration\n\nParent: ${parentName}\nEmail: ${email}\nPhone: ${phone || 'N/A'}\nNeighborhood: ${neighborhood || 'N/A'}\nChild Info: ${childSummary || 'N/A'}\nRegistered: ${newParent.createdAt}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;padding:24px;background:#FAF6F0;border-radius:12px;color:#1F2E28;">
          <h2 style="margin-top:0;color:#4A6B53;">New Family Account Registered</h2>
          <p><strong>Parent Name:</strong> ${escapeHtml(parentName)}</p>
          <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
          <p><strong>Phone:</strong> ${escapeHtml(phone || 'Not provided')}</p>
          <p><strong>Neighborhood / City:</strong> ${escapeHtml(neighborhood || 'Not provided')}</p>
          <p><strong>Child Details:</strong> ${escapeHtml(childSummary || 'Not provided')}</p>
        </div>
      `,
    });

    const { passwordHash, ...safeParent } = newParent;
    return sendJson(res, 201, {
      ok: true,
      token,
      parent: safeParent,
      ownerEmail: config.ownerEmail,
      emailConfigured: Boolean(config.emailConfigured),
      smtpSent: smtpResult.sentViaSmtp,
    });
  }

  // Parent Login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const parents = await readJson(FILES.parents, []);
    const found = parents.find(p => p.email === email);
    if (!found || !verifyPassword(password, found.passwordHash)) {
      return sendJson(res, 401, { ok: false, error: 'Invalid email or password.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, email);

    const inquiries = (await readJson(FILES.inquiries, [])).filter(i => i.email.toLowerCase() === email);
    const enrollments = (await readJson(FILES.enrollments, [])).filter(e => e.parentEmail.toLowerCase() === email);
    const { passwordHash, ...safeParent } = found;

    return sendJson(res, 200, {
      ok: true,
      token,
      parent: safeParent,
      inquiries,
      enrollments,
    });
  }

  // Current Logged-In Parent Portal Data
  if (req.method === 'GET' && pathname === '/api/parent/me') {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const email = sessions.get(token);
    if (!email) {
      return sendJson(res, 401, { ok: false, error: 'Not signed in.' });
    }
    const parents = await readJson(FILES.parents, []);
    const found = parents.find(p => p.email === email);
    if (!found) {
      return sendJson(res, 401, { ok: false, error: 'Account not found.' });
    }
    const inquiries = (await readJson(FILES.inquiries, [])).filter(i => i.email.toLowerCase() === email);
    const enrollments = (await readJson(FILES.enrollments, [])).filter(e => e.parentEmail.toLowerCase() === email);
    const { passwordHash, ...safeParent } = found;
    return sendJson(res, 200, { ok: true, parent: safeParent, inquiries, enrollments });
  }

  // Submit Inquiry or Tour Request
  if (req.method === 'POST' && pathname === '/api/inquiries') {
    const body = await parseBody(req);
    const parentName = String(body.parentName || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const inquiryType = String(body.inquiryType || 'Schedule a Tour').trim();
    const childAge = String(body.childAge || '').trim();
    const preferredTourDate = String(body.preferredTourDate || '').trim();
    const preferredTourTime = String(body.preferredTourTime || '').trim();
    const message = String(body.message || '').trim();

    if (!parentName || !email || !email.includes('@') || !message) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Please enter your name, a valid email address, and your message.',
      });
    }

    const inquiry = {
      id: `INQ-${Math.floor(1000 + Math.random() * 9000)}`,
      parentName,
      email,
      phone,
      inquiryType,
      childAge,
      preferredTourDate,
      preferredTourTime,
      message,
      status: 'New',
      createdAt: new Date().toISOString(),
    };

    const inquiries = await readJson(FILES.inquiries, []);
    inquiries.unshift(inquiry);
    await writeJson(FILES.inquiries, inquiries);

    const smtpResult = await sendSmtpEmailIfConfigured({
      to: config.ownerEmail,
      replyTo: email,
      subject: `[Website Inquiry: ${inquiryType}] from ${parentName} (${inquiry.id})`,
      text: [
        `New Inquiry for Home Montessori Play-School (${inquiry.id})`,
        `Topic: ${inquiryType}`,
        `Parent Name: ${parentName}`,
        `Email: ${email}`,
        `Phone: ${phone || 'Not provided'}`,
        `Child's Age: ${childAge || 'Not specified'}`,
        preferredTourDate ? `Preferred Tour Date: ${preferredTourDate} (${preferredTourTime || 'Flexible'})` : '',
        `\nMessage:\n${message}`,
      ].filter(Boolean).join('\n'),
      html: `
        <div style="font-family:sans-serif;max-width:620px;padding:24px;background:#FAF6F0;border-radius:14px;color:#1F2E28;border:1px solid #E5DCCB;">
          <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#4A6B53;color:#fff;font-size:12px;font-weight:600;">${escapeHtml(inquiryType)}</span>
          <h2 style="margin:12px 0 8px;">New Parent Inquiry (${escapeHtml(inquiry.id)})</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:12px;">
            <tr><td style="padding:6px 0;color:#5A665E;"><strong>Parent Name:</strong></td><td>${escapeHtml(parentName)}</td></tr>
            <tr><td style="padding:6px 0;color:#5A665E;"><strong>Email:</strong></td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
            <tr><td style="padding:6px 0;color:#5A665E;"><strong>Phone:</strong></td><td>${escapeHtml(phone || 'Not provided')}</td></tr>
            <tr><td style="padding:6px 0;color:#5A665E;"><strong>Child's Age:</strong></td><td>${escapeHtml(childAge || 'Not specified')}</td></tr>
            ${preferredTourDate ? `<tr><td style="padding:6px 0;color:#5A665E;"><strong>Preferred Tour:</strong></td><td>${escapeHtml(preferredTourDate)} · ${escapeHtml(preferredTourTime || 'Flexible')}</td></tr>` : ''}
          </table>
          <div style="margin-top:16px;padding:14px;background:#fff;border-radius:10px;border:1px solid #E5DCCB;">
            <strong>Message from Parent:</strong>
            <p style="margin:8px 0 0;white-space:pre-wrap;">${escapeHtml(message)}</p>
          </div>
        </div>
      `,
    });

    return sendJson(res, 201, {
      ok: true,
      inquiry,
      ownerEmail: config.ownerEmail,
      emailConfigured: Boolean(config.emailConfigured),
      smtpSent: smtpResult.sentViaSmtp,
    });
  }

  // Submit Full Child Enrollment Application
  if (req.method === 'POST' && pathname === '/api/enrollments') {
    const body = await parseBody(req);
    const childName = String(body.childName || '').trim();
    const childDob = String(body.childDob || '').trim();
    const program = String(body.program || '').trim();
    const startDate = String(body.startDate || '').trim();
    const parentName = String(body.parentName || '').trim();
    const parentEmail = String(body.parentEmail || '').trim();
    const parentPhone = String(body.parentPhone || '').trim();

    if (!childName || !childDob || !program || !parentName || !parentEmail.includes('@') || !parentPhone) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Please complete all required child and parent contact fields before submitting enrollment.',
      });
    }

    const enrollment = {
      id: `HMP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
      childName,
      childDob,
      childGender: String(body.childGender || '').trim(),
      program,
      preferredDays: Array.isArray(body.preferredDays) ? body.preferredDays : [],
      startDate,
      parentName,
      parentEmail,
      parentPhone,
      homeAddress: String(body.homeAddress || '').trim(),
      secondaryParentName: String(body.secondaryParentName || '').trim(),
      secondaryParentPhone: String(body.secondaryParentPhone || '').trim(),
      emergencyContactName: String(body.emergencyContactName || '').trim(),
      emergencyContactRelation: String(body.emergencyContactRelation || '').trim(),
      emergencyContactPhone: String(body.emergencyContactPhone || '').trim(),
      allergiesMedical: String(body.allergiesMedical || 'None reported').trim(),
      feedingNapNotes: String(body.feedingNapNotes || '').trim(),
      pottyStage: String(body.pottyStage || '').trim(),
      homeLanguages: String(body.homeLanguages || '').trim(),
      parentGoals: String(body.parentGoals || '').trim(),
      acknowledgedPolicies: Boolean(body.acknowledgedPolicies),
      status: 'Submitted',
      createdAt: new Date().toISOString(),
    };

    const enrollments = await readJson(FILES.enrollments, []);
    enrollments.unshift(enrollment);
    await writeJson(FILES.enrollments, enrollments);

    const smtpResult = await sendSmtpEmailIfConfigured({
      to: config.ownerEmail,
      replyTo: parentEmail,
      subject: `[New Enrollment Application ${enrollment.id}] ${childName} — ${program}`,
      text: [
        `NEW CHILD ENROLLMENT APPLICATION (${enrollment.id})`,
        `====================================================`,
        `Child Name: ${enrollment.childName}`,
        `Date of Birth: ${enrollment.childDob}`,
        `Program Selected: ${enrollment.program}`,
        `Preferred Days: ${enrollment.preferredDays.join(', ') || 'Mon–Fri'}`,
        `Desired Start Date: ${enrollment.startDate || 'Flexible'}`,
        ``,
        `PRIMARY PARENT / GUARDIAN`,
        `Name: ${enrollment.parentName}`,
        `Email: ${enrollment.parentEmail}`,
        `Phone: ${enrollment.parentPhone}`,
        `Address: ${enrollment.homeAddress || 'Not provided'}`,
        `Secondary Parent: ${enrollment.secondaryParentName || 'N/A'} (${enrollment.secondaryParentPhone || 'N/A'})`,
        `Emergency Contact: ${enrollment.emergencyContactName || 'N/A'} (${enrollment.emergencyContactRelation || 'N/A'}) - ${enrollment.emergencyContactPhone || 'N/A'}`,
        ``,
        `CARE & DEVELOPMENTAL PROFILE`,
        `Allergies / Medical: ${enrollment.allergiesMedical}`,
        `Potty-Training Stage: ${enrollment.pottyStage || 'Not specified'}`,
        `Home Languages: ${enrollment.homeLanguages || 'Not specified'}`,
        `Feeding & Nap Routine: ${enrollment.feedingNapNotes || 'Not specified'}`,
        `Family Goals / Notes: ${enrollment.parentGoals || 'None'}`,
      ].join('\n'),
      html: `
        <div style="font-family:sans-serif;max-width:660px;padding:24px;background:#FAF6F0;border-radius:14px;color:#1F2E28;border:1px solid #E5DCCB;">
          <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#C86D51;color:#fff;font-size:12px;font-weight:700;">ENROLLMENT APPLICATION · ${escapeHtml(enrollment.id)}</span>
          <h2 style="margin:12px 0 4px;">${escapeHtml(enrollment.childName)}</h2>
          <p style="margin:0 0 16px;color:#4A6B53;font-weight:600;">${escapeHtml(enrollment.program)} · Desired Start: ${escapeHtml(enrollment.startDate || 'Flexible')}</p>
          <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #E5DCCB;margin-bottom:12px;">
            <h3 style="margin:0 0 8px;font-size:15px;">Child & Schedule</h3>
            <p style="margin:4px 0;"><strong>DOB:</strong> ${escapeHtml(enrollment.childDob)} ${enrollment.childGender ? `(${escapeHtml(enrollment.childGender)})` : ''}</p>
            <p style="margin:4px 0;"><strong>Days:</strong> ${escapeHtml(enrollment.preferredDays.join(', ') || 'Monday – Friday')}</p>
            <p style="margin:4px 0;"><strong>Potty Stage:</strong> ${escapeHtml(enrollment.pottyStage || 'Not specified')}</p>
            <p style="margin:4px 0;"><strong>Home Languages:</strong> ${escapeHtml(enrollment.homeLanguages || 'Not specified')}</p>
          </div>
          <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #E5DCCB;margin-bottom:12px;">
            <h3 style="margin:0 0 8px;font-size:15px;">Parent & Emergency Contacts</h3>
            <p style="margin:4px 0;"><strong>Primary Parent:</strong> ${escapeHtml(enrollment.parentName)} · <a href="mailto:${escapeHtml(enrollment.parentEmail)}">${escapeHtml(enrollment.parentEmail)}</a> · ${escapeHtml(enrollment.parentPhone)}</p>
            <p style="margin:4px 0;"><strong>Home Address:</strong> ${escapeHtml(enrollment.homeAddress || 'Not provided')}</p>
            ${enrollment.secondaryParentName ? `<p style="margin:4px 0;"><strong>Second Parent:</strong> ${escapeHtml(enrollment.secondaryParentName)} (${escapeHtml(enrollment.secondaryParentPhone)})</p>` : ''}
            <p style="margin:4px 0;"><strong>Emergency Contact:</strong> ${escapeHtml(enrollment.emergencyContactName || 'N/A')} (${escapeHtml(enrollment.emergencyContactRelation || 'N/A')}) · ${escapeHtml(enrollment.emergencyContactPhone || 'N/A')}</p>
          </div>
          <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #E5DCCB;">
            <h3 style="margin:0 0 8px;font-size:15px;">Health, Routines & Family Notes</h3>
            <p style="margin:4px 0;"><strong>Allergies / Medical:</strong> ${escapeHtml(enrollment.allergiesMedical)}</p>
            <p style="margin:4px 0;"><strong>Feeding & Nap Schedule:</strong> ${escapeHtml(enrollment.feedingNapNotes || 'None noted')}</p>
            <p style="margin:4px 0;"><strong>Goals & Notes for Miss Leah:</strong> ${escapeHtml(enrollment.parentGoals || 'None noted')}</p>
          </div>
        </div>
      `,
    });

    return sendJson(res, 201, {
      ok: true,
      enrollment,
      ownerEmail: config.ownerEmail,
      emailConfigured: Boolean(config.emailConfigured),
      smtpSent: smtpResult.sentViaSmtp,
    });
  }

  // Owner Admin Endpoints (One-Time Email PIN Protected — Zero Static PIN)
  if (pathname === '/api/admin/request-otp' && req.method === 'POST') {
    const body = await parseBody(req);
    const rawIdentity = String(body.identity || '').trim().toLowerCase();
    const digits = rawIdentity.replace(/\D/g, '');
    const ownerEmailLower = String(config.ownerEmail || 'homemontessorischool.missleah@gmail.com').toLowerCase();
    const ownerPhoneDigits = String(config.phone || '415-290-4736').replace(/\D/g, '');

    const emailMatch = rawIdentity === ownerEmailLower;
    const phoneMatch = ownerPhoneDigits.length >= 10 && digits.endsWith(ownerPhoneDigits.slice(-10));

    if (!emailMatch && !phoneMatch) {
      return sendJson(res, 403, {
        ok: false,
        error: 'Access denied. Identity does not match Miss Leah’s registered owner email or phone number.',
      });
    }

    const otpCode = String(crypto.randomInt(100000, 1000000));
    adminOtp = {
      hash: crypto.createHash('sha256').update(otpCode).digest('hex'),
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
    };

    const smtpResult = await sendSmtpEmailIfConfigured({
      to: config.ownerEmail,
      replyTo: config.ownerEmail,
      subject: `🔐 Owner Portal PIN: ${otpCode} — Home Montessori Play-School`,
      text: `Your one-time 6-digit Owner Portal security PIN is: ${otpCode}\n\nThis code is valid for 10 minutes and can only be used once.`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;padding:24px;background:#F5F4FB;border-radius:14px;color:#172038;border:1px solid #DDD6FE;">
          <h2 style="margin:0 0 8px;color:#0F766E;">Owner Portal One-Time PIN</h2>
          <p style="margin:0 0 16px;">Enter this single-use 6-digit security code to open your Home Montessori Play-School Owner Portal:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:6px;padding:14px 20px;background:#FFFFFF;border-radius:10px;border:2px solid #7C3AED;text-align:center;color:#4C1D95;">
            ${otpCode}
          </div>
          <p style="margin:14px 0 0;font-size:13px;color:#4E5B78;">Expires in 10 minutes. If you did not request this code, you can safely ignore this email.</p>
        </div>
      `,
    });

    let needsActivation = false;
    if (!smtpResult.sentViaSmtp) {
      try {
        const fsRes = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(config.ownerEmail)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: 'https://home-montessori-playschool.github.io',
            Referer: 'https://home-montessori-playschool.github.io/',
          },
          body: JSON.stringify({
            _subject: `🔐 Owner Portal PIN: ${otpCode} — Home Montessori Play-School`,
            _template: 'table',
            _captcha: 'false',
            One_Time_Security_PIN: otpCode,
            Valid_For: '10 minutes (single-use)',
            Portal: 'Home Montessori Play-School Owner Portal',
          }),
        });
        const fsJson = await fsRes.json().catch(() => ({}));
        if (String(fsJson.message || '').toLowerCase().includes('activation')) {
          needsActivation = true;
        }
      } catch {
        // Handled gracefully
      }
    }

    return sendJson(res, 200, {
      ok: true,
      maskedEmail: config.ownerEmail,
      needsActivation,
    });
  }

  if (pathname === '/api/admin/verify-otp' && req.method === 'POST') {
    const body = await parseBody(req);
    const code = String(body.code || '').trim();

    if (!adminOtp.hash || Date.now() > adminOtp.expiresAt) {
      adminOtp = { hash: null, expiresAt: 0, attempts: 0 };
      return sendJson(res, 401, { ok: false, error: 'This security code has expired. Please request a new 6-digit PIN.' });
    }

    adminOtp.attempts += 1;
    if (adminOtp.attempts > 5) {
      adminOtp = { hash: null, expiresAt: 0, attempts: 0 };
      return sendJson(res, 429, { ok: false, error: 'Too many incorrect attempts. Please request a new 6-digit PIN.' });
    }

    const candidateHash = crypto.createHash('sha256').update(code).digest('hex');
    if (candidateHash !== adminOtp.hash) {
      return sendJson(res, 401, { ok: false, error: 'Incorrect 6-digit PIN. Please check your email and try again.' });
    }

    // Strictly single-use OTP
    adminOtp = { hash: null, expiresAt: 0, attempts: 0 };
    const adminToken = crypto.randomBytes(24).toString('hex');
    adminSessions.set(adminToken, Date.now() + 15 * 60 * 1000);

    return sendJson(res, 200, { ok: true, adminToken });
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = String(req.headers['x-admin-token'] || '').trim();
    if (token) adminSessions.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/')) {
    const token = String(req.headers['x-admin-token'] || '').trim();
    const exp = adminSessions.get(token);
    if (!token || !exp || Date.now() > exp) {
      if (token) adminSessions.delete(token);
      return sendJson(res, 401, {
        ok: false,
        error: 'Your Owner Portal session has locked. Please verify with a new 6-digit email PIN.',
      });
    }

    if (req.method === 'GET' && pathname === '/api/admin/overview') {
      const inquiries = await readJson(FILES.inquiries, []);
      const enrollments = await readJson(FILES.enrollments, []);
      const parents = (await readJson(FILES.parents, [])).map(({ passwordHash, ...rest }) => rest);
      return sendJson(res, 200, { ok: true, config, inquiries, enrollments, parents });
    }

    if (req.method === 'POST' && pathname === '/api/admin/config') {
      const body = await parseBody(req);
      const updated = {
        ...config,
        ownerEmail: String(body.ownerEmail || config.ownerEmail).trim(),
        emailConfigured: Boolean(body.ownerEmail && String(body.ownerEmail).includes('@')),
        phone: String(body.phone ?? config.phone).trim(),
        openingsNow: body.openingsNow !== undefined ? Boolean(body.openingsNow) : config.openingsNow,
        openingsBanner: String(body.openingsBanner ?? config.openingsBanner).trim(),
        tuitionFullTime: Number(body.tuitionFullTime || config.tuitionFullTime),
        tuitionPartTime: Number(body.tuitionPartTime || config.tuitionPartTime),
      };
      await writeJson(FILES.config, updated);
      return sendJson(res, 200, { ok: true, config: updated });
    }

    if (req.method === 'PATCH' && pathname === '/api/admin/status') {
      const body = await parseBody(req);
      const { collection, id, status } = body;
      const targetFile = collection === 'enrollments' ? FILES.enrollments : FILES.inquiries;
      const items = await readJson(targetFile, []);
      const item = items.find(x => x.id === id);
      if (!item) return sendJson(res, 404, { ok: false, error: 'Record not found.' });
      item.status = String(status || item.status);
      await writeJson(targetFile, items);
      return sendJson(res, 200, { ok: true, item });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'API route not found.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(urlObj.pathname);

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    let safePath = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let filePath = resolved;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || 'Internal server error' });
  }
});

ensureDataFiles().then(() => {
  server.listen(PORT, () => {
    console.log(`Home Montessori Play-School server running at http://localhost:${PORT}`);
  });
});
