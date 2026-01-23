import axios from 'axios';
import cfonts from 'cfonts';
import gradient from 'gradient-string';
import chalk from 'chalk';
import fs from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const config = require('./config.json');
import readline from 'readline';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import ProgressBar from 'progress';
import ora from 'ora';
import { ethers } from 'ethers';
import { TwitterApi } from 'twitter-api-v2';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import Table from 'cli-table3';


const logger = {
  info: (msg, context) => {
    // Handle object context (e.g. { emoji: ... }) by defaulting to 'Info' or extracting string
    const ctx = (typeof context === 'string' ? context : 'Info');
    console.log(chalk.cyan(`[${ctx}] `) + chalk.white(msg));
  },
  success: (msg, context) => {
    const ctx = (typeof context === 'string' ? context : 'Success');
    console.log(chalk.green(`[${ctx}] ${msg} SUCCESS`));
  },
  warn: (msg, context) => {
    const ctx = (typeof context === 'string' ? context : 'Warn');
    console.log(chalk.yellow(`[${ctx}] ${msg}`));
  },
  error: (msg, context) => {
    const ctx = (typeof context === 'string' ? context : 'Error');
    console.log(chalk.red(`[${ctx}] FAILED: ${msg}`));
  },
  debug: (msg, context) => {
    const ctx = (typeof context === 'string' ? context : 'Debug');
    console.log(chalk.blue(`[${ctx}] ${msg}`));
  }
};

function delay(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Anti-ban: Human-like random delay with jitter
function humanDelay(minSeconds, maxSeconds) {
  const baseDelay = Math.random() * (maxSeconds - minSeconds) + minSeconds;
  const jitter = (Math.random() - 0.5) * 2; // -1 to +1 second jitter
  const finalDelay = Math.max(1, baseDelay + jitter);
  return new Promise(resolve => setTimeout(resolve, finalDelay * 1000));
}

// Anti-ban: Activity cooldown tracker
const COOLDOWN_FILE = 'twitter_cooldown.json';

async function loadCooldownData() {
  try {
    const data = await fs.readFile(COOLDOWN_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { accounts: {}, globalLastPost: 0, dailyPostCount: {}, lastResetDate: '' };
  }
}

async function saveCooldownData(data) {
  await fs.writeFile(COOLDOWN_FILE, JSON.stringify(data, null, 2));
}

// Anti-ban: Check if account is in cooldown
async function isAccountInCooldown(accountKey) {
  const data = await loadCooldownData();
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // Reset daily counters if new day
  if (data.lastResetDate !== today) {
    data.dailyPostCount = {};
    data.lastResetDate = today;
    await saveCooldownData(data);
  }

  const accountData = data.accounts[accountKey] || { lastPost: 0, postCount: 0 };
  const dailyPosts = data.dailyPostCount[accountKey] || 0;

  // Anti-ban rules:
  // 1. Minimum 6-12 hours between posts per account (random) - INCREASED FOR SAFETY
  const minCooldownHours = 6 + Math.random() * 6; // 6-12 hours
  const cooldownMs = minCooldownHours * 60 * 60 * 1000;
  const timeSinceLastPost = now - accountData.lastPost;

  // 2. Maximum 1 post per account per day - STRICTER FOR SAFETY
  const maxDailyPosts = 1;

  // 3. Global rate limit: 60 seconds between any posts - INCREASED FOR SAFETY
  const globalCooldown = 60000; // 60 seconds
  const timeSinceGlobalPost = now - data.globalLastPost;

  if (timeSinceGlobalPost < globalCooldown) {
    return { inCooldown: true, reason: 'Global rate limit', waitSeconds: Math.ceil((globalCooldown - timeSinceGlobalPost) / 1000) };
  }

  if (dailyPosts >= maxDailyPosts) {
    return { inCooldown: true, reason: `Daily limit reached (${dailyPosts}/${maxDailyPosts})`, waitSeconds: 0 };
  }

  if (timeSinceLastPost < cooldownMs) {
    const remainingHours = Math.ceil((cooldownMs - timeSinceLastPost) / (60 * 60 * 1000));
    return { inCooldown: true, reason: `Account cooldown (${remainingHours}h remaining)`, waitSeconds: 0 };
  }

  return { inCooldown: false };
}

// Anti-ban: Record successful post
async function recordPost(accountKey) {
  const data = await loadCooldownData();
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  if (data.lastResetDate !== today) {
    data.dailyPostCount = {};
    data.lastResetDate = today;
  }

  data.accounts[accountKey] = data.accounts[accountKey] || { lastPost: 0, postCount: 0 };
  data.accounts[accountKey].lastPost = now;
  data.accounts[accountKey].postCount++;

  data.dailyPostCount[accountKey] = (data.dailyPostCount[accountKey] || 0) + 1;
  data.globalLastPost = now;

  await saveCooldownData(data);
}

// Anti-ban: Shuffle array helper
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Session results tracking
let sessionResults = {
  accounts: [],
  startTime: null,
  endTime: null
};

async function countdown(seconds, message) {
  return new Promise((resolve) => {
    let remaining = seconds;
    process.stdout.write(`${message} ${remaining}s remaining...`);
    const interval = setInterval(() => {
      remaining--;
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      process.stdout.write(`${message} ${remaining}s remaining...`);
      if (remaining <= 0) {
        clearInterval(interval);
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        resolve();
      }
    }, 1000);
  });
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function centerText(text, width) {
  const cleanText = stripAnsi(text);
  const textLength = cleanText.length;
  const totalPadding = Math.max(0, width - textLength);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return `${' '.repeat(leftPadding)}${text}${' '.repeat(rightPadding)}`;
}

function printHeader(title) {
  const width = 80;
  console.log(gradient.morning(`┬${'─'.repeat(width - 2)}┬`));
  console.log(gradient.morning(`│ ${title.padEnd(width - 4)} │`));
  console.log(gradient.morning(`┴${'─'.repeat(width - 2)}┴`));
}

function printInfo(label, value, context) {
  logger.info(`${label.padEnd(15)}: ${chalk.cyan(value)}`, context);
}

function printProfileInfo(address, points, context) {
  printHeader(`Profile Info ${context}`);
  printInfo('Address', address || 'N/A', context);
  printInfo('Total Points', points.toString(), context);
  console.log('\n');
}

const userAgents = config.userAgents;

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getAxiosConfig(proxy, additionalHeaders = {}) {
  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7,fr;q=0.6,ru;q=0.5,zh-CN;q=0.4,zh;q=0.3',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'pragma': 'no-cache',
    'priority': 'u=1, i',
    'referer': `${config.baseUrl}/loyalty`,
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Opera";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': getRandomUserAgent(),
    ...additionalHeaders
  };
  const axiosConfig = {
    headers,
    timeout: 60000
  };
  if (proxy) {
    axiosConfig.httpsAgent = newAgent(proxy);
    axiosConfig.proxy = false;
  }
  return axiosConfig;
}

function newAgent(proxy) {
  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return new HttpsProxyAgent(proxy);
  } else if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
    return new SocksProxyAgent(proxy);
  } else {
    logger.warn(`Unsupported proxy: ${proxy}`, 'System');
    return null;
  }
}

async function requestWithRetry(method, url, payload = null, config = {}, retries = 3, backoff = 2000, context) {
  for (let i = 0; i < retries; i++) {
    try {
      let response;
      if (method.toLowerCase() === 'get') {
        response = await axios.get(url, config);
      } else if (method.toLowerCase() === 'post') {
        response = await axios.post(url, payload, config);
      } else {
        throw new Error(`Method ${method} not supported`);
      }
      return response;
    } catch (error) {
      if (error.response && error.response.status >= 500 && i < retries - 1) {
        logger.warn(`Retrying ${method.toUpperCase()} ${url} (${i + 1}/${retries}) due to server error`, context);
        await delay(backoff / 1000);
        backoff *= 1.5;
        continue;
      }
      if (i < retries - 1) {
        logger.warn(`Retrying ${method.toUpperCase()} ${url} (${i + 1}/${retries})`, context);
        await delay(backoff / 1000);
        backoff *= 1.5;
        continue;
      }
      throw error;
    }
  }
}

async function readAccounts() {
  try {
    const data = await fs.readFile('accounts.json', 'utf-8');
    const accounts = JSON.parse(data);
    if (!Array.isArray(accounts)) {
      throw new Error('accounts.json must be an array of objects');
    }
    logger.info(`Loaded ${accounts.length} account${accounts.length === 1 ? '' : 's'}`, 'System');
    return accounts;
  } catch (error) {
    logger.error(`Failed to read accounts.json: ${error.message}`, 'System');
    return [];
  }
}

async function readProxies(accounts) {
  // Extract proxies from accounts if available
  if (!Array.isArray(accounts)) return [];
  const proxies = accounts.filter(acc => acc.proxy).map(acc => acc.proxy);
  return proxies;
}

function maskAddress(address) {
  return address ? `${address.slice(0, 6)}${'*'.repeat(6)}${address.slice(-6)}` : 'N/A';
}

function deriveWalletAddress(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    return wallet.address;
  } catch (error) {
    logger.error(`Failed to derive address: ${error.message}`);
    return null;
  }
}

async function createSignedPayload(privateKey, address, nonce) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const issuedAt = new Date().toISOString();
    const messageObj = {
      domain: "rewards.arcterminal.ai",
      address: address,
      statement: "Sign in to the app. Powered by Snag Solutions.",
      uri: config.baseUrl,
      version: "1",
      chainId: 42161,
      nonce: nonce,
      issuedAt: issuedAt
    };
    const rawMessage = JSON.stringify(messageObj, null, 0);

    const fullMessage = `rewards.arcterminal.ai wants you to sign in with your Ethereum account:\n` +
      `${address}\n\n` +
      `Sign in to the app. Powered by Snag Solutions.\n\n` +
      `URI: ${config.baseUrl}\n` +
      `Version: 1\n` +
      `Chain ID: 42161\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${issuedAt}`;

    const signedMessage = await wallet.signMessage(fullMessage);

    return {
      message: rawMessage,
      accessToken: signedMessage,
      signature: signedMessage,
      walletConnectorName: "MetaMask",
      walletAddress: address,
      redirect: "false",
      callbackUrl: "/protected",
      chainType: "evm",
      walletProvider: "undefined",
      csrfToken: nonce,
      json: "true"
    };
  } catch (error) {
    throw new Error(`Failed to create signed payload: ${error.message}`);
  }
}

async function fetchNonce(address, proxy, context, refCode = config.referralCode) {
  const url = `${config.baseUrl}/api/auth/csrf`;
  const axiosConfig = getAxiosConfig(proxy, {
    'Content-Type': 'application/json',
    'Cookie': `referral_code=${refCode}`
  });
  const spinner = ora({ text: 'Fetching nonce...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('get', url, null, axiosConfig, 3, 2000, context);
    spinner.stop();
    if (response.data.csrfToken) {
      return { csrfToken: response.data.csrfToken, setCookie: response.headers['set-cookie'] || [] };
    } else {
      throw new Error('Failed to fetch nonce');
    }
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to fetch nonce: ${error.message}`));
    return null;
  }
}

async function executeLogin(privateKey, address, nonce, proxy, context, cookies) {
  const url = `${config.baseUrl}/api/auth/callback/credentials`;
  const payload = await createSignedPayload(privateKey, address, nonce);
  const axiosConfig = getAxiosConfig(proxy, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': cookies.join('; ')
  });
  const spinner = ora({ text: 'Executing login...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('post', url, new URLSearchParams(payload).toString(), axiosConfig, 3, 2000, context);
    spinner.stop();
    const sessionCookies = response.headers['set-cookie'] || [];
    const hasSession = sessionCookies.some(ck => ck.includes('__Secure-next-auth.session-token='));
    if (hasSession) {
      return { success: true, sessionCookies };
    } else {
      throw new Error('Login failed');
    }
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to execute login: ${error.message}`));
    return null;
  }
}

async function retrieveBalance(address, proxy, context, cookies, webId = config.websiteId, orgId = config.organizationId) {
  const url = `${config.baseUrl}/api/loyalty/accounts?limit=100&websiteId=${webId}&organizationId=${orgId}&walletAddress=${address}`;
  const axiosConfig = getAxiosConfig(proxy, { 'Cookie': cookies.join('; ') });
  const spinner = ora({ text: 'Retrieving balance...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('get', url, null, axiosConfig, 3, 2000, context);
    spinner.stop();
    if (response.data.data && response.data.data.length > 0) {
      const amount = response.data.data[0].amount || 0;
      if (amount === 0) {
        logger.warn('Balance retrieved but amount is 0. Possible server delay or account issue.', { emoji: '⚠️ ', context });
      }
      return amount;
    } else {
      logger.warn('No balance data found.', { emoji: '⚠️ ', context });
      return 0;
    }
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to retrieve balance: ${error.message}`));
    return null;
  }
}

async function executeDailyCheckin(address, proxy, context, cookies) {
  const url = `${config.baseUrl}/api/loyalty/rules/${config.dailyCheckInRuleId}/complete`;
  const axiosConfig = getAxiosConfig(proxy, {
    'Content-Type': 'application/json',
    'Content-Length': '2',
    'Cookie': cookies.join('; ')
  });
  axiosConfig.validateStatus = (status) => status >= 200 && status < 500;
  const spinner = ora({ text: 'Executing daily check-in...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('post', url, {}, axiosConfig, 3, 2000, context);
    if (response.status === 400) {
      spinner.warn(chalk.bold.yellowBright(` ${response.data.message || 'Already checked in today'}`));
      return { success: false, message: response.data.message || 'Already claimed' };
    }

    // Attempt to extract streak info if available in response
    let streakMsg = '';
    if (response.data && response.data.streak) {
      streakMsg = ` (Streak: ${response.data.streak}/7)`;
    } else if (response.data && response.data.data && response.data.data.streak) {
      streakMsg = ` (Streak: ${response.data.data.streak}/7)`;
    }

    spinner.succeed(chalk.bold.greenBright(` Check-In Successful!${streakMsg}`));
    return { success: true };
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to execute check-in: ${error.message}`));
    return null;
  }
}

async function getPublicIP(proxy, context) {
  try {
    const axiosConfig = getAxiosConfig(proxy);
    const response = await requestWithRetry('get', 'https://api.ipify.org?format=json', null, axiosConfig, 3, 2000, context);
    return response.data.ip || 'Unknown';
  } catch (error) {
    logger.error(`Failed to get IP: ${error.message}`, context);
    return 'Error retrieving IP';
  }
}

async function getUserSession(proxy, context, cookies) {
  const url = `${config.baseUrl}/api/auth/session`;
  const axiosConfig = getAxiosConfig(proxy, { 'Cookie': cookies.join('; ') });
  const spinner = ora({ text: 'Fetching user session...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('get', url, null, axiosConfig, 3, 2000, context);
    spinner.stop();
    return response.data.user ? response.data.user.id : null;
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to fetch user session: ${error.message}`));
    return null;
  }
}

async function fetchPostRuleId(proxy, context, cookies, webId = config.websiteId, orgId = config.organizationId) {
  const url = `${config.baseUrl}/api/loyalty/rules?limit=50&websiteId=${webId}&organizationId=${orgId}&excludeHidden=true&excludeExpired=true&isActive=true&loyaltyRuleGroupId=${config.postRuleGroupId}&isSpecial=false`;
  const axiosConfig = getAxiosConfig(proxy, { 'Cookie': cookies.join('; ') });
  const spinner = ora({ text: 'Fetching post rule ID...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('get', url, null, axiosConfig, 3, 2000, context);
    spinner.stop();
    const rule = response.data.data.find(r => r.name === 'Post about Arc Terminal');
    return rule ? rule.id : null;
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to fetch post rule ID: ${error.message}`));
    return null;
  }
}

async function completePostTask(ruleId, postUrl, proxy, context, cookies) {
  const url = `${config.baseUrl}/api/loyalty/rules/${ruleId}/complete`;
  const payload = { contentUrl: postUrl };
  const axiosConfig = getAxiosConfig(proxy, {
    'Content-Type': 'application/json',
    'Cookie': cookies.join('; ')
  });
  const spinner = ora({ text: 'Completing post task...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('post', url, payload, axiosConfig, 3, 2000, context);
    spinner.succeed(chalk.bold.greenBright(` Post task completion queued`));
    return response.data;
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to complete post task: ${error.message}`));
    return null;
  }
}

async function checkTaskStatus(userId, proxy, context, cookies, webId = config.websiteId, orgId = config.organizationId) {
  const url = `${config.baseUrl}/api/loyalty/rules/status?websiteId=${webId}&organizationId=${orgId}&userId=${userId}`;
  const axiosConfig = getAxiosConfig(proxy, { 'Cookie': cookies.join('; ') });
  const spinner = ora({ text: 'Checking task status...', spinner: 'dots' }).start();
  try {
    const response = await requestWithRetry('get', url, null, axiosConfig, 3, 2000, context);
    spinner.stop();
    return response.data.data;
  } catch (error) {
    spinner.fail(chalk.bold.redBright(` Failed to check task status: ${error.message}`));
    return null;
  }
}

// Anti-ban: Tweet templates with placeholders for dynamic content
const tweetTemplates = [
  "{greeting} @TheARCTERMINAL {adjective}! {reaction} {hashtag}",
  "{reaction} @TheARCTERMINAL is {adjective}! {ending} {hashtag}",
  "{prefix} @TheARCTERMINAL {suffix}. {ending}",
  "{reaction} {adjective} work by @TheARCTERMINAL! {hashtag}",
  "{greeting}! @TheARCTERMINAL is {adjective}. {hashtag}",
  "{prefix} about @TheARCTERMINAL? {reaction} {hashtag}",
  "{reaction} @TheARCTERMINAL! {suffix} {ending}"
];

const tweetComponents = {
  greeting: ['Hey', 'Hello', 'Hi there', 'Yo', 'Greetings', 'Howdy', 'Sup', 'Hey everyone', 'Hi all'],
  adjective: ['amazing', 'incredible', 'fantastic', 'awesome', 'great', 'solid', 'impressive', 'brilliant', 'outstanding', 'excellent', 'superb', 'remarkable', 'phenomenal', 'exceptional'],
  reaction: ['Love it!', 'So good!', 'Nice work!', 'Fire!', 'This is it!', 'Nailed it!', 'Impressive!', 'Well done!', 'Keep building!', 'LFG!', 'Bullish!', 'WAGMI!', 'Excited!', 'Hyped!'],
  verb: ['checked out', 'explored', 'discovered', 'tried', 'tested', 'used', 'experienced', 'reviewed', 'analyzed', 'researched'],
  noun: ['platform', 'project', 'ecosystem', 'community', 'protocol', 'technology', 'innovation', 'solution', 'product', 'system'],
  prefix: ['Excited', 'Thrilled', 'Happy', 'Pumped', 'Stoked', 'Curious', 'Interested', 'Fascinated', 'Impressed'],
  suffix: ['looking forward to more', 'cant wait for updates', 'following closely', 'staying tuned', 'keeping an eye', 'watching this space', 'here for it'],
  ending: ['The future is bright.', 'More to come!', 'Stay tuned!', 'Watch this space.', 'Big things ahead.', 'Just getting started.', 'This is just the beginning.', ''],
  hashtag: ['#Crypto', '#Web3', '#DeFi', '#Blockchain', '#Trading', '#CryptoCommunity', '#BuildInPublic', '#Web3Community', '#CryptoTwitter', '']
};

const randomEmojis = ['🚀', '💎', '🔥', '⚡', '💪', '✨', '🌟', '💫', '🎯', '📈', '🏆', '👀', '💯', '🙌', '👏', ''];

// Anti-ban: Generate unique tweet with randomization
function generateUniqueTweet() {
  // 60% chance to use template, 40% chance simple format
  if (Math.random() < 0.6) {
    const template = tweetTemplates[Math.floor(Math.random() * tweetTemplates.length)];
    let tweet = template;

    for (const [key, values] of Object.entries(tweetComponents)) {
      const placeholder = `{${key}}`;
      if (tweet.includes(placeholder)) {
        const randomValue = values[Math.floor(Math.random() * values.length)];
        tweet = tweet.replace(placeholder, randomValue);
      }
    }

    // Add random emoji (40% chance)
    if (Math.random() > 0.6) {
      const emoji = randomEmojis[Math.floor(Math.random() * randomEmojis.length)];
      tweet = Math.random() > 0.5 ? `${emoji} ${tweet}` : `${tweet} ${emoji}`;
    }

    // Add random number/timestamp variation (40% chance) for uniqueness
    if (Math.random() < 0.4) {
      const variations = [
        ` [${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}]`,
        ` ${Math.floor(Math.random() * 100)}%`,
        ` #${Math.floor(Math.random() * 1000)}`,
        ` Day ${Math.floor(Math.random() * 365) + 1}`,
        ''
      ];
      tweet += variations[Math.floor(Math.random() * variations.length)];
    }

    return tweet.replace(/\s+/g, ' ').trim();
  }

  // Simple format fallback (reduced set for safety)
  const simpleFormats = [
    `${tweetComponents.reaction[Math.floor(Math.random() * tweetComponents.reaction.length)]} @TheARCTERMINAL`,
    `@TheARCTERMINAL is ${tweetComponents.adjective[Math.floor(Math.random() * tweetComponents.adjective.length)]}`,
    `${tweetComponents.prefix[Math.floor(Math.random() * tweetComponents.prefix.length)]} about @TheARCTERMINAL!`
  ];

  return simpleFormats[Math.floor(Math.random() * simpleFormats.length)];
}

function getRandomTweet() {
  return generateUniqueTweet();
}

async function performAutoPostTwitter(account, proxy, context, cookies, userId, ruleId) {
  const { AppKey: appKey, AppKeySecret: appKeySecret, AccessToken: accessToken, AccessTokenSecret: accessTokenSecret, privateKey } = account;
  if (!appKey || !appKeySecret || !accessToken || !accessTokenSecret) {
    logger.warn('Twitter credentials missing or empty. Skipping auto post Twitter.', context);
    return;
  }

  // Anti-ban: Generate unique account key for cooldown tracking
  const accountKey = privateKey ? privateKey.slice(-10) : `${appKey.slice(-5)}_${accessToken.slice(-5)}`;

  // Anti-ban: Check cooldown before proceeding
  const cooldownCheck = await isAccountInCooldown(accountKey);
  if (cooldownCheck.inCooldown) {
    logger.warn(`Twitter cooldown active: ${cooldownCheck.reason}. Skipping to prevent ban.`, context);
    return;
  }

  // Anti-ban: Random pre-action delay (30-90 seconds) - INCREASED FOR SAFETY
  const preDelay = 30 + Math.random() * 60;
  logger.info(`Anti-ban: Waiting ${Math.floor(preDelay)}s before Twitter action...`, context);
  await humanDelay(preDelay, preDelay + 10);

  logger.info('Starting auto post Twitter process...', context);

  const MAX_RETRIES = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        logger.debug(`Retry attempt ${attempt}/${MAX_RETRIES}...`, context);
        await delay(2);
      }

      const oauth = new OAuth({
        consumer: { key: appKey, secret: appKeySecret },
        signature_method: 'HMAC-SHA1',
        hash_function(base_string, key) {
          return crypto
            .createHmac('sha1', key)
            .update(base_string)
            .digest('base64');
        },
      });

      const oauthCredentials = {
        key: accessToken,
        secret: accessTokenSecret,
      };

      const axiosConfig = proxy ? { httpsAgent: newAgent(proxy), proxy: false } : {};
      if (attempt === 1 && proxy) {
        logger.debug(`Using proxy for Twitter API: ${proxy.substring(0, 30)}...`, context);
      }

      if (attempt === 1) {
        logger.debug('Fetching current user info...', context);
      }
      const userRequestData = {
        url: 'https://api.twitter.com/2/users/me',
        method: 'GET',
      };

      const userHeaders = oauth.toHeader(oauth.authorize(userRequestData, oauthCredentials));
      const userResponse = await Promise.race([
        axios.get(userRequestData.url, {
          headers: { ...userHeaders, 'User-Agent': 'Arc-Terminal-Bot/1.0' },
          timeout: 10000,
          ...axiosConfig
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Twitter API timeout after 10 seconds')), 10000))
      ]);

      const username = userResponse.data.data.username;
      logger.debug(`Twitter username: @${username}`, context);

      const tweetText = getRandomTweet();

      // Anti-ban: Human-like typing simulation delay
      await humanDelay(2, 5);

      if (attempt === 1) {
        logger.debug('Posting tweet...', context);
      }
      const tweetRequestData = {
        url: 'https://api.twitter.com/2/tweets',
        method: 'POST',
      };

      const tweetHeaders = oauth.toHeader(oauth.authorize(tweetRequestData, oauthCredentials));
      const tweetResponse = await Promise.race([
        axios.post(
          tweetRequestData.url,
          { text: tweetText },
          {
            headers: { ...tweetHeaders, 'Content-Type': 'application/json', 'User-Agent': 'Arc-Terminal-Bot/1.0' },
            timeout: 10000,
            ...axiosConfig
          }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tweet posting timeout after 10 seconds')), 10000))
      ]);

      const postId = tweetResponse.data.data.id;
      const postUrl = `https://x.com/${username}/status/${postId}`;

      logger.info(`Posted tweet: ${tweetText}`, context);
      logger.info(`Post URL: ${postUrl}`, context);

      // Anti-ban: Record successful post
      await recordPost(accountKey);

      // Complete task and check status (wrapped to ensure tweet deletion happens)
      // Anti-ban: Random delay before task completion (10-20 seconds)
      try {
        await humanDelay(10, 20);
        await completePostTask(ruleId, postUrl, proxy, context, cookies);
        await humanDelay(8, 15);

        const status = await checkTaskStatus(userId, proxy, context, cookies);
        const postStatus = status.find(s => s.loyaltyRuleId === ruleId);
        if (postStatus && postStatus.status === 'completed') {
          logger.info('Post task completed successfully.', context);
        } else {
          logger.warn('Post task not yet completed or failed.', context);
        }
      } catch (taskError) {
        logger.warn(`Task completion error (will still delete tweet): ${taskError.message}`, context);
      }

      // Always delete tweet regardless of task completion status, with retry logic
      // Anti-ban: Wait before deletion to simulate human behavior (Increased for safety)
      const deleteWait = 60 + Math.random() * 120; // 60-180 seconds
      logger.info(`Anti-ban: Waiting ${Math.floor(deleteWait)}s before tweet deletion...`, context);
      await humanDelay(deleteWait, deleteWait + 5);

      const MAX_DELETE_RETRIES = 3;
      const DELETE_RETRY_DELAY = 8000; // 8 seconds (increased)
      let deleteSuccess = false;
      let lastDeleteError = null;
      for (let deleteAttempt = 1; deleteAttempt <= MAX_DELETE_RETRIES; deleteAttempt++) {
        try {
          // Anti-ban: Small delay between delete retries
          if (deleteAttempt > 1) await humanDelay(5, 10);
          logger.debug(`Deleting tweet... (attempt ${deleteAttempt})`, context);
          const deleteRequestData = {
            url: `https://api.twitter.com/2/tweets/${postId}`,
            method: 'DELETE',
          };
          const deleteHeaders = oauth.toHeader(oauth.authorize(deleteRequestData, oauthCredentials));
          await Promise.race([
            axios.delete(deleteRequestData.url, {
              headers: { ...deleteHeaders, 'User-Agent': 'Arc-Terminal-Bot/1.0' },
              timeout: 15000,
              ...axiosConfig
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Tweet deletion timeout after 10 seconds')), 10000))
          ]);
          logger.info('Deleted the tweet to avoid spam.', context);
          deleteSuccess = true;
          break;
        } catch (deleteError) {
          lastDeleteError = deleteError;
          logger.error(`Failed to delete tweet ${postId} (attempt ${deleteAttempt}): ${deleteError.message}`, context);
          if (deleteAttempt < MAX_DELETE_RETRIES) {
            logger.warn(`Retrying tweet deletion in ${DELETE_RETRY_DELAY / 1000} seconds...`, context);
            await humanDelay(DELETE_RETRY_DELAY / 1000, DELETE_RETRY_DELAY / 1000 + 3);
          }
        }
      }
      if (!deleteSuccess) {
        logger.error(`Failed to delete tweet ${postId} after ${MAX_DELETE_RETRIES} attempts: ${lastDeleteError?.message}`, context);
        logger.warn(`Please manually delete: ${postUrl}`, context);
      }

      return;

    } catch (error) {
      lastError = error;

      // Check if error is proxy/network related
      const isProxyError = error.message.includes('timeout') ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EPROTO' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENETUNREACH' ||
        error.code === 'EHOSTUNREACH' ||
        error.message.includes('socket hang up') ||
        error.message.includes('connect ETIMEDOUT') ||
        error.message.includes('SOCKS');

      if (isProxyError && attempt < MAX_RETRIES) {
        logger.warn(`Proxy/Network error on attempt ${attempt}/${MAX_RETRIES}. Retrying...`, context);
        continue;
      }

      // Non-proxy error - don't retry, just skip
      if (error.response) {
        logger.error(`Twitter API Error (${error.response.status}): ${error.response.data?.detail || error.message}`, context);
      } else if (error.message.includes('timeout')) {
        logger.error(`Twitter API Timeout after ${MAX_RETRIES} retries: ${error.message}`, context);
      } else {
        logger.error(`Failed to post Twitter: ${error.message}`, context);
      }

      logger.info('✅ Continuing without Twitter post (other tasks will work fine)...', context);
      return;
    }
  }
}

async function processAccount(account, index, total, proxy) {
  const context = `Acc ${index + 1}`;
  logger.info(`Starting process for ${maskAddress(deriveWalletAddress(account.privateKey))}`, context);

  const { privateKey } = account;
  const address = deriveWalletAddress(privateKey);

  // Result tracking for this account
  const result = {
    maskedAddress: maskAddress(address),
    success: false,
    checkin: { success: false, message: '' },
    twitter: { success: false, message: '' },
    points: 0,
    error: null
  };

  if (!address) {
    logger.error('Invalid private key', context);
    result.error = 'Invalid private key';
    return result;
  }

  // printHeader(`Account Info ${context}`);
  // printInfo('Wallet Address', maskAddress(address), context);
  const ip = await getPublicIP(proxy, context);
  logger.info(`IP: ${ip}`, context);
  console.log('\n');

  try {
    logger.info('Login...', context);
    const nonceData = await fetchNonce(address, proxy, context);
    if (!nonceData) {
      result.error = 'Failed to fetch nonce';
      return result;
    }

    let currentCookies = [`referral_code=${config.referralCode}`, ...nonceData.setCookie.map(ck => ck.split('; ')[0])];

    const loginResult = await executeLogin(privateKey, address, nonceData.csrfToken, proxy, context, currentCookies);
    if (!loginResult) {
      result.error = 'Login failed';
      return result;
    }

    currentCookies = [...currentCookies, ...loginResult.sessionCookies.map(ck => ck.split('; ')[0])];

    logger.success('Login', context);

    const userId = await getUserSession(proxy, context, currentCookies);

    if (!userId) {
      logger.error('Failed to retrieve userId. Skipping further processes.', context);
      result.error = 'Failed to retrieve userId';
      return result;
    }

    const initialPoints = await retrieveBalance(address, proxy, context, currentCookies);
    result.points = initialPoints || 0;

    const postRuleId = await fetchPostRuleId(proxy, context, currentCookies);
    if (!postRuleId) {
      logger.error('Failed to fetch post rule ID. Skipping auto post.', context);
    }

    console.log('\n');

    logger.info('Checking Daily Claim...', context);
    const checkinResult = await executeDailyCheckin(address, proxy, context, currentCookies);

    if (checkinResult) {
      if (checkinResult.success) {
        result.checkin = { success: true, message: 'Success' };
      } else {
        result.checkin = { success: false, message: checkinResult.message || 'Already claimed' };
      }
    } else {
      result.checkin = { success: false, message: 'Failed' };
    }

    if (globalEnableTwitter && postRuleId) {
      try {
        await performAutoPostTwitter(account, proxy, context, currentCookies, userId, postRuleId);
        result.twitter = { success: true, message: 'Posted & Deleted' };
      } catch (twitterError) {
        result.twitter = { success: false, message: twitterError.message || 'Failed' };
      }
    } else if (!globalEnableTwitter) {
      logger.info('Twitter auto post is disabled. Skipping...', context);
      result.twitter = { success: false, message: 'Disabled' };
    } else {
      result.twitter = { success: false, message: 'No rule ID' };
    }

    if (checkinResult && checkinResult.success) {
      await delay(10);
      const finalPoints = await retrieveBalance(address, proxy, context, currentCookies);
      result.points = finalPoints || 0;
      printProfileInfo(address, finalPoints || 0, context);
    } else {
      await delay(3);
      printProfileInfo(address, initialPoints || 0, context);
    }

    result.success = true;
    logger.success('Processed', context);
    console.log(chalk.cyanBright('________________________________________________________________________________'));
  } catch (error) {
    logger.error(`Error processing account: ${error.message}`, context);
    result.error = error.message;
  }

  return result;
}

let globalUseProxy = true;  // Auto-enable proxy
let globalProxies = [];
let globalEnableTwitter = true;  // Auto-enable twitter

async function initializeConfig(accounts) {
  // Check if proxies are present in accounts
  const accountProxies = Array.isArray(accounts) ? accounts.filter(acc => acc.proxy) : [];

  if (accountProxies.length > 0) {
    globalUseProxy = true;
    logger.info(`Proxy enabled. ${accountProxies.length} accounts have proxy assigned.`, 'System');
  } else {
    globalUseProxy = false;
    // Only log if we expect proxies but found none. 
    // Since we use per-account proxy, we just inform the user.
    logger.info('No proxies found in accounts.json. Proceeding without proxy (or per-account if defined).', 'System');
  }

  // Auto-enable Twitter (no user input needed)
  logger.info('Twitter auto post enabled', 'System');
}

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function runCycle() {
  // Reset session results
  sessionResults = {
    accounts: [],
    startTime: new Date(),
    endTime: null
  };

  const accounts = await readAccounts();
  if (accounts.length === 0) {
    logger.error('No accounts found in accounts.json. Exiting cycle.', { emoji: '❌ ' });
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    let proxy = accounts[i].proxy;
    if (!proxy && globalUseProxy && globalProxies.length > 0) {
      proxy = globalProxies[i % globalProxies.length];
    }
    try {
      const result = await processAccount(accounts[i], i, accounts.length, proxy);
      if (result) {
        sessionResults.accounts.push(result);
      }
    } catch (error) {
      const result = {
        maskedAddress: maskAddress(address),
        success: false,
        checkin: { success: false, message: 'Error' },
        twitter: { success: false, message: 'Error' },
        points: 0,
        error: error.message
      };

      // Add null checks before logging
      const errorMsg = error.message || 'Unknown error';
      logger.error(`Error processing account: ${errorMsg}`, `Acc ${i + 1}`);

      sessionResults.accounts.push(result);
    }
    if (i < accounts.length - 1) {
      console.log('\n\n');
    }
    // Anti-ban: Random delay between accounts (10-30 seconds)
    const accountDelay = 10 + Math.random() * 20;
    logger.info(`Anti-ban: Waiting ${Math.floor(accountDelay)}s before next account...`, 'System');
    await humanDelay(accountDelay, accountDelay + 5);
  }

  sessionResults.endTime = new Date();
}

// Print session summary with all account results
function printSessionSummary() {
  // --- GRAND SUMMARY ---
  console.log('\n' + chalk.bold.cyan('================================================================================'));
  console.log(chalk.bold.cyan(`                          🤖 SIPAL ARC TERMINAL V1.0 🤖`));
  console.log(chalk.bold.cyan('================================================================================'));

  const table = new Table({
    head: ['Account', 'Check-In', 'Twitter', 'Points', 'Status'],
    style: { head: ['cyan'], border: ['grey'] }
  });

  let totalCheckinSuccess = 0;
  let totalTwitterSuccess = 0;
  let totalPoints = 0;

  sessionResults.accounts.forEach((acc, idx) => {
    const checkinStatus = acc.checkin.success
      ? chalk.green('Success')
      : (acc.checkin.message === 'Already claimed'
        ? chalk.yellow('Claimed')
        : chalk.red('Failed'));

    const twitterStatus = acc.twitter.success
      ? chalk.green('Posted')
      : (acc.twitter.message === 'Disabled'
        ? chalk.gray('Disabled')
        : chalk.red('Failed'));

    const overallStatus = acc.success ? chalk.green('Done') : chalk.red('Error');

    if (acc.checkin.success) totalCheckinSuccess++;
    if (acc.twitter.success) totalTwitterSuccess++;
    totalPoints += acc.points || 0;

    table.push([
      `Acc ${idx + 1}`,
      checkinStatus,
      twitterStatus,
      acc.points.toLocaleString(),
      overallStatus
    ]);
  });

  console.log(table.toString());
  console.log(chalk.cyanBright(`📈 TOTAL: ${sessionResults.accounts.length} accounts | ${totalCheckinSuccess} check-in | ${totalTwitterSuccess} tweet | ${totalPoints.toLocaleString()} pts`));
  console.log(chalk.bold.cyan('================================================================================\n'));
}

// Calculate next scheduled run time (7:30 AM)
function getNextScheduledTime(hour = 7, minute = 30) {
  const now = new Date();
  const next = new Date(now);

  next.setHours(hour, minute, 0, 0);

  // If the scheduled time has already passed today, schedule for tomorrow
  if (now >= next) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

// Format time as HH:MM:SS
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

// Display countdown until next scheduled run - ROBUST VERSION
async function displayCountdown(msUntilNextRun, targetTime) {
  const targetTimeStr = targetTime.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  console.log(chalk.bold.cyan(`⏰ Next cycle scheduled at: ${targetTimeStr} WIB`));
  console.log('');

  // Use setTimeout as primary waiting mechanism (more reliable than setInterval)
  // with periodic countdown display updates

  return new Promise((resolve) => {
    const startTime = Date.now();
    const endTime = targetTime.getTime();

    // Safety check: if target time is in the past, resolve immediately
    if (endTime <= startTime) {
      console.log(chalk.green('🚀 Starting new cycle immediately (scheduled time reached)...'));
      console.log('');
      resolve();
      return;
    }

    let intervalId = null;
    let timeoutId = null;

    // Function to clean up and resolve
    const finish = () => {
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      process.stdout.clearLine?.();
      process.stdout.cursorTo?.(0);
      console.log(chalk.green('🚀 Starting new cycle...'));
      console.log('');
      resolve();
    };

    // Primary: Use setTimeout to wait for exact target time
    const waitMs = endTime - Date.now();
    timeoutId = setTimeout(finish, waitMs);

    // Secondary: Display countdown updates every second (visual only)
    const updateCountdown = () => {
      const now = Date.now();
      const remaining = endTime - now;

      if (remaining <= 0) {
        // This shouldn't happen if setTimeout works, but just in case
        finish();
        return;
      }

      try {
        process.stdout.clearLine?.();
        process.stdout.cursorTo?.(0);
        process.stdout.write(chalk.yellow(`⏳ Countdown: ${formatTime(remaining)} remaining...`));
      } catch (e) {
        // Ignore display errors, countdown will still work
      }
    };

    // Initial display
    updateCountdown();

    // Update display every second
    intervalId = setInterval(updateCountdown, 1000);

    // Fallback safety: Log every hour to show bot is still alive
    const hourlyCheck = setInterval(() => {
      const remaining = endTime - Date.now();
      if (remaining > 0) {
        logger.info(`Bot still waiting... ${formatTime(remaining)} until next cycle`, { emoji: '⏰ ' });
      }
    }, 3600000); // Every hour

    // Clean up hourly check when done
    const originalFinish = finish;
    const finishWithCleanup = () => {
      clearInterval(hourlyCheck);
      originalFinish();
    };

    // Update timeout to use cleanup version
    clearTimeout(timeoutId);
    timeoutId = setTimeout(finishWithCleanup, waitMs);
  });
}

async function run() {
  const terminalWidth = process.stdout.columns || 80;
  console.log(chalk.blue(`
                   / \\
                  /   \\
                 |  |  |
                 |  |  |
                  \\  \\
                 |  |  |
                 |  |  |
                  \\   /
                   \\ /
    `));
  console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
  console.log(chalk.bold.cyan('  =====SIPAL ARC TERMINAL V1.0====='));
  console.log('\n');
  console.log('\n');

  // Read accounts and initialize config with them
  const accounts = await readAccounts();
  await initializeConfig(accounts); // Pass accounts explicitly

  // Update globalProxies here to ensure runCycle has access if needed
  globalProxies = await readProxies(accounts);

  while (true) {
    try {
      await runCycle();
      console.log();

      // Print session summary
      printSessionSummary();

      // Calculate time until next 7:30 AM
      const nextRun = getNextScheduledTime(7, 30);
      const msUntilNextRun = nextRun.getTime() - Date.now();

      logger.info(chalk.bold.yellowBright('Cycle completed!'), { emoji: '✅ ' });

      // Display countdown until next run
      await displayCountdown(msUntilNextRun, nextRun);

    } catch (cycleError) {
      logger.error(`Cycle error: ${cycleError.message}. Will retry at next scheduled time.`, 'Cycle');

      // Even on error, wait until next scheduled time
      const nextRun = getNextScheduledTime(7, 30);
      const msUntilNextRun = nextRun.getTime() - Date.now();
      await displayCountdown(msUntilNextRun, nextRun);
    }
  }
}

run().catch(error => logger.error(`Fatal error: ${error.message}`, 'Fatal'));