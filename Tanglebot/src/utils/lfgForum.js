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
} = require('./lfgGroup');

// The Discord Forum Channel where /lfg-forum posts get created as threads.
// Create a Forum Channel in your server, copy its ID, and set this in .env.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

// Separate in-memory state from the regular /lfg command, so both versions
// can run side by side without interfering with each other. Lost on
// restart/redeploy, same caveat as the regular version.
const setupSessions = new Map(); // userId -> { category, activity, size, time }
const activeGroups = new Map(); // groupId -> group state

// ---- Setup UI (accordion, identical shape to /lfg, different customId prefix) ----
// No separate "Create" button. Once Start Time (the last dropdown) is
// filled, this opens the description modal directly.
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { category: null, activity: null, size: null, time: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const rows = [];

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:category')
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
      .setCustomId('lfgforum:select:activity')
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
      .setCustomId('lfgforum:select:size')
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
      .setCustomId('lfgforum:select:time')
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
  return `${summary}Pick a category, an activity, a group size, and a start time. You'll be asked for an optional description once all four are picked.`;
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
    return openDescriptionModal(interaction);
  }

  await interaction.update({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
  });
}

// ---- Once all 4 dropdowns are filled: open the description modal directly ----
async function openDescriptionModal(interaction) {
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

// ---- Modal submit actually creates the forum post ----
async function handleDescriptionModalSubmit(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time) {
    return interaction.reply({
      content: '⚠️ Something went wrong finding your selections — please run /lfg-forum again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const categoryOption = findCategoryOption(session.category);
  const activityOption = findActivityOption(session.category, session.activity);
  const sizeOption = findSizeOption(activityOption, session.size);
  const timeOption = findTimeOption(session.time);
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === activityOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${activityOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
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
  const timeEpoch = resolveTimeEpoch(timeOption.value);
  const sizeCap = parseSizeCap(sizeOption.value);
  const roleLabel = `${categoryOption.label}: ${activityOption.label}`;

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel,
    startLabel: timeOption.label,
    timeEpoch,
    sizeLabel: sizeOption.label,
    sizeCap,
    description,
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
    (t) => t.name.toLowerCase() === activityOption.roleName.toLowerCase()
  );

  // Description (if provided) leads the message content so it shows in the
  // forum's post-list preview snippet, which pulls from the start of the
  // message text. The role ping still fires a notification wherever it sits.
  const startContent = description
    ? `**${description}**\n\n<@&${guildRole.id}>`
    : `<@&${guildRole.id}>`;

  const thread = await forumChannel.threads.create({
    name: buildThreadName(group, 'Open'),
    appliedTags: matchingTag ? [matchingTag.id] : [],
    message: {
      content: startContent,
      embeds: [embed],
      components: [row],
    },
  });

  group.threadId = thread.id;

  // Auto-delete once the chosen start time has passed, unless the group
  // closes/fills/disbands sooner.
  scheduleForumGroupCleanup(interaction.client, group, computeStartTimeCleanupDelay(group.timeEpoch));
  setupSessions.delete(interaction.user.id);

  const threadLink = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
  await interaction.reply({
    content: `✅ Your LFG forum post has been created: [Click here to view it](${threadLink})`,
    flags: MessageFlags.Ephemeral,
  });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 30000);
}

// Builds the full thread title fresh from current group state, so it always
// reflects the live member count (e.g. "Members (2/5)") rather than a
// snapshot taken at creation time.
function buildThreadName(group, statusWord) {
  const capDisplay = group.sizeCap === Infinity ? 'Mass' : String(group.sizeCap);
  // Note: Discord thread/channel names are plain text only — this shows the
  // creator's name for reference, but it can't be a real clickable @mention
  // or trigger a notification the way an in-message mention does.
  return `[${statusWord}] - ${group.roleLabel} - Start: ${group.startLabel} - @${group.creatorTag} - Members (${group.members.size}/${capDisplay})`;
}

function statusWordFor(group) {
  return group.status === 'closed' ? 'Full' : 'Open';
}

async function renameThread(interaction, group) {
  try {
    await interaction.channel.setName(buildThreadName(group, statusWordFor(group)));
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
  await renameThread(interaction, group);

  if (justFilled) {
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    await interaction.channel.send({ content: `${mentions}\n🎉 **Group formed, Good luck!**` });
    scheduleForumGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
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
  const row = buildGroupRow(groupId, group.status, 'lfgforumgroup');
  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: 'You left the group.', flags: MessageFlags.Ephemeral });
  await renameThread(interaction, group);

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
  const row = buildGroupRow(groupId, 'closed', 'lfgforumgroup');
  await interaction.update({ embeds: [embed], components: [row] });
  await renameThread(interaction, group);

  const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({ content: `${mentions}\n🎉 **Group formed, Good luck!**` });

  scheduleForumGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
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
  const row = buildGroupRow(groupId, 'open', 'lfgforumgroup');
  await interaction.update({ embeds: [embed], components: [row] });
  await renameThread(interaction, group);

  const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({ content: `${mentions}\n🔓 **This group has been reopened and is accepting new members again!**` });

  scheduleForumGroupCleanup(interaction.client, group, computeStartTimeCleanupDelay(group.timeEpoch));
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
    const thread = await interaction.client.channels.fetch(group.threadId);
    await thread.delete();
  } catch (err) {
    console.error(`Could not delete disbanded LFG forum post ${group.id}:`, err.message);
  }

  activeGroups.delete(groupId);
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
  if (!['category', 'activity', 'size', 'time'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgForumModalSubmit(interaction) {
  if (interaction.customId === 'lfgforum:desc') {
    return handleDescriptionModalSubmit(interaction);
  }
}

async function handleLfgForumGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfgforumgroup:<action>:<groupId>"
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'leave') return handleLeaveButton(interaction, groupId);
  if (action === 'close') return handleCloseButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
  if (action === 'reopen') return handleReopenButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgForumSelectInteraction,
  handleLfgForumModalSubmit,
  handleLfgForumGroupButtonInteraction,
};
