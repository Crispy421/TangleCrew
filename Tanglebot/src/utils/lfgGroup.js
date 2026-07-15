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

// Group size options. Most activities get an auto-generated 2..max range.
// An activity can override this entirely with its own `sizeOptions` array
// (see CoX in roleMenu.js: 2/3/4/5/Mass instead of 2..7).
function buildSizeOptions(activityOption) {
  if (activityOption.sizeOptions) return activityOption.sizeOptions;
  const options = [];
  for (let n = 2; n <= activityOption.maxPlayers; n++) {
    options.push({ value: String(n), label: n === activityOption.maxPlayers ? `${n} Players (Max)` : `${n} Players` });
  }
  return options;
}

function findSizeOption(activityOption, value) {
  return buildSizeOptions(activityOption).find((o) => o.value === value);
}

// Short descriptor shown next to an activity in the picker, e.g. "max 5" or
// "2-5, Mass" for activities with a custom sizeOptions override.
function describeSizeOptions(activityOption) {
  if (!activityOption.sizeOptions) return `max ${activityOption.maxPlayers}`;
  const numeric = activityOption.sizeOptions.filter((o) => /^\d+$/.test(o.value)).map((o) => o.value);
  const special = activityOption.sizeOptions.filter((o) => !/^\d+$/.test(o.value)).map((o) => o.label);
  const rangeText = numeric.length ? (numeric.length > 1 ? `${numeric[0]}-${numeric[numeric.length - 1]}` : numeric[0]) : '';
  return [rangeText, ...special].filter(Boolean).join(', ');
}

// A non-numeric size value (currently just "mass") means uncapped.
function parseSizeCap(value) {
  return /^\d+$/.test(value) ? parseInt(value, 10) : Infinity;
}

// Time is chosen as an offset from right now (in minutes) rather than an
// absolute clock time. This sidesteps timezone ambiguity entirely — "1 Hour
// from now" means the same thing to everyone regardless of where they are.
// The actual epoch is resolved fresh at post-creation time (see
// resolveTimeEpoch), and the posted embed uses Discord's <t:...> timestamp
// format, which auto-localizes to each viewer's own timezone and clock format.
const TIME_OFFSET_OPTIONS = [
  { value: '0', label: 'Now' },
  { value: '15', label: '15 Min' },
  { value: '30', label: '30 Min' },
  { value: '60', label: '1 Hour' },
  { value: '90', label: '1.5 Hours' },
  { value: '120', label: '2 Hours' },
  { value: '180', label: '3 Hours' },
  { value: '240', label: '4 Hours' },
  { value: '300', label: '5 Hours' },
  { value: '360', label: '6 Hours' },
];

function findTimeOption(value) {
  return TIME_OFFSET_OPTIONS.find((o) => o.value === value);
}

// Resolved fresh at the moment the group is actually created, not whenever
// the dropdown was originally rendered — so a slow-to-decide creator still
// gets an accurate "X minutes/hours from now".
function resolveTimeEpoch(offsetMinutesValue) {
  return Math.floor(Date.now() / 1000) + parseInt(offsetMinutesValue, 10) * 60;
}

// How long a full/manually-closed group's post stays up before auto-deleting.
const GROUP_FORMED_CLEANUP_DELAY_MS = 5 * 60 * 1000;

// Every post gets at least this long before the "start time has passed"
// auto-delete can fire — otherwise picking "Now" (or 15 Min) would delete
// the post almost immediately, before anyone has a chance to see or join it.
const MIN_POST_LIFETIME_MS = 15 * 60 * 1000;

function computeStartTimeCleanupDelay(timeEpoch) {
  return Math.max(timeEpoch * 1000 - Date.now(), MIN_POST_LIFETIME_MS);
}

// In-memory state. Both of these are lost on a restart/redeploy — fine for
// same-day LFG posts, but worth knowing if the bot redeploys mid-event.
const setupSessions = new Map(); // userId -> { category, activity, size, time }
const activeGroups = new Map(); // groupId -> group state

// ---- Setup UI (accordion: Category -> Activity -> Size -> Start Time) ----
// No separate "Create" button — the post is created automatically the
// moment the last dropdown (Start Time) is filled.
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { category: null, activity: null, size: null, time: null });
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
          label: `${r.label} (${describeSizeOptions(r)})`,
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
        buildSizeOptions(activityOption).map((o) => ({
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
        TIME_OFFSET_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          default: session.time === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(timeSelect));
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
    parts.push(`**Size:** ${findSizeOption(activityOption, session.size)?.label ?? '?'}`);
  }
  if (session.time) parts.push(`**Start:** ${findTimeOption(session.time)?.label ?? '?'}`);

  const summary = parts.length ? parts.join('  •  ') + '\n\n' : '';
  return `${summary}Pick a category, an activity, a group size, and a start time. Your post is created automatically once all four are picked.`;
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
    session.activity = null;
    session.size = null;
    session.time = null;
  }
  if (field === 'activity') {
    // Size options depend on the chosen activity's max player count.
    session.size = null;
    const activityOption = findActivityOption(session.category, session.activity);
    const sizeChoices = buildSizeOptions(activityOption);
    if (sizeChoices.length === 1) {
      // Only one possible size (e.g. Yama, max 2) — no real choice to make,
      // so skip straight past this step instead of making them click it.
      session.size = sizeChoices[0].value;
    }
  }

  const allFilled = session.category && session.activity && session.size && session.time;
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
// Anyone can Join/Leave/Close/Disband/Reopen — not restricted to the creator.
function buildGroupRow(groupId, status, prefix = 'lfggroup') {
  if (status === 'open') {
    const join = new ButtonBuilder()
      .setCustomId(`${prefix}:join:${groupId}`)
      .setLabel('Join Group')
      .setStyle(ButtonStyle.Success);
    const leave = new ButtonBuilder()
      .setCustomId(`${prefix}:leave:${groupId}`)
      .setLabel('Leave Group')
      .setStyle(ButtonStyle.Secondary);
    const close = new ButtonBuilder()
      .setCustomId(`${prefix}:close:${groupId}`)
      .setLabel('Close Group')
      .setStyle(ButtonStyle.Primary);
    const disband = new ButtonBuilder()
      .setCustomId(`${prefix}:disband:${groupId}`)
      .setLabel('Disband Group')
      .setStyle(ButtonStyle.Danger);
    return new ActionRowBuilder().addComponents(join, leave, close, disband);
  }

  // closed (full or manually closed) — offer to reopen or leave
  const reopen = new ButtonBuilder()
    .setCustomId(`${prefix}:reopen:${groupId}`)
    .setLabel('Reopen Group')
    .setStyle(ButtonStyle.Primary);
  const leave = new ButtonBuilder()
    .setCustomId(`${prefix}:leave:${groupId}`)
    .setLabel('Leave Group')
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(reopen, leave);
}

function buildGroupEmbed(group) {
  const capDisplay = group.sizeCap === Infinity ? 'Mass' : String(group.sizeCap);
  const memberLines = [...group.members].map((id) => `<@${id}>`).join('\n');

  let title = '🔍 Looking For Group';
  let color = 0xc2a24c;
  if (group.status === 'closed') {
    title = '🔒 Looking For Group — Full';
    color = 0x2ecc71;
  }

  const descLines = [
    `**Activity:** ${group.roleLabel}`,
    `**Start:** <t:${group.timeEpoch}:t> (<t:${group.timeEpoch}:R>)`,
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

async function handleCreatePost(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time) {
    return interaction.reply({ content: '⚠️ Please pick all four options first.', flags: MessageFlags.Ephemeral });
  }

  const categoryOption = findCategoryOption(session.category);
  const activityOption = findActivityOption(session.category, session.activity);
  const sizeOption = findSizeOption(activityOption, session.size);
  const timeOption = findTimeOption(session.time);

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === activityOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${activityOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const groupId = makeGroupId();
  const timeEpoch = resolveTimeEpoch(timeOption.value);
  const sizeCap = parseSizeCap(sizeOption.value);

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel: `${categoryOption.label}: ${activityOption.label}`,
    timeEpoch,
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

  // Auto-delete once the chosen start time has passed, unless the group
  // closes/fills/disbands sooner.
  scheduleGroupCleanup(interaction.client, group, computeStartTimeCleanupDelay(group.timeEpoch));
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
  } else {
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    await interaction.channel.send({ content: `${mentions}\n🔔 <@${interaction.user.id}> joined the group!` });
  }
}

async function handleLeaveButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (!group.members.has(interaction.user.id)) {
    return interaction.reply({ content: 'You\'re not in this group.', flags: MessageFlags.Ephemeral });
  }

  group.members.delete(interaction.user.id);
  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, group.status);
  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: 'You left the group.', flags: MessageFlags.Ephemeral });

  if (group.members.size > 0) {
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    await interaction.channel.send({ content: `${mentions}\n⚠️ <@${interaction.user.id}> left the group.` });
  }
}

async function handleCloseButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
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

async function handleReopenButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (group.status !== 'closed') {
    return interaction.reply({ content: '⚠️ This group isn\'t currently closed.', flags: MessageFlags.Ephemeral });
  }

  group.status = 'open';
  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, 'open');
  await interaction.update({ embeds: [embed], components: [row] });

  const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({ content: `${mentions}\n🔓 **This group has been reopened and is accepting new members again!**` });

  // Back to the original expiry rule now that it's open again.
  scheduleGroupCleanup(interaction.client, group, computeStartTimeCleanupDelay(group.timeEpoch));
}

async function handleDisbandButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (group.status === 'disbanded') {
    return interaction.reply({ content: '⚠️ This group is already disbanded.', flags: MessageFlags.Ephemeral });
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
  if (!['category', 'activity', 'size', 'time'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfggroup:<action>:<groupId>"
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'leave') return handleLeaveButton(interaction, groupId);
  if (action === 'close') return handleCloseButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
  if (action === 'reopen') return handleReopenButton(interaction, groupId);
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
  describeSizeOptions,
  parseSizeCap,
  TIME_OFFSET_OPTIONS,
  findTimeOption,
  resolveTimeEpoch,
  buildGroupEmbed,
  buildGroupRow,
  makeGroupId,
  GROUP_FORMED_CLEANUP_DELAY_MS,
  computeStartTimeCleanupDelay,
};
