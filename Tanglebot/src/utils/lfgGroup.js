const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { CATEGORIES } = require('./roleMenu');

// The time dropdown offers start times across the next several hours, in
// half-hour increments, starting from the next half-hour boundary after "now".
const SLOT_INTERVAL_MINUTES = 30;
const SLOT_WINDOW_HOURS = 8;

// Optional: set LFG_TIMEZONE in .env (e.g. "America/New_York") to control
// how the time dropdown's OWN labels are displayed while picking. This has
// no effect on the final posted time — that always auto-converts to each
// viewer's own timezone via Discord's <t:...> timestamp format. Defaults to
// Pacific Time; override with LFG_TIMEZONE if your community's primary
// timezone is different.
const DROPDOWN_TIMEZONE = process.env.LFG_TIMEZONE || 'America/Los_Angeles';

const DURATION_OPTIONS = [
  { value: '30', label: '30 min' },
  { value: '60', label: '1 Hour' },
  { value: '90', label: '1.5 Hours' },
  { value: '120', label: '2 Hours' },
  { value: '150', label: '2.5 Hours' },
  { value: '180', label: '3 Hours' },
  { value: '210', label: '3.5 Hours' },
  { value: '240', label: '4 Hours' },
  { value: '270', label: '4.5 Hours' },
  { value: '300', label: '5 Hours' },
  { value: '330', label: '5.5 Hours' },
  { value: '360', label: '6 Hours' },
];

const SIZE_OPTIONS = [
  { value: '2', label: 'Duo (2 players)' },
  { value: '3', label: 'Trio (3 players)' },
  { value: '4', label: '4 Man (4 players)' },
  { value: '5', label: '5 Man (5 players)' },
  { value: 'any', label: 'Any (no limit)' },
];

// How long a full/manually-closed group's post stays up before auto-deleting.
const GROUP_FORMED_CLEANUP_DELAY_MS = 5 * 60 * 1000;
// How long a disbanded group's post stays up before auto-deleting (short —
// just long enough for the "Disbanded" state to be visible).
const DISBAND_CLEANUP_DELAY_MS = 10 * 1000;

// In-memory state. Both of these are lost on a restart/redeploy — fine for
// same-day LFG posts, but worth knowing if the bot redeploys mid-event.
const setupSessions = new Map(); // userId -> { role, time, duration, size }
const activeGroups = new Map(); // groupId -> group state

// ---- Building the role dropdown from roleMenu.js's CATEGORIES ----
function buildRoleOptions() {
  const options = [];
  for (const cat of Object.values(CATEGORIES)) {
    for (const r of cat.roles) {
      options.push({
        value: `${cat.key}:${r.value}`,
        label: `${cat.buttonLabel}: ${r.label}`,
        roleName: r.roleName,
      });
    }
  }
  return options;
}

function findRoleOption(value) {
  return buildRoleOptions().find((o) => o.value === value);
}

// ---- Building the time dropdown: a single start time, next 8 hours, 30-min increments ----
function buildTimeOptions() {
  const now = new Date();
  const start = new Date(now);
  start.setSeconds(0, 0);
  const remainder = start.getMinutes() % SLOT_INTERVAL_MINUTES;
  start.setMinutes(start.getMinutes() + (SLOT_INTERVAL_MINUTES - remainder)); // next half-hour boundary

  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DROPDOWN_TIMEZONE,
  });

  const totalSlots = (SLOT_WINDOW_HOURS * 60) / SLOT_INTERVAL_MINUTES;
  const options = [];
  for (let i = 0; i < totalSlots; i++) {
    const slot = new Date(start.getTime() + i * SLOT_INTERVAL_MINUTES * 60 * 1000);
    const label = fmt.format(slot);
    const epochSeconds = Math.floor(slot.getTime() / 1000);
    options.push({ value: String(epochSeconds), label });
  }
  return options;
}

function findTimeOption(value) {
  return buildTimeOptions().find((o) => o.value === value);
}

function findDurationOption(value) {
  return DURATION_OPTIONS.find((o) => o.value === value);
}

function findSizeOption(value) {
  return SIZE_OPTIONS.find((o) => o.value === value);
}

// ---- Setup UI (the private "build your LFG post" menu) ----
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { role: null, time: null, duration: null, size: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const roleSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:role')
    .setPlaceholder('1. Choose an activity')
    .addOptions(
      buildRoleOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.role === o.value,
      }))
    );

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:time')
    .setPlaceholder('2. Choose a start time')
    .addOptions(
      buildTimeOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.time === o.value,
      }))
    );

  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:duration')
    .setPlaceholder('3. Choose a duration')
    .addOptions(
      DURATION_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        default: session.duration === o.value,
      }))
    );

  const sizeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:size')
    .setPlaceholder('4. Choose group size')
    .addOptions(
      SIZE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        default: session.size === o.value,
      }))
    );

  const rows = [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(timeSelect),
    new ActionRowBuilder().addComponents(durationSelect),
    new ActionRowBuilder().addComponents(sizeSelect),
  ];

  if (session.role && session.time && session.duration && session.size) {
    const createButton = new ButtonBuilder()
      .setCustomId('lfg:create')
      .setLabel('Create LFG Post')
      .setStyle(ButtonStyle.Success);
    rows.push(new ActionRowBuilder().addComponents(createButton));
  }

  return rows;
}

function buildSetupContent(session) {
  const parts = [];
  if (session.role) parts.push(`**Activity:** ${findRoleOption(session.role)?.label ?? '?'}`);
  if (session.time) parts.push(`**Start:** ${findTimeOption(session.time)?.label ?? '?'}`);
  if (session.duration) parts.push(`**Duration:** ${findDurationOption(session.duration)?.label ?? '?'}`);
  if (session.size) parts.push(`**Size:** ${findSizeOption(session.size)?.label ?? '?'}`);

  const summary = parts.length ? parts.join('  •  ') + '\n\n' : '';
  return `${summary}Pick an activity, a start time, a duration, and a group size, then hit **Create LFG Post**.`;
}

async function sendSetupMenu(interaction) {
  const session = getSession(interaction.user.id);
  await interaction.reply({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetupSelect(interaction, field) {
  const session = getSession(interaction.user.id);
  session[field] = interaction.values[0];
  await interaction.update({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
  });
}

// ---- Posting the public LFG group message ----
function makeGroupId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// status: 'open' | 'closed' (full or manually closed) | 'disbanded'
// prefix lets the forum variant reuse this with its own customId namespace.
function buildGroupRow(groupId, status, prefix = 'lfggroup') {
  if (status === 'open') {
    const join = new ButtonBuilder()
      .setCustomId(`${prefix}:join:${groupId}`)
      .setLabel('Join Group')
      .setStyle(ButtonStyle.Success);
    const close = new ButtonBuilder()
      .setCustomId(`${prefix}:close:${groupId}`)
      .setLabel('Close Group')
      .setStyle(ButtonStyle.Primary);
    const disband = new ButtonBuilder()
      .setCustomId(`${prefix}:disband:${groupId}`)
      .setLabel('Disband Group')
      .setStyle(ButtonStyle.Danger);
    return new ActionRowBuilder().addComponents(join, close, disband);
  }

  if (status === 'closed') {
    const full = new ButtonBuilder()
      .setCustomId(`${prefix}:full:${groupId}`)
      .setLabel('Group Full')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    return new ActionRowBuilder().addComponents(full);
  }

  // disbanded
  const disbanded = new ButtonBuilder()
    .setCustomId(`${prefix}:disbanded:${groupId}`)
    .setLabel('Disbanded')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  return new ActionRowBuilder().addComponents(disbanded);
}

function buildGroupEmbed(group) {
  const capDisplay = group.sizeCap === Infinity ? '∞' : String(group.sizeCap);
  const memberLines = [...group.members].map((id) => `<@${id}>`).join('\n');

  let title = '🔍 Looking For Group';
  let color = 0xc2a24c;
  if (group.status === 'closed') {
    title = '🔒 Looking For Group — Full';
    color = 0x2ecc71;
  } else if (group.status === 'disbanded') {
    title = '❌ Looking For Group — Disbanded';
    color = 0xe74c3c;
  }

  const descLines = [
    `**Activity:** ${group.roleLabel}`,
    `**Start:** <t:${group.timeEpoch}:t> (<t:${group.timeEpoch}:R>)`,
    `**Duration:** ${group.durationLabel}`,
    `**Ends around:** <t:${group.endEpoch}:t>`,
    `**Group Size:** ${group.sizeLabel}`,
  ];
  if (group.description) descLines.push(`**Description:** ${group.description}`);
  descLines.push('', `**Members (${group.members.size}/${capDisplay}):**`, memberLines || '_none yet_');

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(descLines.join('\n'))
    .setColor(color)
    .setFooter({ text: `Started by ${group.creatorTag}` });
}

async function handleCreateButton(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.role || !session.time || !session.duration || !session.size) {
    return interaction.reply({ content: '⚠️ Please pick all four options first.', flags: MessageFlags.Ephemeral });
  }

  const roleOption = findRoleOption(session.role);
  const timeOption = findTimeOption(session.time);
  const durationOption = findDurationOption(session.duration);
  const sizeOption = findSizeOption(session.size);

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === roleOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${roleOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const groupId = makeGroupId();
  const sizeCap = sizeOption.value === 'any' ? Infinity : parseInt(sizeOption.value, 10);
  const timeEpoch = parseInt(timeOption.value, 10);
  const durationMinutes = parseInt(durationOption.value, 10);
  const endEpoch = timeEpoch + durationMinutes * 60;

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel: roleOption.label,
    timeEpoch,
    durationLabel: durationOption.label,
    durationMinutes,
    endEpoch,
    sizeLabel: sizeOption.label,
    sizeCap,
    members: new Set([interaction.user.id]),
    status: 'open',
    channelId: null,
    messageId: null,
    formedMessageId: null,
    cleanupTimeoutId: null,
  };
  activeGroups.set(groupId, group);

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, 'open');

  const publicMessage = await interaction.channel.send({
    content: `<@&${guildRole.id}>`,
    embeds: [embed],
    components: [row],
  });

  group.channelId = publicMessage.channelId;
  group.messageId = publicMessage.id;

  // Auto-delete once the event's end time (start + duration) has passed,
  // unless the group closes/fills/disbands sooner.
  scheduleGroupCleanup(interaction.client, group, Math.max(group.endEpoch * 1000 - Date.now(), 0));
  setupSessions.delete(interaction.user.id);

  await interaction.update({ content: '✅ Your LFG post has been created below!', components: [] });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
}

async function handleJoinButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (group.status === 'closed') {
    return interaction.reply({ content: '⚠️ This group is already full.', flags: MessageFlags.Ephemeral });
  }
  if (group.status === 'disbanded') {
    return interaction.reply({ content: '⚠️ This group has been disbanded.', flags: MessageFlags.Ephemeral });
  }
  if (group.members.has(interaction.user.id)) {
    return interaction.reply({ content: 'You\'re already in this group.', flags: MessageFlags.Ephemeral });
  }

  group.members.add(interaction.user.id);
  const justFilled = group.sizeCap !== Infinity && group.members.size >= group.sizeCap;
  if (justFilled) {
    group.status = 'closed';
  }

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, group.status);

  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: '✅ You joined the group!', flags: MessageFlags.Ephemeral });

  if (justFilled) {
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    const formedMessage = await interaction.channel.send({
      content: `${mentions}\n🎉 **Group formed, Good luck!**`,
    });
    group.formedMessageId = formedMessage.id;
    scheduleGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
  }
}

async function handleCloseButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== group.creatorId) {
    return interaction.reply({ content: '⚠️ Only the group creator can close this group.', flags: MessageFlags.Ephemeral });
  }
  if (group.status !== 'open') {
    return interaction.reply({ content: '⚠️ This group is already closed.', flags: MessageFlags.Ephemeral });
  }

  group.status = 'closed';
  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, 'closed');
  await interaction.update({ embeds: [embed], components: [row] });

  const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
  const formedMessage = await interaction.channel.send({
    content: `${mentions}\n🎉 **Group formed, Good luck!**`,
  });
  group.formedMessageId = formedMessage.id;

  scheduleGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
}

async function handleDisbandButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== group.creatorId) {
    return interaction.reply({ content: '⚠️ Only the group creator can disband this group.', flags: MessageFlags.Ephemeral });
  }
  if (group.status !== 'open') {
    return interaction.reply({ content: '⚠️ This group is already closed.', flags: MessageFlags.Ephemeral });
  }

  group.status = 'disbanded';
  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, 'disbanded');
  await interaction.update({ embeds: [embed], components: [row] });

  scheduleGroupCleanup(interaction.client, group, DISBAND_CLEANUP_DELAY_MS);
}

function scheduleGroupCleanup(client, group, delayMs) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  group.cleanupTimeoutId = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(group.channelId);
      await channel.messages.fetch(group.messageId).then((m) => m.delete()).catch(() => {});
      if (group.formedMessageId) {
        await channel.messages.fetch(group.formedMessageId).then((m) => m.delete()).catch(() => {});
      }
    } catch (err) {
      console.error(`Could not delete expired LFG post ${group.id}:`, err.message);
    }
    activeGroups.delete(group.id);
  }, delayMs);
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfg:select:<field>"
  if (!['role', 'time', 'duration', 'size'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgButtonInteraction(interaction) {
  if (interaction.customId === 'lfg:create') {
    return handleCreateButton(interaction);
  }
}

async function handleLfgGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfggroup:<action>:<groupId>"
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'close') return handleCloseButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgSelectInteraction,
  handleLfgButtonInteraction,
  handleLfgGroupButtonInteraction,
  // Shared building blocks, reused by lfgForum.js so both versions stay in sync.
  buildRoleOptions,
  buildTimeOptions,
  DURATION_OPTIONS,
  findRoleOption,
  findTimeOption,
  findDurationOption,
  findSizeOption,
  SIZE_OPTIONS,
  buildGroupEmbed,
  buildGroupRow,
  makeGroupId,
  GROUP_FORMED_CLEANUP_DELAY_MS,
  DISBAND_CLEANUP_DELAY_MS,
};
