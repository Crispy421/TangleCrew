const { readJson, writeJson } = require('./db');

const LAST_SUBMISSION_FILE = 'last-submission.json';

const REQUIRED_ENV_KEYS = [
  'DISCORD_SUBMISSION_CHANNEL_EVENT_MAP',
  'SUPABASE_DISCORD_KC_INTAKE_URL',
  'DISCORD_KC_INTAKE_SECRET',
];

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

function loadSubmissionConfig(env = process.env) {
  const missing = REQUIRED_ENV_KEYS.filter(key => !env[key]);
  if (missing.length === REQUIRED_ENV_KEYS.length) {
    return { enabled: false, missing };
  }

  if (missing.length > 0) {
    throw new Error(`Submission intake is partially configured. Missing: ${missing.join(', ')}`);
  }

  let channelEventMap;
  try {
    channelEventMap = JSON.parse(env.DISCORD_SUBMISSION_CHANNEL_EVENT_MAP);
  } catch (error) {
    throw new Error('DISCORD_SUBMISSION_CHANNEL_EVENT_MAP must be valid JSON.');
  }

  return {
    channelEventMap,
    enabled: true,
    intakeSecret: env.DISCORD_KC_INTAKE_SECRET,
    intakeUrl: env.SUPABASE_DISCORD_KC_INTAKE_URL,
  };
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

  const eventId = config.channelEventMap[message.channelId];
  if (!eventId) return;

  const parsed = parseSubmissionBody(message.content);
  const isKc = isKcSubmission(parsed);
  const isDrop = isDropSubmission(parsed);
  if ((!isKc && !isDrop) || (isKc && isDrop)) {
    await message.reply(buildResubmitMessage('Your submission is missing one or more required fields.'));
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

    console.log(`Submission forwarded: type=${isDrop ? 'drop' : 'kc'} message=${message.id} channel=${message.channelId} event=${eventId}`);

    await statusReply.edit(isDrop
      ? 'Drop proof received and sent to the site for manual review.'
      : 'KC proof received and sent to the site for manual review.');
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
  SUBMISSION_FORMAT_MESSAGE,
  getLastAcceptedSubmission,
  handleSubmissionMessage,
  loadSubmissionConfig,
  parseSubmissionBody,
};
