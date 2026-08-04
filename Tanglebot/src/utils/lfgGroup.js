const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { CATEGORIES, emojiMarkup } = require('./roleMenu');

// Top-level accordion categories for the /lfg-post dropdown, derived from roleMenu.js's CATEGORIES.
const CATEGORY_OPTIONS = Object.entries(CATEGORIES).map(([key, c]) => ({
  key,
  label: c.label,
}));

function findCategoryOption(key) {
  return CATEGORY_OPTIONS.find((o) => o.key === key);
}

function getActivityOptions(categoryKey) {
  return CATEGORIES[categoryKey]?.roles ?? [];
}

function findActivityOption(categoryKey, value) {
  return getActivityOptions(categoryKey).find((r) => r.value === value);
}

function findSizeOption(activityOption, value) {
  return activityOption.sizeOptions.find((o) => o.value === value);
}

// Short descriptor shown next to an activity in the picker, e.g. "2-5" or "2-5, Mass".
function describeSizeOptions(activityOption) {
  const numeric = activityOption.sizeOptions.filter((o) => /^\d+$/.test(o.value)).map((o) => o.value);
  const special = activityOption.sizeOptions.filter((o) => !/^\d+$/.test(o.value)).map((o) => o.label);
  const rangeText = numeric.length ? (numeric.length > 1 ? `${numeric[0]}-${numeric[numeric.length - 1]}` : numeric[0]) : '';
  return [rangeText, ...special].filter(Boolean).join(', ');
}

// A non-numeric size value (currently just "mass") means uncapped.
function parseSizeCap(value) {
  return /^\d+$/.test(value) ? parseInt(value, 10) : Infinity;
}

// An offset from now (in minutes), not an absolute clock time — sidesteps timezone ambiguity
// entirely, since "1 Hour from now" means the same thing to everyone. The epoch is resolved
// fresh at post-creation time (resolveTimeEpoch), and Discord's <t:...> format auto-localizes
// the posted embed to each viewer's own timezone and clock format.
const TIME_OFFSET_OPTIONS = [
  { value: '0', label: 'Now' },
  { value: '15', label: '15 Min' },
  { value: '30', label: '30 Min' },
  { value: '60', label: '1 Hour' },
  { value: '120', label: '2 Hours' },
  { value: '180', label: '3 Hours' },
  { value: '240', label: '4 Hours' },
  { value: '300', label: '5 Hours' },
  { value: '360', label: '6 Hours' },
];

function findTimeOption(value) {
  return TIME_OFFSET_OPTIONS.find((o) => o.value === value);
}

// Bucket edges for the post title's live countdown — hourly beyond an hour out, then 30/15/5
// minutes as it gets close, then "Started". A finer scale than TIME_OFFSET_OPTIONS itself (which
// has no 5-minute pick), but reuses its hourly labels rather than redeclaring them.
const COUNTDOWN_BUCKETS = [
  { minutes: 5, label: '5 Min' },
  ...TIME_OFFSET_OPTIONS.filter((o) => parseInt(o.value, 10) >= 15).map((o) => ({ minutes: parseInt(o.value, 10), label: o.label })),
];

// A live "Start:" label for the post title — stays on the current bucket's label for its whole
// span instead of stepping down the instant a minute passes (see computeCountdownRefreshDelay).
function describeStartCountdown(timeEpoch) {
  const minutesRemaining = Math.ceil((timeEpoch * 1000 - Date.now()) / 60000);
  if (minutesRemaining <= 0) return 'Started';
  const bucket = COUNTDOWN_BUCKETS.find((b) => b.minutes >= minutesRemaining) ?? COUNTDOWN_BUCKETS[COUNTDOWN_BUCKETS.length - 1];
  return `in ${bucket.label}`;
}

// Delay (ms) until describeStartCountdown's label would next change, so the post title is only
// renamed exactly when the text needs updating instead of on a fixed poll interval. Returns null
// once the start time has passed — the label just settles on "Started" and stops refreshing
// (the post itself doesn't auto-close on this account; see EMPTY_GROUP_CLEANUP_DELAY_MS in
// lfgPost.js — a group only closes from sitting empty, or from an explicit disband).
function computeCountdownRefreshDelay(timeEpoch) {
  const minutesRemaining = Math.ceil((timeEpoch * 1000 - Date.now()) / 60000);
  if (minutesRemaining <= 0) return null;
  const bucketIndex = COUNTDOWN_BUCKETS.findIndex((b) => b.minutes >= minutesRemaining);
  const nextChangeAtMinutes = bucketIndex > 0 ? COUNTDOWN_BUCKETS[bucketIndex - 1].minutes : 0;
  return Math.max(timeEpoch * 1000 - nextChangeAtMinutes * 60000 - Date.now(), 1000);
}

// Resolved at creation time (not when the dropdown was rendered), so a slow-to-decide creator
// still gets an accurate "X from now".
function resolveTimeEpoch(offsetMinutesValue) {
  return Math.floor(Date.now() / 1000) + parseInt(offsetMinutesValue, 10) * 60;
}

// True only when every spot is actually occupied — not the same thing as status === 'closed',
// which also covers "a spot freed up but it's being held for the queue" (see advanceQueueOrReopen
// in lfgPost.js). During that reservation window there IS an open spot, just not a public one, so
// it shouldn't read as full.
function isGroupFull(group) {
  return group.sizeCap !== Infinity && group.members.size >= group.sizeCap;
}

// Full shows green regardless of activity color — a status signal, not branding. lfgPost.js's
// notification embed uses the same color so they always match. group.color is validated before
// the group is created (see lfgPost.js), so it's always set here.
function resolveGroupColor(group) {
  return isGroupFull(group) ? 0x2ecc71 : group.color;
}

// ---- Group post building blocks, used by lfgPost.js ----
// status: 'open' | 'closed' (auto-closed once full) | 'disbanded'
// Anyone can Join/Leave. Disband and Start Now are limited to group members or Coordinator/Owner
// staff (see canManageGroup in lfgPost.js).
// A closed (full) group doesn't reopen the instant someone leaves if people are queued — the
// freed spot is offered to whoever's been waiting longest first (see advanceQueueOrReopen).
// customId prefix for these buttons — handleLfgPostGroupButtonInteraction in lfgPost.js parses it back out.
const GROUP_BUTTON_PREFIX = 'lfgpostgroup';

// Lets the group start before its scheduled time (see handleStartNowButton in lfgPost.js) —
// shown regardless of open/closed status, since a full group waiting on its start time still
// benefits from starting early just as much as one still recruiting.
function buildStartNowButton(groupId) {
  return new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:startnow:${groupId}`)
    .setLabel('Start Now')
    .setStyle(ButtonStyle.Primary);
}

// Join always uses this same button regardless of status — handleJoinButton in lfgPost.js decides
// whether that means joining directly or joining the queue (see group.queue), so the label never
// has to change out from under people.
function buildJoinButton(groupId) {
  return new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:join:${groupId}`)
    .setLabel('Join Group')
    .setStyle(ButtonStyle.Success);
}

// Disband is available regardless of open/closed status — a full (or queue-reserved) group is
// still a group someone might need to shut down, not just a recruiting one. The row is otherwise
// identical either way, so unlike buildGroupEmbed this doesn't need the group's status at all.
function buildGroupRow(groupId) {
  const join = buildJoinButton(groupId);
  const startNow = buildStartNowButton(groupId);
  const leave = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:leave:${groupId}`)
    .setLabel('Leave Group')
    .setStyle(ButtonStyle.Secondary);
  const disband = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:disband:${groupId}`)
    .setLabel('Disband Group')
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(join, leave, startNow, disband);
}

// Shown on the group's activity notice when a spot opens up and it's being held for the next
// person in line (see advanceQueueOrReopen in lfgPost.js) — Accept joins them immediately,
// Decline removes them from the queue entirely. Missing the response window isn't a Decline
// though — see handleQueueOfferTimeout in lfgPost.js, which cycles a late person to the back of
// the queue instead of dropping them, so there's no separate "rejoin" button to offer.
function buildQueueOfferRow(groupId) {
  const accept = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:queueaccept:${groupId}`)
    .setLabel('Accept Spot')
    .setStyle(ButtonStyle.Success);
  const decline = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:queuedecline:${groupId}`)
    .setLabel('Decline Spot')
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(accept, decline);
}

// Shown on the "disbanding in 1 minute" notice (see handleDisbandButton in lfgPost.js) — lets
// anyone with standing (a member, someone queued, or staff) call it off before the grace period ends.
function buildCancelDisbandRow(groupId) {
  const cancel = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:canceldisband:${groupId}`)
    .setLabel('Cancel Disband')
    .setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(cancel);
}

function buildGroupEmbed(group) {
  const capDisplay = group.sizeCap === Infinity ? 'Mass' : String(group.sizeCap);
  const memberLines = [...group.members].map((id) => `<@${id}>`).join('\n');

  // group.emoji is validated before the group is created (see lfgPost.js), so it's always set here.
  let title = `${emojiMarkup(group.emoji)} Looking For Group`;
  const color = resolveGroupColor(group);
  if (isGroupFull(group)) {
    title = '🔒 Looking For Group — Full';
  }

  const descLines = [
    `**Activity:** ${group.roleLabel}`,
    `**Start:** <t:${group.timeEpoch}:t> (<t:${group.timeEpoch}:R>)`,
    `**Group Size:** ${group.sizeLabel}`,
  ];
  if (group.description) descLines.push(`**Description:** ${group.description}`);
  descLines.push('', `**Members (${group.members.size}/${capDisplay}):**`, memberLines || '_none yet_');

  // Numbered in join order (group.queue is always FIFO — see advanceQueueOrReopen in lfgPost.js),
  // so position in this list is exactly how many people are ahead of you.
  if (group.queue?.length) {
    const queueLines = group.queue
      .map((id, i) => `${i + 1}. <@${id}>${group.pendingOfferUserId === id ? ' 🎟️ _(offer pending)_' : ''}`)
      .join('\n');
    descLines.push('', `**Queue (${group.queue.length}):**`, queueLines);
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(descLines.join('\n'))
    .setColor(color)
    .setFooter({ text: `Started by ${group.creatorTag}` });
}

function makeGroupId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = {
  // Shared building blocks used by lfgPost.js.
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
  describeStartCountdown,
  computeCountdownRefreshDelay,
  buildGroupEmbed,
  buildGroupRow,
  buildQueueOfferRow,
  buildCancelDisbandRow,
  makeGroupId,
  resolveGroupColor,
  isGroupFull,
};
