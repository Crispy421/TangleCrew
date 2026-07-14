const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const {
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
} = require('./lfgGroup');

// The Discord Forum Channel where /lfg-forum posts get created as threads.
// Create a Forum Channel in your server, copy its ID, and set this in .env.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

// Separate in-memory state from the regular /lfg command, so both versions
// can run side by side without interfering with each other. Lost on
// restart/redeploy, same caveat as the regular version.
const setupSessions = new Map(); // userId -> { role, time, duration, size }
const activeGroups = new Map(); // groupId -> group state

// ---- Setup UI (identical shape to the regular /lfg command, different customId prefix) ----
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { role: null, time: null, duration: null, size: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const roleSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:role')
    .setPlaceholder('1. Choose an activity')
    .addOptions(
      buildRoleOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.role === o.value,
      }))
    );

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:time')
    .setPlaceholder('2. Choose a start time')
    .addOptions(
      buildTimeOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.time === o.value,
      }))
    );

  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:duration')
    .setPlaceholder('3. Choose a duration')
    .addOptions(
      DURATION_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        default: session.duration === o.value,
      }))
    );

  const sizeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:size')
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
      .setCustomId('lfgforum:create')
      .setLabel('Create Forum Post')
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
  return `${summary}Pick an activity, a start time, a duration, and a group size, then hit **Create Forum Post**. You'll be asked for an optional description next.`;
}

async function sendSetupMenu(interaction) {
  if (!FORUM_CHANNEL_ID) {
    return interaction.reply({
      content: '⚠️ LFG_FORUM_CHANNEL_ID is not set. Ask an admin to set it in the bot\'s environment variables.',
      flags: MessageFlags.Ephemeral,
    });
  }

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

// ---- Step 1: "Create Forum Post" button opens a description modal ----
async function handleCreateButton(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.role || !session.time || !session.duration || !session.size) {
    return interaction.reply({ content: '⚠️ Please pick all four options first.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId('lfgforum:desc')
    .setTitle('Add a description');

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder('Add any extra details about this group...');

  modal.addComponents(new ActionRowBuilder().addComponents(descInput));
  await interaction.showModal(modal);
}

// ---- Step 2: modal submit actually creates the forum post ----
async function handleDescriptionModalSubmit(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.role || !session.time || !session.duration || !session.size) {
    return interaction.reply({
      content: '⚠️ Something went wrong finding your selections — please run /lfg-forum again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const roleOption = findRoleOption(session.role);
  const timeOption = findTimeOption(session.time);
  const durationOption = findDurationOption(session.duration);
  const sizeOption = findSizeOption(session.size);
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === roleOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${roleOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const forumChannel = await interaction.guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    return interaction.reply({
      content: '⚠️ LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel. Ask an admin to check the setup.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const groupId = makeGroupId();
  const sizeCap = sizeOption.value === 'any' ? Infinity : parseInt(sizeOption.value, 10);
  const timeEpoch = parseInt(timeOption.value, 10);
  const durationMinutes = parseInt(durationOption.value, 10);
  const endEpoch = timeEpoch + durationMinutes * 60;
  const baseTitle = `${roleOption.label} — Start: ${timeOption.label} — ${durationOption.label} — ${sizeOption.label}`;

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
    description,
    baseTitle,
    sizeCap,
    members: new Set([interaction.user.id]),
    status: 'open',
    threadId: null,
    cleanupTimeoutId: null,
  };
  activeGroups.set(groupId, group);

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, 'open', 'lfgforumgroup');

  // Auto-apply a matching forum tag if one exists with the same name as the role
  // (e.g. a tag literally called "Yama"). Entirely optional — skipped if none matches.
  const matchingTag = forumChannel.availableTags?.find(
    (t) => t.name.toLowerCase() === roleOption.roleName.toLowerCase()
  );

  const thread = await forumChannel.threads.create({
    name: `[Open] ${baseTitle}`,
    appliedTags: matchingTag ? [matchingTag.id] : [],
    message: {
      content: `<@&${guildRole.id}>`,
      embeds: [embed],
      components: [row],
    },
  });

  group.threadId = thread.id;

  // Auto-delete once the event's end time (start + duration) has passed,
  // unless the group closes/fills/disbands sooner.
  scheduleForumGroupCleanup(interaction.client, group, Math.max(group.endEpoch * 1000 - Date.now(), 0));
  setupSessions.delete(interaction.user.id);

  await interaction.reply({ content: `✅ Your LFG forum post has been created: ${thread}`, flags: MessageFlags.Ephemeral });
}

async function renameThread(interaction, group, closed) {
  try {
    await interaction.channel.setName(`${closed ? '[Closed]' : '[Open]'} ${group.baseTitle}`);
  } catch (err) {
    console.error(`Could not rename LFG forum thread ${group.id}:`, err.message);
  }
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
  const row = buildGroupRow(groupId, group.status, 'lfgforumgroup');

  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: '✅ You joined the group!', flags: MessageFlags.Ephemeral });

  if (justFilled) {
    await renameThread(interaction, group, true);
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    await interaction.channel.send({ content: `${mentions}\n🎉 **Group formed, Good luck!**` });
    scheduleForumGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
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
  const row = buildGroupRow(groupId, 'closed', 'lfgforumgroup');
  await interaction.update({ embeds: [embed], components: [row] });
  await renameThread(interaction, group, true);

  const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({ content: `${mentions}\n🎉 **Group formed, Good luck!**` });

  scheduleForumGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
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
  const row = buildGroupRow(groupId, 'disbanded', 'lfgforumgroup');
  await interaction.update({ embeds: [embed], components: [row] });
  await renameThread(interaction, group, true);

  scheduleForumGroupCleanup(interaction.client, group, DISBAND_CLEANUP_DELAY_MS);
}

function scheduleForumGroupCleanup(client, group, delayMs) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  group.cleanupTimeoutId = setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(group.threadId);
      await thread.delete(); // deletes the entire forum post, no need to remove messages individually
    } catch (err) {
      console.error(`Could not delete expired LFG forum post ${group.id}:`, err.message);
    }
    activeGroups.delete(group.id);
  }, delayMs);
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgForumSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfgforum:select:<field>"
  if (!['role', 'time', 'duration', 'size'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgForumButtonInteraction(interaction) {
  if (interaction.customId === 'lfgforum:create') {
    return handleCreateButton(interaction);
  }
}

async function handleLfgForumModalSubmit(interaction) {
  if (interaction.customId === 'lfgforum:desc') {
    return handleDescriptionModalSubmit(interaction);
  }
}

async function handleLfgForumGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfgforumgroup:<action>:<groupId>"
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'close') return handleCloseButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgForumSelectInteraction,
  handleLfgForumButtonInteraction,
  handleLfgForumModalSubmit,
  handleLfgForumGroupButtonInteraction,
};
