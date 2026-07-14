const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { CATEGORIES } = require('./roleMenu');

// Top-level accordion categories. Order matches how they're shown in the
// first dropdown. Add a 'minigames' entry here (and to roleMenu.js's
// CATEGORIES) later to extend this to Minigame/Skilling.
const CATEGORY_OPTIONS = [
  { key: 'raids', label: 'Raid' },
  { key: 'bossing', label: 'Boss' },
];

function findCategoryOption(key) {
  return CATEGORY_OPTIONS.find((o) => o.key === key);
}

function getActivityOptions(categoryKey) {
  return CATEGORIES[categoryKey]?.roles ?? [];
}

function findActivityOption(categoryKey, value) {
  return getActivityOptions(categoryKey).find((r) => r.value === value);
}

// Group size options: 2 players up to the activity's max, one at a time.
// Lets the creator run a smaller group than the activity's full cap
// (e.g. 2 players for a boss that supports up to 5).
function buildSizeOptions(maxPlayers) {
  const options = [];
  for (let n = 2; n <= maxPlayers; n++) {
    options.push({ value: String(n), label: n === maxPlayers ? `${n} Players (Max)` : `${n} Players` });
  }
  return options;
}

function findSizeOption(maxPlayers, value) {
  return buildSizeOptions(maxPlayers).find((o) => o.value === value);
}

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

// How long a full/manually-closed group's post stays up before auto-deleting.
const GROUP_FORMED_CLEANUP_DELAY_MS = 5 * 60 * 1000;

// In-memory state. Both of these are lost on a restart/redeploy — fine for
// same-day LFG posts, but worth knowing if the bot redeploys mid-event.
const setupSessions = new Map(); // userId -> { category, activity, size, time, duration }
const activeGroups = new Map(); // groupId -> group state

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

// ---- Setup UI (accordion: Category -> Activity -> Size -> Start Time -> Duration) ----
// No separate "Create" button — Discord caps messages at 5 component rows,
// and 5 dropdowns already uses all of them. The post is created
// automatically the moment the last dropdown (Duration) is filled.
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { category: null, activity: null, size: null, time: null, duration: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const rows = [];

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:category')
    .setPlaceholder('1. Choose a category')
    .addOptions(
      CATEGORY_OPTIONS.map((o) => ({
        value: o.key,
        label: o.label,
        default: session.category === o.key,
      }))
    );
  rows.push(new ActionRowBuilder().addComponents(categorySelect));

  if (session.category) {
    const activitySelect = new StringSelectMenuBuilder()
      .setCustomId('lfg:select:activity')
      .setPlaceholder('2. Choose an activity')
      .addOptions(
        getActivityOptions(session.category).map((r) => ({
          value: r.value,
          label: `${r.label} (max ${r.maxPlayers})`,
          default: session.activity === r.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(activitySelect));
  }

  if (session.category && session.activity) {
    const activityOption = findActivityOption(session.category, session.activity);
    const sizeSelect = new StringSelectMenuBuilder()
      .setCustomId('lfg:select:size')
      .setPlaceholder('3. Choose group size')
      .addOptions(
        buildSizeOptions(activityOption.maxPlayers).map((o) => ({
          value: o.value,
          label: o.label,
          default: session.size === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(sizeSelect));
  }

  if (session.category && session.activity && session.size) {
    const timeSelect = new StringSelectMenuBuilder()
      .setCustomId('lfg:select:time')
      .setPlaceholder('4. Choose a start time')
      .addOptions(
        buildTimeOptions().map((o) => ({
          value: o.value,
          label: o.label,
          default: session.time === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(timeSelect));
  }

  if (session.category && session.activity && session.size && session.time) {
    const durationSelect = new StringSelectMenuBuilder()
      .setCustomId('lfg:select:duration')
      .setPlaceholder('5. Choose a duration')
      .addOptions(
        DURATION_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          default: session.duration === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(durationSelect));
  }

  return rows;
}

function buildSetupContent(session) {
  const parts = [];
  if (session.category) parts.push(`**Category:** ${findCategoryOption(session.category)?.label ?? '?'}`);
  if (session.category && session.activity) {
    const opt = findActivityOption(session.category, session.activity);
    parts.push(`**Activity:** ${opt?.label ?? '?'}`);
  }
  if (session.category && session.activity && session.size) {
    const activityOption = findActivityOption(session.category, session.activity);
    parts.push(`**Size:** ${findSizeOption(activityOption.maxPlayers, session.size)?.label ?? '?'}`);
  }
  if (session.time) parts.push(`**Start:** ${findTimeOption(session.time)?.label ?? '?'}`);
  if (session.duration) parts.push(`**Duration:** ${findDurationOption(session.duration)?.label ?? '?'}`);

  const summary = parts.length ? parts.join('  •  ') + '\n\n' : '';
  return `${summary}Pick a category, an activity, a group size, a start time, and a duration. Your post is created automatically once all five are picked.`;
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

  if (field === 'category') {
    // Changing the category invalidates everything chosen under the old
    // category, so the accordion collapses back down.
    session.activity = null;
    session.size = null;
    session.time = null;
    session.duration = null;
  }
  if (field === 'activity') {
    // Size options depend on the chosen activity's max player count.
    session.size = null;
  }

  const allFilled = session.category && session.activity && session.size && session.time && session.duration;
  if (allFilled) {
    return handleCreatePost(interaction);
  }

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
  descLines.push('', `**Members (${group.members.size}/${group.sizeCap}):**`, memberLines || '_none yet_');

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(descLines.join('\n'))
    .setColor(color)
    .setFooter({ text: `Started by ${group.creatorTag}` });
}

async function handleCreatePost(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time || !session.duration) {
    return interaction.reply({ content: '⚠️ Please pick all five options first.', flags: MessageFlags.Ephemeral });
  }

  const categoryOption = findCategoryOption(session.category);
  const activityOption = findActivityOption(session.category, session.activity);
  const sizeOption = findSizeOption(activityOption.maxPlayers, session.size);
  const timeOption = findTimeOption(session.time);
  const durationOption = findDurationOption(session.duration);

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === activityOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${activityOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const groupId = makeGroupId();
  const timeEpoch = parseInt(timeOption.value, 10);
  const durationMinutes = parseInt(durationOption.value, 10);
  const endEpoch = timeEpoch + durationMinutes * 60;
  const sizeCap = parseInt(sizeOption.value, 10);

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel: `${categoryOption.label}: ${activityOption.label}`,
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
  const justFilled = group.members.size >= group.sizeCap;
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
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  await interaction.deferUpdate();

  try {
    const channel = await interaction.client.channels.fetch(group.channelId);
    await channel.messages.fetch(group.messageId).then((m) => m.delete());
    if (group.formedMessageId) {
      await channel.messages.fetch(group.formedMessageId).then((m) => m.delete()).catch((err) => {
        console.error(`Could not delete "formed" message for disbanded group ${group.id}:`, err.message);
      });
    }
  } catch (err) {
    console.error(`Could not delete disbanded LFG post ${group.id}:`, err.message);
  }

  activeGroups.delete(groupId);
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
  if (!['category', 'activity', 'size', 'time', 'duration'].includes(field)) return;
  return handleSetupSelect(interaction, field);
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
  handleLfgGroupButtonInteraction,
  // Shared building blocks, reused by lfgForum.js so both versions stay in sync.
  CATEGORY_OPTIONS,
  findCategoryOption,
  getActivityOptions,
  findActivityOption,
  buildSizeOptions,
  findSizeOption,
  buildTimeOptions,
  DURATION_OPTIONS,
  findTimeOption,
  findDurationOption,
  buildGroupEmbed,
  buildGroupRow,
  makeGroupId,
  GROUP_FORMED_CLEANUP_DELAY_MS,
  handleCreatePost,
};
