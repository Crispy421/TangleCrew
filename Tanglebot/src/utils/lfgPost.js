const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const {
  CATEGORY_OPTIONS,
  findCategoryOption,
  getActivityOptions,
  findActivityOption,
  findSizeOption,
  describeSizeOptions,
  parseSizeCap,
  TIME_OFFSET_OPTIONS,
  findTimeOption,
  resolveTimeEpoch,
  buildGroupEmbed,
  buildGroupRow,
  buildQueueOfferRow,
  buildCancelDisbandRow,
  makeGroupId,
  resolveGroupColor,
  isGroupFull,
  describeStartCountdown,
  computeCountdownRefreshDelay,
} = require('./lfgGroup');
const {
  ensureRoleExists,
  lfgRoleName,
  notifyAdminLog,
  scheduleReplyCleanup,
  isAlreadyGoneError,
  replyEphemeral,
  followUpEphemeral,
  isValidColor,
  isValidEmoji,
  emojiMarkup,
} = require('./roleMenu');

// The Discord Forum Channel where /lfg-post posts get created as threads.
// Create a Forum Channel in your server, copy its ID, and set this in .env.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

// The only two ways a post auto-closes: sitting empty this long (nobody left in it — see
// schedulePostGroupCleanup's callers), or an explicit disband finishing its grace period
// (DISBAND_DELAY_MS below). A non-empty group otherwise stays up regardless of its start time.
const EMPTY_GROUP_CLEANUP_DELAY_MS = 30 * 60 * 1000;

// How long the "✅ post created" confirmation stays up before auto-deleting.
const POST_CREATED_MESSAGE_LIFETIME_MS = 30 * 1000;

// How long someone offered a freed spot has to Accept/Decline before it auto-skips to the next
// person in the queue.
const QUEUE_OFFER_TIMEOUT_MS = 1 * 60 * 1000;

// Grace period between clicking Disband and the post actually closing, so a mis-click (or a
// change of heart) can still be caught via Cancel Disband.
const DISBAND_DELAY_MS = 60 * 1000;

// In-memory state, lost on restart/redeploy — fine for same-day LFG posts, but worth knowing if the bot redeploys mid-activity.
const setupSessions = new Map(); // userId -> { category, activity, size, time }
const activeGroups = new Map(); // groupId -> group state

// ---- Setup UI (accordion: Category -> Activity -> Size -> Start Time) ----
// No separate "Create" button.
// Once Start Time (the last dropdown) is filled, this opens the description modal directly.
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { category: null, activity: null, size: null, time: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const rows = [];

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('lfgpost:select:category')
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
      .setCustomId('lfgpost:select:activity')
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
      .setCustomId('lfgpost:select:size')
      .setPlaceholder('3. Choose group size')
      .addOptions(
        activityOption.sizeOptions.map((o) => ({
          value: o.value,
          label: o.label,
          default: session.size === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(sizeSelect));
  }

  if (session.category && session.activity && session.size) {
    const timeSelect = new StringSelectMenuBuilder()
      .setCustomId('lfgpost:select:time')
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
  console.log(`[LFG] /lfg-post invoked by ${interaction.user.username}`);
  if (!FORUM_CHANNEL_ID) {
    console.log('[LFG] /lfg-post aborted: LFG_FORUM_CHANNEL_ID is not set');
    return replyEphemeral(interaction, '⚠️ LFG_FORUM_CHANNEL_ID is not set. Ask an admin to set it in the bot\'s environment variables.');
  }

  const session = getSession(interaction.user.id);
  await interaction.reply({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[LFG] Setup menu sent to ${interaction.user.username}`);
}

async function handleSetupSelect(interaction, field) {
  console.log(`[LFG] Setup select "${field}" = "${interaction.values[0]}" by ${interaction.user.username}`);
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
    const sizeChoices = activityOption.sizeOptions;
    if (sizeChoices.length === 1) {
      // Only one possible size (e.g. Yama, max 2) — no real choice to make, so skip straight past this step instead of making them click it.
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
    .setCustomId('lfgpost:desc')
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

// Reports an issue to admin log, then aborts the setup flow with an ⚠️-prefixed message in place
// of the description modal's reply. Shared by every /lfg-post failure path in the function below
// so the pairing only needs to change in one place.
async function abortWithAdminAlert(interaction, title, adminMessage, userMessage) {
  await notifyAdminLog(interaction.client, title, adminMessage);
  return interaction.update({ content: userMessage, components: [] });
}

// ---- Modal submit actually creates the LFG post ----
async function handleDescriptionModalSubmit(interaction) {
  console.log(`[LFG] Description modal submitted by ${interaction.user.username} — creating post`);
  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time) {
    return interaction.update({
      content: '⚠️ Something went wrong finding your selections — please run /lfg-post again.',
      components: [],
    });
  }

  const categoryOption = findCategoryOption(session.category);
  const activityOption = findActivityOption(session.category, session.activity);
  const sizeOption = findSizeOption(activityOption, session.size);
  const timeOption = findTimeOption(session.time);
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  if (!isValidColor(activityOption.color) || !isValidEmoji(activityOption.emoji)) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Activity Misconfigured',
      `**${activityOption.label}** is missing a valid color and/or emoji in roleMenu.js CATEGORIES — /lfg-post aborted for <@${interaction.user.id}>.`,
      `⚠️ **${activityOption.label}** isn't fully configured yet. Ask an admin to check its color/emoji in roleMenu.js.`
    );
  }

  const guildRole = await ensureRoleExists(interaction.guild, activityOption.label);
  if (!guildRole) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Role Creation Failed',
      `Couldn't find or create **${lfgRoleName(activityOption.label)}** for <@${interaction.user.id}> via /lfg-post. Check the bot's **Manage Roles** permission.`,
      `⚠️ I couldn't find or create the role **${lfgRoleName(activityOption.label)}**. Make sure I have the **Manage Roles** permission.`
    );
  }

  const forumChannel = await interaction.guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Forum Channel Misconfigured',
      `<@${interaction.user.id}> tried /lfg-post but LFG_FORUM_CHANNEL_ID doesn't point to a valid Forum Channel.`,
      '⚠️ LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel. Ask an admin to check the setup.'
    );
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
    color: activityOption.color,
    emoji: activityOption.emoji,
    timeEpoch,
    sizeLabel: sizeOption.label,
    sizeCap,
    description,
    members: new Set([interaction.user.id]),
    status: 'open',
    threadId: null,
    activityMessageId: null,
    cleanupTimeoutId: null,
    countdownTimeoutId: null,
    queue: [], // FIFO of userIds waiting for a freed spot — see advanceQueueOrReopen
    pendingOfferUserId: null,
    pendingOfferTimeoutId: null,
  };
  activeGroups.set(groupId, group);

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId);

  // Auto-apply a matching forum tag if one exists with the same name as the activity (e.g. "Yama" — the base name, not the "LFG-" prefixed role).
  // Entirely optional — skipped if none matches.
  const matchingTag = forumChannel.availableTags?.find(
    (t) => t.name.toLowerCase() === activityOption.label.toLowerCase()
  );

  // The description only shows in the embed (see buildGroupEmbed) — the message content leads
  // with the activity's emoji, then the role ping.
  const startContent = [emojiMarkup(group.emoji), `<@&${guildRole.id}>`].filter(Boolean).join(' ');

  let thread;
  try {
    thread = await forumChannel.threads.create({
      name: buildThreadName(group, 'Open'),
      appliedTags: matchingTag ? [matchingTag.id] : [],
      message: {
        content: startContent,
        embeds: [embed],
        components: [row],
      },
    });
  } catch (err) {
    activeGroups.delete(groupId);
    console.error(`Could not create LFG post for group ${groupId}:`, err.message);
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Post Creation Failed',
      `Failed to create a post for <@${interaction.user.id}> (${roleLabel}): ${err.message}`,
      '⚠️ Something went wrong creating the post. Please try again.'
    );
  }

  group.threadId = thread.id;
  console.log(`[LFG] Post created: group ${groupId}, thread ${thread.id}, by ${interaction.user.username}`);

  // Best-effort — a reaction failing (e.g. the bot losing Add Reactions permission) shouldn't block the post existing.
  try {
    const starterMessage = await thread.fetchStarterMessage();
    await starterMessage.react(group.emoji);
  } catch (err) {
    console.error(`Could not react to LFG post ${groupId} with its activity emoji:`, err.message);
  }

  // No cleanup timer yet — the group starts with a member (the creator), and a non-empty group
  // only closes via an explicit disband, never on its own (see EMPTY_GROUP_CLEANUP_DELAY_MS).
  scheduleCountdownRefresh(interaction.client, group);
  setupSessions.delete(interaction.user.id);

  const threadLink = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
  await interaction.update({
    content: `✅ Your LFG post has been created: [Click here to view it](${threadLink})`,
    components: [],
  });
  scheduleReplyCleanup(interaction, POST_CREATED_MESSAGE_LIFETIME_MS, '/lfg-post confirmation message');
}

// Only the status word and start countdown change here — member count lives in the embed instead
// (updates via message edit, not the channel rename rate limit).
// The creator isn't included here (it's in the embed footer instead) to keep the title short — Discord thread/channel names are capped at 100 characters.
function buildThreadName(group, statusWord) {
  const name = `[${statusWord}] - ${group.roleLabel} - Start: ${describeStartCountdown(group.timeEpoch)}`;
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

function statusWordFor(group) {
  return group.status === 'closed' ? 'Full' : 'Open';
}

// Takes a channel directly (rather than an interaction) so it also works from contexts with no
// interaction to hand — e.g. the queue-offer timeout firing on its own.
async function renameThreadChannel(channel, group) {
  try {
    await channel.setName(buildThreadName(group, statusWordFor(group)));
  } catch (err) {
    console.error(`Could not rename LFG post thread ${group.id}:`, err.message);
  }
}

async function renameThread(interaction, group) {
  return renameThreadChannel(interaction.channel, group);
}

// Re-renders the main group post (embed + Join/Leave/Start Now/Disband row) by editing its
// starter message directly, for flows with no interaction of their own to call .update() on —
// the queue-offer buttons live on a separate activity message (see sendOrEditActivity), and the
// timeout-triggered skip has no interaction at all.
async function updateMainPost(channel, group) {
  try {
    const starterMessage = await channel.fetchStarterMessage();
    await starterMessage.edit({ embeds: [buildGroupEmbed(group)], components: [buildGroupRow(group.id)] });
  } catch (err) {
    if (!isAlreadyGoneError(err)) console.error(`Could not update LFG post ${group.id}:`, err.message);
  }
}

// Re-renames the thread title as the "Start: in X" countdown bucket ticks down (see
// describeStartCountdown/computeCountdownRefreshDelay in lfgGroup.js), so people can see roughly
// when a post starts without opening it. Self-reschedules until the start time passes or the
// group closes/disbands (stopCountdownRefresh), at which point the title stops changing on its own.
function scheduleCountdownRefresh(client, group) {
  if (group.countdownTimeoutId) clearTimeout(group.countdownTimeoutId);
  const delay = computeCountdownRefreshDelay(group.timeEpoch);
  if (delay === null) return;

  group.countdownTimeoutId = setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(group.threadId);
      await thread.setName(buildThreadName(group, statusWordFor(group)));
    } catch (err) {
      if (!isAlreadyGoneError(err)) console.error(`Could not refresh LFG post countdown ${group.id}:`, err.message);
    }
    scheduleCountdownRefresh(client, group);
  }, delay);
}

function stopCountdownRefresh(group) {
  if (group.countdownTimeoutId) {
    clearTimeout(group.countdownTimeoutId);
    group.countdownTimeoutId = null;
  }
}

function mentionAll(group) {
  return [...group.members].map((id) => `<@${id}>`).join(' ');
}

// Join/leave/formed/reopened/queue notices all share one message per group, edited in place
// instead of piling up as a new message every time something happens. components defaults to
// none, which also doubles as clearing a queue offer's Accept/Decline buttons once it's resolved.
async function sendOrEditActivity(channel, group, text, components = []) {
  const embed = new EmbedBuilder().setDescription(text).setColor(resolveGroupColor(group)).setTimestamp();
  const payload = { embeds: [embed], components };

  if (group.activityMessageId) {
    try {
      const existing = await channel.messages.fetch(group.activityMessageId);
      await existing.edit(payload);
      return;
    } catch (err) {
      // Message is gone (e.g. manually deleted) — fall through and send a fresh one.
    }
  }

  const sent = await channel.send(payload);
  group.activityMessageId = sent.id;
}

// Looks up the group for a button interaction, replying "no longer exists" and returning null if
// it's gone — or already disbanding, since nothing else should be actionable during that grace
// period (see handleDisbandButton/handleCancelDisbandButton, which look the group up directly
// instead of through here so they can give a more specific reply).
async function requireGroup(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group || group.status === 'disbanded') {
    await replyEphemeral(interaction, '⚠️ This group no longer exists.');
    return null;
  }
  return group;
}

// Clears any in-flight queue offer without starting a new one — used whenever the group's state
// changes in a way that invalidates it (someone accepted/declined, the group's being torn down,
// or disbanding started), so a stale pendingOfferUserId doesn't linger and misreport who the
// embed's "🎟️ (offer pending)" marker points at.
function clearPendingOffer(group) {
  if (group.pendingOfferTimeoutId) clearTimeout(group.pendingOfferTimeoutId);
  group.pendingOfferTimeoutId = null;
  group.pendingOfferUserId = null;
}

// Common teardown for a group that's going away for good (expired, disbanded, or the underlying
// post vanished) — everything cleanupStaleGroup and schedulePostGroupCleanup's own expiry both need.
function tearDownGroup(group) {
  clearPendingOffer(group);
  stopCountdownRefresh(group);
  activeGroups.delete(group.id);
}

// The underlying post is gone — drop the now-stale in-memory group instead of leaking it forever (every future click on the dead button would otherwise keep hitting the same error).
function cleanupStaleGroup(group) {
  if (group.cleanupTimeoutId) clearTimeout(group.cleanupTimeoutId);
  tearDownGroup(group);
}

// Decides what happens to a spot that just freed up (someone left, declined, or timed out):
// if anyone's queued, hold it for whoever's been waiting longest and start their offer clock
// (QUEUE_OFFER_TIMEOUT_MS); otherwise reopen the group to the public Join button. Always
// re-renders the main post (queue count or status changed) and the activity notice —
// precedingText, if given, is prepended to it so e.g. "X left the group" and "the spot is now
// offered to Y" land as one edit, not two.
async function advanceQueueOrReopen(client, channel, group, precedingText = '') {
  clearPendingOffer(group);

  if (group.queue.length === 0) {
    group.status = 'open';
    await renameThreadChannel(channel, group);
    scheduleCountdownRefresh(client, group);
    refreshCleanupSchedule(client, group);
    await updateMainPost(channel, group);
    const text = [precedingText, '🔓 **This group has space again and is accepting new members!**'].filter(Boolean).join('\n\n');
    await sendOrEditActivity(channel, group, text);
    return;
  }

  const nextUserId = group.queue[0];
  group.pendingOfferUserId = nextUserId;
  await updateMainPost(channel, group);
  // <t:...:R> is a live, auto-localizing Discord timestamp (same trick as the embed's Start
  // field) — it counts down on its own client-side instead of needing a re-edit every second.
  const offerExpiresEpoch = Math.floor((Date.now() + QUEUE_OFFER_TIMEOUT_MS) / 1000);
  const text = [
    precedingText,
    `<@${nextUserId}> 🎟️ **A spot opened up!** Accept <t:${offerExpiresEpoch}:R> or it goes to the next person in the queue.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  await sendOrEditActivity(channel, group, text, [buildQueueOfferRow(group.id)]);
  group.pendingOfferTimeoutId = setTimeout(() => handleQueueOfferTimeout(client, group), QUEUE_OFFER_TIMEOUT_MS);
}

// Nobody responded to the offer in time. Unlike an explicit Decline, being late isn't an opt-out
// — cycle them to the back of the queue (same array, no removal) instead of dropping them, so
// they naturally get offered again once their turn comes back around and there's no separate
// "rejoin" button to build or click. Has no interaction to work with (it fired on its own), so it
// fetches the thread directly.
async function handleQueueOfferTimeout(client, group) {
  if (!activeGroups.has(group.id) || group.pendingOfferUserId === null) return;
  const skippedUserId = group.queue.shift();
  group.queue.push(skippedUserId);
  group.pendingOfferUserId = null;
  group.pendingOfferTimeoutId = null;

  try {
    const channel = await client.channels.fetch(group.threadId);
    await advanceQueueOrReopen(client, channel, group, `⌛ <@${skippedUserId}> didn't respond in time and was moved to the back of the queue.`);
  } catch (err) {
    if (!isAlreadyGoneError(err)) console.error(`Could not advance LFG queue for group ${group.id}:`, err.message);
  }
}

// Updates the group's post with a fresh embed/row, cleaning up and replying if the post is already gone.
// Returns false (the caller should stop) if the update failed because the post no longer exists.
async function updateGroupMessage(interaction, group, embed, row) {
  try {
    await interaction.update({ embeds: [embed], components: [row] });
    return true;
  } catch (err) {
    if (!isAlreadyGoneError(err)) throw err;
    cleanupStaleGroup(group);
    await replyEphemeral(interaction, '⚠️ This group\'s post no longer exists.').catch(() => {});
    return false;
  }
}

function isStaff(interaction) {
  const staffRoleIds = [process.env.COORDINATOR_ROLE_ID, process.env.OWNER_ROLE_ID].filter(Boolean);
  return staffRoleIds.some((roleId) => interaction.member.roles.cache.has(roleId));
}

// Disbanding and starting early are both limited to current members of the group, or Coordinator/Owner staff.
function canManageGroup(interaction, group) {
  return group.members.has(interaction.user.id) || isStaff(interaction);
}

// Cancelling an in-progress disband is a lower bar — anyone with a stake in the group getting
// this far (a member, or someone still queued for a spot) can call it off, not just staff.
function canCancelDisband(interaction, group) {
  return group.members.has(interaction.user.id) || group.queue.includes(interaction.user.id) || isStaff(interaction);
}

async function handleJoinButton(interaction, groupId) {
  console.log(`[LFG] Join clicked: group ${groupId} by ${interaction.user.username}`);
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (group.members.has(interaction.user.id)) {
    return replyEphemeral(interaction, 'You\'re already in this group.');
  }
  const queuePosition = group.queue.indexOf(interaction.user.id);
  if (queuePosition !== -1) {
    return replyEphemeral(interaction, `⏳ You're already in the queue (position ${queuePosition + 1}).`);
  }

  if (group.status === 'closed') {
    group.queue.push(interaction.user.id);
    const embed = buildGroupEmbed(group);
    const row = buildGroupRow(groupId);
    if (!(await updateGroupMessage(interaction, group, embed, row))) return;
    return followUpEphemeral(
      interaction,
      `⏳ This group is full — you're in the queue (position ${group.queue.length}). You'll be pinged here if a spot opens up.`
    );
  }

  group.members.add(interaction.user.id);
  // Not empty anymore either way (whether this fills it or not) — drop any empty-group cleanup countdown.
  cancelScheduledCleanup(group);
  const justFilled = group.sizeCap !== Infinity && group.members.size >= group.sizeCap;
  if (justFilled) {
    group.status = 'closed';
  }

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId);

  if (!(await updateGroupMessage(interaction, group, embed, row))) return;
  await followUpEphemeral(interaction, '✅ You joined the group!');

  if (justFilled) {
    // Full — the title stops needing a countdown until (if ever) someone leaves and reopens it.
    stopCountdownRefresh(group);
    await renameThread(interaction, group);
    await sendOrEditActivity(interaction.channel, group, `${mentionAll(group)}\n🎉 **Group formed, Good luck!**`);
  } else {
    await sendOrEditActivity(interaction.channel, group, `${mentionAll(group)}\n🔔 <@${interaction.user.id}> joined the group!`);
  }
}

async function handleLeaveButton(interaction, groupId) {
  console.log(`[LFG] Leave clicked: group ${groupId} by ${interaction.user.username}`);
  const group = await requireGroup(interaction, groupId);
  if (!group) return;

  if (!group.members.has(interaction.user.id)) {
    const queueIndex = group.queue.indexOf(interaction.user.id);
    if (queueIndex === -1) {
      return replyEphemeral(interaction, 'You\'re not in this group.');
    }
    group.queue.splice(queueIndex, 1);
    const embed = buildGroupEmbed(group);
    const row = buildGroupRow(groupId);
    if (!(await updateGroupMessage(interaction, group, embed, row))) return;
    return followUpEphemeral(interaction, 'You left the queue.');
  }

  group.members.delete(interaction.user.id);
  const wasFull = group.status === 'closed';

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId);
  if (!(await updateGroupMessage(interaction, group, embed, row))) return;
  await followUpEphemeral(interaction, 'You left the group.');

  const leftText = `${mentionAll(group)}\n⚠️ <@${interaction.user.id}> left the group.`;

  if (wasFull) {
    // A full group doesn't just reopen the instant a spot frees — if anyone's queued, they get
    // first refusal (see advanceQueueOrReopen); only reopens to the public Join button once the
    // queue's empty.
    await advanceQueueOrReopen(interaction.client, interaction.channel, group, leftText);
    return;
  }

  if (group.members.size > 0) {
    await sendOrEditActivity(interaction.channel, group, leftText);
  } else {
    // Nobody left in the group — starts the 30-minute empty-group countdown.
    schedulePostGroupCleanup(interaction.client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// Only the person currently holding the offer (front of the queue array, see advanceQueueOrReopen)
// can Accept/Decline it. Clicking Accept/Decline late (after a timeout already cycled it to the
// next person) isn't an error though — handleQueueOfferTimeout already moved them to the back of
// the queue, so this just confirms that rather than showing a dead-end rejection.
function requirePendingOffer(interaction, group) {
  if (group.pendingOfferUserId === interaction.user.id) return true;

  if (group.queue.includes(interaction.user.id)) {
    replyEphemeral(interaction, `⏳ That offer's moved on, but you're still queued (position ${group.queue.indexOf(interaction.user.id) + 1}).`);
  } else {
    replyEphemeral(interaction, '⚠️ This offer isn\'t for you.');
  }
  return false;
}

async function handleQueueAcceptButton(interaction, groupId) {
  console.log(`[LFG] Accept Spot clicked: group ${groupId} by ${interaction.user.username}`);
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!requirePendingOffer(interaction, group)) return;

  await interaction.deferUpdate();

  clearPendingOffer(group);
  group.queue.shift();
  group.members.add(interaction.user.id);
  group.status = group.sizeCap !== Infinity && group.members.size >= group.sizeCap ? 'closed' : 'open';

  await updateMainPost(interaction.channel, group);
  await sendOrEditActivity(interaction.channel, group, `${mentionAll(group)}\n✅ <@${interaction.user.id}> accepted the open spot and joined!`);

  if (group.status === 'open') {
    // Capacity allows for more than this one accept covered — keep serving the queue (or reopen if it's now empty).
    await advanceQueueOrReopen(interaction.client, interaction.channel, group);
  }
}

async function handleQueueDeclineButton(interaction, groupId) {
  console.log(`[LFG] Decline Spot clicked: group ${groupId} by ${interaction.user.username}`);
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!requirePendingOffer(interaction, group)) return;

  await interaction.deferUpdate();

  clearPendingOffer(group);
  const declinedUserId = group.queue.shift();

  await advanceQueueOrReopen(interaction.client, interaction.channel, group, `↪️ <@${declinedUserId}> declined the spot.`);
}

async function handleStartNowButton(interaction, groupId) {
  console.log(`[LFG] Start Now clicked: group ${groupId} by ${interaction.user.username}`);
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!canManageGroup(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can start it early.');
  }
  if (group.timeEpoch * 1000 <= Date.now()) {
    return replyEphemeral(interaction, '⚠️ This group has already started.');
  }

  group.timeEpoch = Math.floor(Date.now() / 1000);
  stopCountdownRefresh(group);

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId);
  if (!(await updateGroupMessage(interaction, group, embed, row))) return;
  await followUpEphemeral(interaction, '✅ Started the group now!');

  await renameThread(interaction, group);
  await sendOrEditActivity(interaction.channel, group, `${mentionAll(group)}\n🚀 **<@${interaction.user.id}> started this group now!**`);
}

// Looks the group up directly rather than via requireGroup, since requireGroup treats an
// already-disbanded group as gone — here that's a distinct, more useful reply ("already
// disbanding, here's how to cancel it") rather than a generic "no longer exists".
async function handleDisbandButton(interaction, groupId) {
  console.log(`[LFG] Disband clicked: group ${groupId} by ${interaction.user.username}`);
  const group = activeGroups.get(groupId);
  if (!group) {
    return replyEphemeral(interaction, '⚠️ This group no longer exists.');
  }
  if (!canManageGroup(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can disband it.');
  }
  if (group.status === 'disbanded') {
    return replyEphemeral(interaction, '⚠️ This group is already disbanding — anyone in it (or its queue), or a Coordinator or higher, can cancel that with **Cancel Disband**.');
  }

  group.status = 'disbanded';
  // Also drops pendingOfferUserId, not just its timer — otherwise a Cancel Disband later would
  // reopen the group with the embed still marking a stale offer as "pending" for no one in particular.
  clearPendingOffer(group);
  stopCountdownRefresh(group);

  // Nothing else is actionable on the main post once disbanding starts — clear its row.
  try {
    await interaction.update({ embeds: [buildGroupEmbed(group)], components: [] });
  } catch (err) {
    if (!isAlreadyGoneError(err)) throw err;
    cleanupStaleGroup(group);
    return;
  }

  await sendOrEditActivity(
    interaction.channel,
    group,
    `${mentionAll(group)}\n🛑 <@${interaction.user.id}> has selected to disband this group. It will close in 1 minute.`,
    [buildCancelDisbandRow(group.id)]
  );

  // Reuses the normal expiry timer (see schedulePostGroupCleanup) rather than a bespoke one — it
  // already does exactly what's needed here: delete the thread and drop the group after a delay.
  schedulePostGroupCleanup(interaction.client, group, DISBAND_DELAY_MS);
}

// Cancelling looks the group up directly (not via requireGroup) for the same reason disbanding
// does — a disbanded group is exactly the case this handles, not one to reject as "gone".
async function handleCancelDisbandButton(interaction, groupId) {
  console.log(`[LFG] Cancel Disband clicked: group ${groupId} by ${interaction.user.username}`);
  const group = activeGroups.get(groupId);
  if (!group) {
    return replyEphemeral(interaction, '⚠️ This group has already closed.');
  }
  if (group.status !== 'disbanded') {
    return replyEphemeral(interaction, '⚠️ This group isn\'t disbanding.');
  }
  if (!canCancelDisband(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, someone in its queue, or a Coordinator or higher, can cancel this.');
  }

  await interaction.deferUpdate();

  group.status = isGroupFull(group) ? 'closed' : 'open';

  await renameThreadChannel(interaction.channel, group);
  if (group.status === 'open') scheduleCountdownRefresh(interaction.client, group);
  refreshCleanupSchedule(interaction.client, group);
  await updateMainPost(interaction.channel, group);
  await sendOrEditActivity(interaction.channel, group, `${mentionAll(group)}\n✅ <@${interaction.user.id}> cancelled the disband — this group is staying open!`);
}

function schedulePostGroupCleanup(client, group, delayMs) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  group.cleanupTimeoutId = setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(group.threadId);
      await thread.delete(); // deletes the entire post, no need to remove messages individually
    } catch (err) {
      if (!isAlreadyGoneError(err)) console.error(`Could not delete expired LFG post ${group.id}:`, err.message);
    }
    tearDownGroup(group);
  }, delayMs);
}

// Cancels a pending cleanup without scheduling a new one — for the moment a group stops being
// empty (a join, an accept, a cancelled disband) and there's nothing that should still be
// counting down.
function cancelScheduledCleanup(group) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
    group.cleanupTimeoutId = null;
  }
}

// A non-empty group has nothing counting down (see EMPTY_GROUP_CLEANUP_DELAY_MS's comment); an
// empty one gets the 30-minute grace period. Used wherever membership just changed and the
// cleanup schedule needs to catch up with it.
function refreshCleanupSchedule(client, group) {
  if (group.members.size > 0) {
    cancelScheduledCleanup(group);
  } else {
    schedulePostGroupCleanup(client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgPostSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfgpost:select:<field>"
  if (!['category', 'activity', 'size', 'time'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgPostModalSubmit(interaction) {
  if (interaction.customId === 'lfgpost:desc') {
    return handleDescriptionModalSubmit(interaction);
  }
}

async function handleLfgPostGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfgpostgroup:<action>:<groupId>"
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'leave') return handleLeaveButton(interaction, groupId);
  if (action === 'queueaccept') return handleQueueAcceptButton(interaction, groupId);
  if (action === 'queuedecline') return handleQueueDeclineButton(interaction, groupId);
  if (action === 'startnow') return handleStartNowButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
  if (action === 'canceldisband') return handleCancelDisbandButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgPostSelectInteraction,
  handleLfgPostModalSubmit,
  handleLfgPostGroupButtonInteraction,
};
