const axios = require('axios');
const { readJson, writeJson } = require('./db');

const LAST_SUBMISSION_FILE = 'last-submission.json';
const ACTIVE_SESSION_FILE = 'active-kc-sessions.json';
const SUBMISSION_RUNTIME_CONFIG_FILE = 'submission-runtime-config.json';
const KC_SESSION_DURATION_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const CHANNEL_EVENT_CACHE_TTL_MS = 60 * 1000;

const REQUIRED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DISCORD_KC_INTAKE_URL',
  'DISCORD_KC_INTAKE_SECRET',
];

const channelEventCache = new Map();

const SUBMISSION_FORMAT_MESSAGE = [
  '**KC proof format**',
  '```',
  'Task name on Board: <tile title>',
  'Monster being Killed: <monster name>',
  'Starting or Ending: Starting',
  'Starting Kill Count: 1234',
  '```',
  '**Drop proof format**',
  '```',
  'Task name on Board: <tile title>',
  'Item Dropped: <item name>',
  '```',
  'Include exactly one image attachment. For ending KC submissions, `Starting or Ending: Ending`, `Ending Kill Count: 1234`, or `Kill Count: 1234` are accepted.',
].join('\n');

function normalizeLabel(value) {
  return value.trim().toLowerCase();
}

function getDiscordIdentity(user) {
  const username = user?.username?.trim() ?? '';
  const discriminator = user?.discriminator?.trim() ?? '';
  if (!username) return '';
  if (!discriminator || discriminator === '0') return username;
  return `${username}#${discriminator}`;
}

function buildResubmitMessage(extraReason) {
  return [
    extraReason,
    'Please resubmit using one of these exact formats:',
    SUBMISSION_FORMAT_MESSAGE,
  ].join('\n');
}

function getSubmissionRuntimeConfig() {
  const config = readJson(SUBMISSION_RUNTIME_CONFIG_FILE);
  return config && typeof config === 'object' ? config : {};
}

function getConfiguredIntakeUrl(env = process.env) {
  const runtimeConfig = getSubmissionRuntimeConfig();
  const runtimeValue = typeof runtimeConfig.intakeUrl === 'string' ? runtimeConfig.intakeUrl.trim() : '';
  if (runtimeValue) {
    return runtimeValue;
  }

  return env.SUPABASE_DISCORD_KC_INTAKE_URL?.trim() ?? '';
}

function setConfiguredIntakeUrl(url) {
  const runtimeConfig = getSubmissionRuntimeConfig();
  runtimeConfig.intakeUrl = url;
  writeJson(SUBMISSION_RUNTIME_CONFIG_FILE, runtimeConfig);
  return runtimeConfig.intakeUrl;
}

function parseSubmissionBody(content) {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const result = {
    itemDropped: null,
    kcValue: null,
    monsterName: null,
    phase: null,
    taskName: null,
  };

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const label = normalizeLabel(line.slice(0, separatorIndex));
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;

    if (label === 'task name on board') {
      result.taskName = value;
      continue;
    }

    if (label === 'monster being killed') {
      result.monsterName = value;
      continue;
    }

    if (label === 'item dropped') {
      result.itemDropped = value;
      continue;
    }

    if (label === 'starting or ending') {
      const normalizedValue = normalizeLabel(value);
      if (normalizedValue === 'starting' || normalizedValue === 'ending') {
        result.phase = normalizedValue;
      }
      continue;
    }

    if (label === 'starting kill count' || label === 'ending kill count' || label === 'kill count') {
      const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(parsed)) {
        result.kcValue = parsed;
        if (!result.phase && label === 'ending kill count') {
          result.phase = 'ending';
        }
        if (!result.phase && label === 'starting kill count') {
          result.phase = 'starting';
        }
      }
    }
  }

  return result;
}

function isKcSubmission(parsed) {
  return !!parsed.taskName && !!parsed.monsterName && !!parsed.phase && parsed.kcValue !== null;
}

function isDropSubmission(parsed) {
  return !!parsed.taskName && !!parsed.itemDropped;
}

function isExpectedSubmissionForSession(parsed, session) {
  if (isDropSubmission(parsed)) {
    return session.mode === 'start';
  }

  if (!isKcSubmission(parsed)) {
    return false;
  }

  if (session.mode === 'start') {
    return parsed.phase === 'starting';
  }

  if (session.mode === 'end') {
    return parsed.phase === 'ending';
  }

  return false;
}

function loadSubmissionConfig(env = process.env) {
  const effectiveIntakeUrl = getConfiguredIntakeUrl(env);
  const missing = REQUIRED_ENV_KEYS.filter(key => {
    if (key === 'SUPABASE_DISCORD_KC_INTAKE_URL') {
      return !effectiveIntakeUrl;
    }

    return !env[key];
  });
  if (missing.length === REQUIRED_ENV_KEYS.length) {
    return { enabled: false, missing };
  }

  if (missing.length > 0) {
    throw new Error(`Submission intake is partially configured. Missing: ${missing.join(', ')}`);
  }

  return {
    enabled: true,
    intakeSecret: env.DISCORD_KC_INTAKE_SECRET,
    intakeUrl: effectiveIntakeUrl,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseUrl: env.SUPABASE_URL.replace(/\/+$/, ''),
  };
}

function getCachedChannelEvent(channelId) {
  const cached = channelEventCache.get(channelId);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    channelEventCache.delete(channelId);
    return undefined;
  }
  return cached.eventId;
}

function setCachedChannelEvent(channelId, eventId) {
  channelEventCache.set(channelId, {
    eventId,
    expiresAt: Date.now() + CHANNEL_EVENT_CACHE_TTL_MS,
  });
}

async function resolveEventIdForChannel(channelId, config) {
  const cached = getCachedChannelEvent(channelId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await axios.get(`${config.supabaseUrl}/rest/v1/event_discord_channels`, {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      },
      params: {
        select: 'event_id',
        channel_id: `eq.${channelId}`,
        channel_kind: 'eq.submission',
        limit: 1,
      },
      timeout: 10000,
    });

    const eventId = response.data?.[0]?.event_id ?? null;
    setCachedChannelEvent(channelId, eventId);
    return eventId;
  } catch (error) {
    const details = error.response?.data ?? error.message;
    console.error('Failed to resolve Discord submission channel via Supabase event_discord_channels:', {
      channelId,
      details,
    });
    throw new Error('Unable to verify whether this channel is configured for submissions right now.');
  }
}

async function forwardSubmission({ attachment, config, eventId, message, parsed }) {
  const response = await fetch(config.intakeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.intakeSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channelId: message.channelId,
      discordMessageId: message.id,
      discordName: getDiscordIdentity(message.author),
      eventId,
      imageUrl: attachment.url,
      imageContentType: attachment.contentType ?? 'image/png',
      imageFilename: attachment.name ?? `discord-${message.id}.png`,
      itemDropped: parsed.itemDropped,
      kcValue: parsed.kcValue,
      monsterName: parsed.monsterName,
      phase: parsed.phase,
      taskName: parsed.taskName,
    }),
  });

  const responseText = await response.text();
  let payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const messageText =
      typeof payload?.error === 'string'
        ? payload.error
        : responseText.trim() || `Intake request failed with status ${response.status}.`;
    throw new Error(messageText);
  }

  return payload;
}

function getMessageUrl(message) {
  if (!message.guildId) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function getLastAcceptedSubmission() {
  return readJson(LAST_SUBMISSION_FILE);
}

function getActiveSessions() {
  const sessions = readJson(ACTIVE_SESSION_FILE);
  return sessions && typeof sessions === 'object' ? sessions : {};
}

function getSessionExpiryIso(startedAt) {
  const startedAtMs = Date.parse(startedAt);
  return new Date(startedAtMs + KC_SESSION_DURATION_MS).toISOString();
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return null;

  const normalized = { ...session };
  if (!normalized.startedAt) {
    normalized.startedAt = new Date().toISOString();
  }
  if (!normalized.mode) {
    normalized.mode = 'start';
  }
  if (!normalized.expiresAt) {
    normalized.expiresAt = getSessionExpiryIso(normalized.startedAt);
  }

  return normalized;
}

function isSessionExpired(session, now = Date.now()) {
  const expiresAtMs = Date.parse(session.expiresAt ?? '');
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
}

function pruneExpiredSessions() {
  const sessions = getActiveSessions();
  const now = Date.now();
  let changed = false;

  for (const [userId, rawSession] of Object.entries(sessions)) {
    const session = normalizeSession(rawSession);
    if (!session || isSessionExpired(session, now)) {
      delete sessions[userId];
      changed = true;
      continue;
    }

    if (JSON.stringify(session) !== JSON.stringify(rawSession)) {
      sessions[userId] = session;
      changed = true;
    }
  }

  if (changed) {
    writeJson(ACTIVE_SESSION_FILE, sessions);
  }
}

function getActiveSession(userId) {
  if (!userId) return null;
  const sessions = getActiveSessions();
  const rawSession = sessions[userId];
  if (!rawSession) return null;

  const session = normalizeSession(rawSession);
  if (!session || isSessionExpired(session)) {
    delete sessions[userId];
    writeJson(ACTIVE_SESSION_FILE, sessions);
    return null;
  }

  if (JSON.stringify(session) !== JSON.stringify(rawSession)) {
    sessions[userId] = session;
    writeJson(ACTIVE_SESSION_FILE, sessions);
  }

  return session;
}

function setActiveSession(session) {
  const sessions = getActiveSessions();
  sessions[session.userId] = normalizeSession(session);
  writeJson(ACTIVE_SESSION_FILE, sessions);
  return sessions[session.userId];
}

function clearActiveSession(userId) {
  if (!userId) return false;

  const sessions = getActiveSessions();
  if (!sessions[userId]) return false;

  delete sessions[userId];
  writeJson(ACTIVE_SESSION_FILE, sessions);
  return true;
}

function startActiveSessionSweep() {
  pruneExpiredSessions();
  return setInterval(pruneExpiredSessions, SESSION_SWEEP_INTERVAL_MS);
}

function saveLastAcceptedSubmission({ attachment, eventId, isDrop, message, parsed }) {
  const submission = {
    acceptedAt: new Date().toISOString(),
    channelId: message.channelId,
    discordMessageId: message.id,
    discordName: getDiscordIdentity(message.author),
    eventId,
    imageUrl: attachment.url,
    itemDropped: parsed.itemDropped,
    kcValue: parsed.kcValue,
    messageUrl: getMessageUrl(message),
    monsterName: parsed.monsterName,
    phase: parsed.phase,
    taskName: parsed.taskName,
    type: isDrop ? 'drop' : 'kc',
  };

  writeJson(LAST_SUBMISSION_FILE, submission);
  return submission;
}

async function handleSubmissionMessage(message, config) {
  if (!config.enabled || message.author.bot) return;

  const session = getActiveSession(message.author.id);
  if (!session) return;
  if (session.channelId !== message.channelId) return;

  let eventId;
  try {
    eventId = await resolveEventIdForChannel(message.channelId, config);
  } catch {
    await message.reply('Submission routing is temporarily unavailable. Please try again in a moment.');
    return;
  }

  if (!eventId || eventId !== session.eventId) {
    clearActiveSession(message.author.id);
    if (eventId) {
      await message.reply('Your active KC session no longer matches this channel configuration. Run `/kc start` again before submitting proof.');
    }
    return;
  }

  const parsed = parseSubmissionBody(message.content);
  const isKc = isKcSubmission(parsed);
  const isDrop = isDropSubmission(parsed);
  if ((!isKc && !isDrop) || (isKc && isDrop)) {
    await message.reply(buildResubmitMessage('Your submission is missing one or more required fields.'));
    return;
  }

  if (!isExpectedSubmissionForSession(parsed, session)) {
    const reason = session.mode === 'end'
      ? 'Your active `/kc end` session only accepts an ending KC submission.'
      : 'Your active `/kc start` session accepts starting KC submissions and drop proofs only.';
    await message.reply(buildResubmitMessage(reason));
    return;
  }

  const imageAttachments = [...message.attachments.values()]
    .filter(attachment => attachment.contentType?.startsWith('image/'));
  if (imageAttachments.length !== 1) {
    await message.reply(buildResubmitMessage('Your submission must include exactly one image attachment showing the KC or drop proof.'));
    return;
  }

  const statusReply = await message.reply(
    isDrop
      ? 'Drop proof received. Attempting to upload it for manual review...'
      : 'KC proof received. Attempting to upload it for manual review...'
  );

  try {
    const result = await forwardSubmission({
      attachment: imageAttachments[0],
      config,
      eventId,
      message,
      parsed,
    });

    if (result?.duplicate) {
      console.log(`Duplicate submission ignored: message=${message.id} channel=${message.channelId} event=${eventId}`);
      await statusReply.edit('This Discord message was already processed and is still linked to a pending submission.');
      return;
    }

    saveLastAcceptedSubmission({
      attachment: imageAttachments[0],
      eventId,
      isDrop,
      message,
      parsed,
    });
    if (session.mode === 'end') {
      clearActiveSession(message.author.id);
    }

    console.log(`Submission forwarded: type=${isDrop ? 'drop' : 'kc'} message=${message.id} channel=${message.channelId} event=${eventId}`);

    const successMessage = isDrop
      ? 'Drop proof received and sent to the site for manual review.'
      : 'KC proof received and sent to the site for manual review.';
    await statusReply.edit(session.mode === 'end'
      ? `${successMessage} Your KC session is now closed.`
      : `${successMessage} Your KC session remains active until you run \`/kc end\`.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error.';
    console.error('Submission upload failed:', {
      channelId: message.channelId,
      discordMessageId: message.id,
      eventId,
      reason,
      type: isDrop ? 'drop' : 'kc',
    });
    await statusReply.edit(buildResubmitMessage(`Submission rejected: ${reason}`));
  }
}

module.exports = {
  CHANNEL_EVENT_CACHE_TTL_MS,
  KC_SESSION_DURATION_MS,
  SUBMISSION_FORMAT_MESSAGE,
  clearActiveSession,
  getConfiguredIntakeUrl,
  resolveEventIdForChannel,
  getActiveSession,
  getLastAcceptedSubmission,
  getSubmissionRuntimeConfig,
  handleSubmissionMessage,
  isDropSubmission,
  isKcSubmission,
  loadSubmissionConfig,
  parseSubmissionBody,
  setConfiguredIntakeUrl,
  setActiveSession,
  startActiveSessionSweep,
};
