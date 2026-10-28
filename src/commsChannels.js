/* ============ Comms channel catalogue ============
 * One definition per communication gateway. Everything here is data: the panel renders forms from
 * `fields`, the adapters build requests from `config`, and the signature helpers verify inbound
 * webhooks. No channel is claimed to work until a live test succeeds.
 *
 * Status model (per channel):
 *   not_configured → configured_unverified → verified → failed
 * `local` channels (browser) are verified by an in-app round-trip; cloud channels need real
 * credentials and outbound network, which this build cannot supply on its own.
 */

export const CHANNEL_STATUS = {
  not_configured: { label: 'Not configured', chip: '', detail: 'No credentials stored yet.' },
  configured_unverified: { label: 'Configured · unverified', chip: 'warn', detail: 'Credentials saved, never tested against the provider.' },
  verified: { label: 'Send accepted', chip: 'ok', detail: 'A test was accepted; final external delivery is not confirmed.' },
  failed: { label: 'Last test failed', chip: 'bad', detail: 'The provider rejected the test — see the result below.' },
};

export const COMMANDS = [
  { id: '/status', label: 'Workspace status', gate: false },
  { id: '/agents', label: 'Agent list', gate: false },
  { id: '/tasks', label: 'Board summary', gate: false },
  { id: '/approve', label: 'Approve gates (signed buttons)', gate: true },
  { id: '/ask', label: 'Ask the Copilot', gate: false },
  { id: '/copilot', label: 'Drive the Copilot', gate: true },
];

const TOKEN = (key, label, placeholder, help, scope = 'outbound') => ({ key, label, placeholder, help, secret: true, required: true, scope });
const PLAIN = (key, label, placeholder, help, required = true) => ({ key, label, placeholder, help, required });

export const CHANNELS = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: 'send',
    kind: 'cloud',
    transport: 'Bot API (HTTPS, long-poll or webhook)',
    signature: 'X-Telegram-Bot-Api-Secret-Token',
    summary: 'Bot commands, approval prompts and digests in a Telegram chat.',
    view: 'telegram',
    fields: [
      TOKEN('botToken', 'Bot token', '123456:ABC-DEF…', 'From @BotFather → /newbot.'),
      TOKEN('webhookSecret', 'Webhook secret token', 'generated', 'Sent back by Telegram on every update; rejects spoofed calls.', 'inbound'),
      PLAIN('chatId', 'Default chat id', '-1001234567890', 'Where agent reports and Copilot replies are delivered.'),
      PLAIN('publicBase', 'Public HTTPS base URL', 'https://your-host', 'Telegram must be able to reach this host to set the webhook.', false),
    ],
    env: { botToken: 'TELEGRAM_BOT_TOKEN', webhookSecret: 'TELEGRAM_WEBHOOK_SECRET', chatId: 'TELEGRAM_CHAT_ID' },
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: 'chat',
    kind: 'cloud',
    transport: 'Meta WhatsApp Cloud API (Graph v20+)',
    signature: 'X-Hub-Signature-256',
    summary: 'Cloud API messages; outside the 24h window only pre-approved templates.',
    fields: [
      TOKEN('accessToken', 'Permanent access token', 'EAAG…', 'Meta Business → System user token.'),
      PLAIN('phoneNumberId', 'Phone number id', '1029384756…', 'Cloud API → phone numbers.'),
      TOKEN('appSecret', 'Meta app secret', '…', 'Signs webhook bodies; distinct from the access token.', 'inbound'),
      TOKEN('verifyToken', 'Webhook verify token', 'generated', 'Echoed during Meta\'s GET verification handshake.', 'inbound'),
      PLAIN('recipient', 'Default recipient (E.164)', '+234…', 'Where test messages and reports go.'),
      PLAIN('wabaId', 'WABA id', '112233…', 'Required for template management.', false),
    ],
    env: { accessToken: 'WHATSAPP_ACCESS_TOKEN', phoneNumberId: 'WHATSAPP_PHONE_ID', verifyToken: 'WHATSAPP_VERIFY_TOKEN' },
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: 'team',
    kind: 'cloud',
    transport: 'Bot gateway + interactions webhook',
    signature: 'X-Signature-Ed25519 / X-Signature-Timestamp',
    summary: 'Slash commands and channel posts; interactions must be ACKed within 3s.',
    fields: [
      TOKEN('botToken', 'Bot token', 'MTIz…', 'Developer portal → Bot → Reset token.'),
      PLAIN('applicationId', 'Application id', '1234567890', 'Developer portal → General information.', false),
      TOKEN('publicKey', 'Interactions public key', 'hex', 'Verifies every interaction signature.', 'inbound'),
      PLAIN('channelId', 'Default channel id', '9876543210', 'Where agent reports are posted.'),
    ],
    env: { botToken: 'DISCORD_BOT_TOKEN', applicationId: 'DISCORD_APPLICATION_ID', publicKey: 'DISCORD_PUBLIC_KEY' },
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: 'hash',
    kind: 'cloud',
    transport: 'Web API (chat.postMessage) + Events API',
    signature: 'X-Slack-Signature (v0=HMAC-SHA256)',
    summary: 'Channel posts and slash commands; acknowledge within 3s, then reply.',
    fields: [
      TOKEN('botToken', 'Bot token', 'xoxb-…', 'OAuth & permissions → Bot user token.'),
      TOKEN('signingSecret', 'Signing secret', 'hex', 'Basic information → App credentials.', 'inbound'),
      PLAIN('channel', 'Default channel', '#ops', 'Where reports and Copilot replies land.'),
      { key: 'appToken', label: 'App-level token', placeholder: 'xapp-…', help: 'Socket mode only; leave empty for an HTTPS endpoint.', secret: true, required: false },
    ],
    env: { botToken: 'SLACK_BOT_TOKEN', signingSecret: 'SLACK_SIGNING_SECRET', channel: 'SLACK_CHANNEL' },
  },
  {
    id: 'sms',
    label: 'SMS',
    icon: 'phone',
    kind: 'cloud',
    transport: 'Twilio Messages API (OpenSMS not implemented)',
    signature: 'X-Twilio-Signature (HMAC-SHA1 over URL+sorted params)',
    summary: 'Short messages for on-call alerts and approval notifications.',
    fields: [
      PLAIN('baseUrl', 'Twilio base URL', 'https://api.twilio.com', 'Only the official HTTPS Twilio endpoint is permitted.', false),
      { key: 'webhookUrl', label: 'Exact public webhook URL', placeholder: 'https://example.com/api/v1/comms/sms/inbound', help: 'Twilio signs this exact URL, including any query string.', required: true, scope: 'inbound' },
      TOKEN('accountSid', 'Account SID / API key', 'AC…', 'Authenticates outbound sends.'),
      TOKEN('authToken', 'Auth token', '…', 'Also verifies inbound webhook signatures.'),
      PLAIN('from', 'From number', '+15551234567', 'Sender id registered with the provider.'),
      PLAIN('to', 'Default recipient', '+234…', 'On-call number for alerts.'),
    ],
    env: { baseUrl: 'SMS_BASE_URL', accountSid: 'SMS_ACCOUNT_SID', authToken: 'SMS_AUTH_TOKEN', from: 'SMS_FROM' },
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: 'globe',
    kind: 'local',
    transport: 'In-app inbox + Web Push (VAPID)',
    signature: 'none — same-origin session',
    summary: 'The only channel that works without credentials: the app delivers into its own inbox.',
    fields: [
      { key: 'vapidPublic', label: 'VAPID public key', placeholder: 'B…', help: 'Needed for push outside the app tab; in-app inbox works without it.', secret: false, required: false },
      { key: 'quietHours', label: 'Quiet hours', placeholder: '22:00-07:00', help: 'Suppress non-approval pushes.', secret: false, required: false },
    ],
    env: { vapidPublic: 'VAPID_PUBLIC_KEY' },
  },
];

export const CHANNEL_IDS = CHANNELS.map((c) => c.id);
export const getChannel = (id) => CHANNELS.find((c) => c.id === id) || null;

/**
 * Fields a channel needs. `scope: 'inbound'` fields only matter for receiving webhooks, so an
 * outbound-only setup is possible; the panel shows an extra "inbound not verified" badge then.
 */
export const requiredFields = (channel, scope = 'outbound') =>
  (channel?.fields || []).filter((f) => f.required !== false && (scope === 'all' || f.scope !== 'inbound'));

export function missingFields(channelId, config = {}, scope = 'outbound') {
  const channel = getChannel(channelId);
  if (!channel) return [];
  return requiredFields(channel, scope).filter((f) => !String(config[f.key] ?? '').trim()).map((f) => f.key);
}

/** Inbound-only secrets still missing (signature verification cannot run without them). */
export const missingInboundFields = (channelId, config = {}) => {
  const channel = getChannel(channelId);
  if (!channel || channel.kind === 'local') return [];
  return (channel.fields || []).filter((f) => f.scope === 'inbound' && !String(config[f.key] ?? '').trim()).map((f) => f.key);
};

/**
 * Derive the honest status of a channel from its store record. `verified` is only ever set by a
 * successful live test — never by saving a form.
 */
export function channelStatus(channelId, record = {}) {
  const channel = getChannel(channelId);
  if (!channel) return 'not_configured';
  if (missingFields(channelId, record.config).length) return 'not_configured';
  if (record.lastTest && record.lastTest.ok === false) return 'failed';
  if (record.verifiedAt) return 'verified';
  return 'configured_unverified';
}

export const defaultComms = () => ({
  channels: {
    telegram: { enabled: false, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
    whatsapp: { enabled: false, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
    discord: { enabled: false, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
    slack: { enabled: false, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
    sms: { enabled: false, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
    browser: { enabled: true, config: {}, verifiedAt: null, lastTest: null, routing: { copilot: true, agents: [] } },
  },
  commands: Object.fromEntries(COMMANDS.map((c) => [c.id, true])),
  quietHours: '',
  rateLimitPerMin: 20,
  redactLogs: true,
  inbox: [],
  log: [],
});

export const cloneComms = () => JSON.parse(JSON.stringify(defaultComms()));

/** Mask a secret for display: never echo the stored value back. */
export function maskSecret(value) {
  const v = String(value ?? '');
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return `••••${v.slice(-4)}`;
}

export const channelSummary = (channel, record) => ({
  id: channel.id,
  label: channel.label,
  status: channelStatus(channel.id, record),
  canSend: !missingFields(channel.id, record?.config).length,
  inboundReady: !missingInboundFields(channel.id, record?.config).length,
  verifiedAt: record?.verifiedAt || null,
});
